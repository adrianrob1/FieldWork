import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { isSeq } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  parseWorkspace,
  workspaceAreaPaths,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { refreshIndex } from '../index/refresh.js';
import { createCanonicalFile, editCanonicalFile } from './edit.js';
import {
  findFileById,
  hasError,
  invalidDirectoryDiagnostic,
  invalidStableIdDiagnostic,
  missingObjectDiagnostic,
} from './lookup.js';
import {
  operationFailed,
  operationOk,
  type OperationResult,
  type ProjectRegistration,
  type RegisteredRepository,
} from './result.js';

export interface RegisterProjectInput {
  directory: string;
  id: string;
  title: string;
  repositories: string[];
}

export interface ProjectManifestRequest {
  id: string;
  title: string;
  directory: string;
  repositoryPaths: string[];
}

export interface ProjectManifestOutcome {
  registration: ProjectRegistration | null;
  diagnostics: Diagnostic[];
}

export async function registerProject(
  root: string,
  input: RegisterProjectInput,
): Promise<OperationResult<ProjectRegistration>> {
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Project ID', input.id),
    invalidDirectoryDiagnostic(root, input.directory),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const created = await createProjectManifest(root, {
    id: input.id,
    title: input.title,
    directory: input.directory,
    repositoryPaths: input.repositories,
  });
  if (created.registration === null) {
    return operationFailed(created.diagnostics);
  }
  const diagnostics = await refreshDiagnostics(root);
  return operationOk(
    true,
    [created.registration.file],
    created.registration,
    diagnostics,
  );
}

export async function createProjectManifest(
  root: string,
  request: ProjectManifestRequest,
): Promise<ProjectManifestOutcome> {
  const areas = await workspaceAreaPaths(root);
  const projectDirectory = path.join(areas.projects, request.directory);
  const file = path.join(projectDirectory, 'project.yml');
  const repositories = buildRepositories(root, projectDirectory, request);

  const metadata: Record<string, unknown> = {
    id: request.id,
    title: request.title,
  };
  if (repositories.length > 0) metadata.repositories = repositories;

  await mkdir(projectDirectory, { recursive: true });
  const created = await createCanonicalFile({
    file,
    kind: 'project',
    root,
    metadata,
  });
  if (!created.changed || hasError(created.diagnostics)) {
    return { registration: null, diagnostics: created.diagnostics };
  }
  return {
    registration: {
      id: request.id,
      title: request.title,
      directory: request.directory,
      file,
      repositories,
    },
    diagnostics: created.diagnostics,
  };
}

export function deriveRepositoryIds(paths: string[]): string[] {
  const taken = new Set<string>();
  return paths.map((input) => {
    const id = derivedRepositoryId(input, taken);
    taken.add(id);
    return id;
  });
}

export interface AddProjectRepositoryInput {
  projectId: string;
  path: string;
  id?: string | undefined;
  title?: string | undefined;
  remote?: string | undefined;
  defaultBranch?: string | undefined;
  expectedHash: string;
}

export interface StoredRepository {
  id: string;
  path: string;
  title?: string;
  remote?: string;
  default_branch?: string;
}

export interface ProjectRepositoryAddition {
  project: {
    id: string;
    title: string;
    repositories: (string | StoredRepository)[];
  };
  contentHash: string;
}

export async function addProjectRepository(
  root: string,
  input: AddProjectRepositoryInput,
): Promise<OperationResult<ProjectRepositoryAddition>> {
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Project ID', input.projectId),
    input.id === undefined
      ? null
      : invalidStableIdDiagnostic(root, 'Repository ID', input.id),
    invalidRepositoryPathDiagnostic(root, input.path),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const parsed = await parseWorkspace(root);
  const project = findFileById(parsed.files, 'project', input.projectId);
  if (project === null || project.metadata === null) {
    return operationFailed([
      missingObjectDiagnostic(root, 'project', input.projectId),
    ]);
  }
  const expectedHash = input.expectedHash.toLowerCase();
  if (project.contentHash === null || project.contentHash !== expectedHash) {
    return operationFailed([staleHashDiagnostic(project.file)]);
  }
  const existing = project.metadata.repositories;
  if (existing !== undefined && existing !== null && !Array.isArray(existing)) {
    return operationFailed([repositoriesShapeDiagnostic(project.file)]);
  }

  const storedPath = storedRepositoryPath(
    root,
    path.dirname(project.file),
    input.path,
  );
  const repositoryId =
    input.id ??
    derivedRepositoryId(input.path, knownRepositoryIds(parsed.files));
  const entry: Record<string, unknown> = { id: repositoryId, path: storedPath };
  if (input.title !== undefined) entry.title = input.title;
  if (input.remote !== undefined) entry.remote = input.remote;
  if (input.defaultBranch !== undefined) {
    entry.default_branch = input.defaultBranch;
  }

  const edited = await editCanonicalFile({
    file: project.file,
    kind: 'project',
    root,
    expectedHash,
    change: (document) => {
      const list = document.get('repositories', true);
      if (list === undefined || list === null) {
        document.set('repositories', document.createNode([entry]));
        return true;
      }
      if (!isSeq(list)) return false;
      list.add(document.createNode(entry));
      return true;
    },
  });
  if (edited.diagnostics.some((item) => item.severity === 'error')) {
    return operationFailed(edited.diagnostics);
  }
  if (!edited.changed) {
    return operationFailed([repositoriesShapeDiagnostic(project.file)]);
  }
  const refreshed = await refreshDiagnostics(root);
  const current = await parseWorkspace(root);
  const manifest = findFileById(current.files, 'project', input.projectId);
  if (
    manifest === null ||
    manifest.metadata === null ||
    manifest.contentHash === null
  ) {
    return operationFailed(
      [
        ...edited.diagnostics,
        ...refreshed,
        missingObjectDiagnostic(root, 'project', input.projectId),
      ],
      [project.file],
    );
  }
  return operationOk(
    true,
    [project.file],
    {
      project: {
        id: input.projectId,
        title:
          typeof manifest.metadata.title === 'string'
            ? manifest.metadata.title
            : '',
        repositories: storedRepositories(manifest.metadata),
      },
      contentHash: manifest.contentHash,
    },
    [...edited.diagnostics, ...refreshed],
  );
}

export async function refreshDiagnostics(root: string): Promise<Diagnostic[]> {
  try {
    const refreshed = await refreshIndex(root);
    return refreshed.diagnostics.map((entry) => ({
      ...entry,
      severity: 'warning',
    }));
  } catch (error) {
    return [
      diagnostic(
        root,
        'index.refresh_failed',
        'warning',
        `The index refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ];
  }
}

function buildRepositories(
  root: string,
  projectDirectory: string,
  request: ProjectManifestRequest,
): RegisteredRepository[] {
  const ids = deriveRepositoryIds(request.repositoryPaths);
  return request.repositoryPaths.map((input, index) => ({
    id: ids[index] ?? `resource_repo_${index + 1}`,
    path: storedRepositoryPath(root, projectDirectory, input),
  }));
}

function slugOfRepositoryPath(input: string): string {
  const segments = input.split(/[\\/]+/).filter((part) => part.length > 0);
  const last = segments[segments.length - 1] ?? '';
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug.length > 0) return slug;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function storedRepositoryPath(
  root: string,
  projectDirectory: string,
  input: string,
): string {
  const resolved = path.isAbsolute(input)
    ? path.normalize(input)
    : path.resolve(root, input.split('/').join(path.sep));
  const relative = path.relative(projectDirectory, resolved);
  const stored = outsideRoot(root, resolved)
    ? resolved
    : relative === ''
      ? '.'
      : relative;
  return stored.split(path.sep).join('/');
}

function outsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function derivedRepositoryId(
  repositoryPath: string,
  taken: ReadonlySet<string>,
): string {
  const base = slugOfRepositoryPath(repositoryPath);
  let candidate = `resource_repo_${base}`;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `resource_repo_${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function knownRepositoryIds(files: ParsedWorkspaceFile[]): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (file.kind !== 'project') continue;
    const entries = Array.isArray(file.metadata?.repositories)
      ? file.metadata.repositories
      : [];
    for (const entry of entries) {
      if (typeof entry === 'string') {
        ids.add(entry);
        continue;
      }
      if (isRecord(entry) && typeof entry.id === 'string') {
        ids.add(entry.id);
      }
    }
  }
  return ids;
}

function storedRepositories(
  metadata: Record<string, unknown>,
): (string | StoredRepository)[] {
  const entries = Array.isArray(metadata.repositories)
    ? metadata.repositories
    : [];
  const stored: (string | StoredRepository)[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      stored.push(entry);
      continue;
    }
    if (isRecord(entry)) stored.push(storedRepositoryOf(entry));
  }
  return stored;
}

function storedRepositoryOf(entry: Record<string, unknown>): StoredRepository {
  const stored: StoredRepository = {
    id: typeof entry.id === 'string' ? entry.id : '',
    path: typeof entry.path === 'string' ? entry.path : '',
  };
  if (typeof entry.title === 'string') stored.title = entry.title;
  if (typeof entry.remote === 'string') stored.remote = entry.remote;
  if (typeof entry.default_branch === 'string') {
    stored.default_branch = entry.default_branch;
  }
  return stored;
}

function invalidRepositoryPathDiagnostic(
  root: string,
  repositoryPath: unknown,
): Diagnostic | null {
  if (typeof repositoryPath === 'string' && repositoryPath.trim().length > 0) {
    return null;
  }
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    `Repository path '${String(repositoryPath)}' must be a non-empty string.`,
  );
}

function staleHashDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'edit.stale_hash',
    'error',
    'The project manifest changed since it was loaded; nothing was written.',
  );
}

function repositoriesShapeDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'operation.target_invalid',
    'error',
    "The project 'repositories' field must be a list of repository entries.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
