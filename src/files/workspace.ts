import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ZodIssue } from 'zod';
import type { Document, ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { schemas } from '../domain/schemas.js';
import { parseMarkdownSource, parseYamlSource } from './frontmatter.js';

export type CanonicalFileKind =
  'workspace' | 'project' | 'chat' | 'resource' | 'summary' | 'link' | 'task';

export type WorkspaceArea =
  'root' | 'projects' | 'chats' | 'topics' | 'tasks' | 'inbox' | 'external';

export interface ParsedWorkspaceFile {
  file: string;
  kind: CanonicalFileKind;
  area: WorkspaceArea;
  contentHash: string | null;
  metadata: Record<string, unknown> | null;
  body: string | null;
  document: Document.Parsed<ParsedNode> | null;
  resolvedPaths: ResolvedPath[];
  diagnostics: Diagnostic[];
}

export interface DiscoveredWorkspaceFile {
  file: string;
  kind: CanonicalFileKind;
  area: WorkspaceArea;
}

export interface WorkspaceDiscoveryResult {
  root: string;
  settings: ParsedWorkspaceFile | null;
  files: DiscoveredWorkspaceFile[];
  diagnostics: Diagnostic[];
}

export interface ResolvedPath {
  fieldPath: string;
  storedPath: string;
  resolvedPath: string;
  accessible: boolean;
}

export interface WorkspaceParseResult {
  root: string;
  files: ParsedWorkspaceFile[];
  diagnostics: Diagnostic[];
}

const defaultPaths = {
  projects: 'projects',
  chats: 'chats',
  topics: 'topics',
  tasks: 'tasks',
  inbox: 'inbox',
  external: 'external',
} as const;

export interface WorkspaceAreaPaths {
  root: string;
  projects: string;
  chats: string;
  topics: string;
  tasks: string;
  inbox: string;
  external: string;
}

export async function workspaceAreaPaths(
  root: string,
): Promise<WorkspaceAreaPaths> {
  const workspaceRoot = path.resolve(root);
  const configured: Record<keyof typeof defaultPaths, string> = {
    ...defaultPaths,
  };
  const settingsPath = path.join(workspaceRoot, 'workspace.yml');
  if (await exists(settingsPath)) {
    const settings = await parseWorkspaceFile(
      settingsPath,
      'workspace',
      'root',
      workspaceRoot,
    );
    applyPathOverrides(settings, configured);
  }
  for (const key of Object.keys(configured) as (keyof typeof defaultPaths)[]) {
    const value = configured[key];
    const resolved = path.resolve(workspaceRoot, fromStoredPath(value));
    if (!validStoredPath(value, true) || outsideRoot(workspaceRoot, resolved)) {
      configured[key] = defaultPaths[key];
    }
  }
  return {
    root: workspaceRoot,
    projects: path.resolve(workspaceRoot, fromStoredPath(configured.projects)),
    chats: path.resolve(workspaceRoot, fromStoredPath(configured.chats)),
    topics: path.resolve(workspaceRoot, fromStoredPath(configured.topics)),
    tasks: path.resolve(workspaceRoot, fromStoredPath(configured.tasks)),
    inbox: path.resolve(workspaceRoot, fromStoredPath(configured.inbox)),
    external: path.resolve(workspaceRoot, fromStoredPath(configured.external)),
  };
}

export async function parseWorkspace(
  root: string,
): Promise<WorkspaceParseResult> {
  const discovery = await discoverWorkspaceFiles(root);
  const files: ParsedWorkspaceFile[] = [];
  if (discovery.settings) files.push(discovery.settings);
  for (const candidate of discovery.files) {
    files.push(
      await parseWorkspaceFile(
        candidate.file,
        candidate.kind,
        candidate.area,
        discovery.root,
      ),
    );
  }

  validateRelationships(files);
  return {
    root: discovery.root,
    files,
    diagnostics: [
      ...discovery.diagnostics,
      ...files.flatMap((file) => file.diagnostics),
    ],
  };
}

export async function discoverWorkspaceFiles(
  root: string,
): Promise<WorkspaceDiscoveryResult> {
  const workspaceRoot = path.resolve(root);
  const settingsPath = path.join(workspaceRoot, 'workspace.yml');
  const configuredPaths: Record<keyof typeof defaultPaths, string> = {
    ...defaultPaths,
  };

  let settings: ParsedWorkspaceFile | null = null;
  if (await exists(settingsPath)) {
    settings = await parseWorkspaceFile(
      settingsPath,
      'workspace',
      'root',
      workspaceRoot,
    );
    applyPathOverrides(settings, configuredPaths);
  }

  const candidates = new Map<string, CanonicalFileKind>();
  const areaOf = new Map<string, WorkspaceArea>();
  const directoryDiagnostics: Diagnostic[] = [];
  const rootReadme = path.join(workspaceRoot, 'README.md');
  if (await exists(rootReadme)) {
    candidates.set(rootReadme, 'summary');
    areaOf.set(rootReadme, 'root');
  }

  for (const [area, relativePath] of Object.entries(configuredPaths)) {
    if (!validStoredPath(relativePath, true)) continue;
    const areaRoot = path.resolve(workspaceRoot, fromStoredPath(relativePath));
    if (outsideRoot(workspaceRoot, areaRoot)) continue;
    if (!(await exists(areaRoot))) continue;
    await discover(
      areaRoot,
      areaRoot,
      area as keyof typeof defaultPaths,
      candidates,
      areaOf,
      directoryDiagnostics,
    );
  }

  const files = [...candidates]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, kind]) => ({
      file,
      kind,
      area: areaOf.get(file) ?? 'root',
    }));
  return {
    root: workspaceRoot,
    settings,
    files,
    diagnostics: directoryDiagnostics,
  };
}

async function discover(
  areaRoot: string,
  directory: string,
  area: keyof typeof defaultPaths,
  candidates: Map<string, CanonicalFileKind>,
  areaOf: Map<string, WorkspaceArea>,
  failures: Diagnostic[],
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    failures.push(
      diagnostic(
        directory,
        'directory.unreadable',
        'error',
        `Could not read directory: ${errorMessage(error)}`,
      ),
    );
    return;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await discover(areaRoot, file, area, candidates, areaOf, failures);
      continue;
    }
    const kind = classify(file, area, areaRoot);
    if (kind) {
      candidates.set(file, kind);
      areaOf.set(file, area);
    }
  }
}

function classify(
  file: string,
  area: keyof typeof defaultPaths,
  areaRoot: string,
): CanonicalFileKind | null {
  const extension = path.extname(file);
  if (area === 'projects') {
    if (path.basename(file) === 'project.yml') return 'project';
    if (extension === '.md')
      return path.basename(file) === 'README.md' ? 'summary' : 'resource';
    const relative = path.relative(areaRoot, path.dirname(file));
    if (
      (extension === '.yml' || extension === '.yaml') &&
      relative.split(path.sep).includes('links')
    ) {
      return 'link';
    }
  }
  if (area === 'chats' && extension === '.md') return 'chat';
  if (area === 'topics' && extension === '.md') return 'summary';
  if (area === 'tasks' && extension === '.md') return 'task';
  if ((area === 'inbox' || area === 'external') && extension === '.md')
    return 'resource';
  return null;
}

export async function parseWorkspaceFile(
  file: string,
  kind: CanonicalFileKind,
  area: WorkspaceArea,
  workspaceRoot: string,
): Promise<ParsedWorkspaceFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    return {
      file,
      kind,
      area,
      contentHash: null,
      metadata: null,
      body: null,
      document: null,
      resolvedPaths: [],
      diagnostics: [
        diagnostic(
          file,
          'file.unreadable',
          'error',
          `Could not read file: ${errorMessage(error)}`,
        ),
      ],
    };
  }
  const source = bytes.toString('utf8');

  const sourceResult = file.endsWith('.md')
    ? parseMarkdownSource(file, source)
    : parseYamlSource(file, source);
  const metadata = isRecord(sourceResult.metadata)
    ? sourceResult.metadata
    : null;
  const actualKind =
    kind === 'resource' &&
    metadata &&
    ['root', 'project', 'area', 'topic'].includes(String(metadata.kind))
      ? 'summary'
      : kind;
  const parsed: ParsedWorkspaceFile = {
    file,
    kind: actualKind,
    area,
    contentHash: createHash('sha256').update(bytes).digest('hex'),
    metadata,
    body: sourceResult.body,
    document: sourceResult.document,
    resolvedPaths: [],
    diagnostics: [...sourceResult.diagnostics],
  };

  if (sourceResult.metadata !== null && !metadata) {
    parsed.diagnostics.push(
      diagnostic(
        file,
        'schema.mapping',
        'error',
        'Metadata must contain one top-level mapping.',
      ),
    );
  }
  if (
    metadata === null &&
    !parsed.diagnostics.some((entry) => entry.severity === 'error')
  ) {
    parsed.diagnostics.push(
      diagnostic(
        file,
        'metadata.empty',
        'error',
        'File has no metadata; required fields cannot be validated.',
      ),
    );
  }
  validateMetadata(parsed);
  parsed.resolvedPaths = await validatePaths(parsed, workspaceRoot);
  if (
    actualKind === 'resource' &&
    metadata &&
    !metadata.path &&
    !metadata.url &&
    !(parsed.body ?? '').trim()
  ) {
    parsed.diagnostics.push(
      diagnostic(
        file,
        'resource.content',
        'error',
        'A resource needs a path, URL, or Markdown body.',
      ),
    );
  }
  return parsed;
}

function validateMetadata(parsed: ParsedWorkspaceFile): void {
  if (!parsed.metadata) return;
  const result = schemas[parsed.kind].safeParse(parsed.metadata);
  if (result.success) return;
  parsed.diagnostics.push(
    ...result.error.issues.map((issue) => zodDiagnostic(parsed.file, issue)),
  );
}

async function validatePaths(
  parsed: ParsedWorkspaceFile,
  workspaceRoot: string,
): Promise<ResolvedPath[]> {
  if (!parsed.metadata) return [];
  const resolutions: ResolvedPath[] = [];
  const paths: {
    fieldPath: string;
    value: string;
    workspaceRelative: boolean;
  }[] = [];
  if (parsed.kind === 'workspace' && isRecord(parsed.metadata.paths)) {
    for (const key of Object.keys(defaultPaths)) {
      const value = parsed.metadata.paths[key];
      if (typeof value === 'string')
        paths.push({
          fieldPath: `paths.${key}`,
          value,
          workspaceRelative: true,
        });
    }
  }
  if (
    parsed.kind === 'project' &&
    Array.isArray(parsed.metadata.repositories)
  ) {
    parsed.metadata.repositories.forEach((repository, index) => {
      if (isRecord(repository) && typeof repository.path === 'string') {
        paths.push({
          fieldPath: `repositories.${index}.path`,
          value: repository.path,
          workspaceRelative: false,
        });
      }
    });
  }
  if (parsed.kind === 'resource' && typeof parsed.metadata.path === 'string') {
    paths.push({
      fieldPath: 'path',
      value: parsed.metadata.path,
      workspaceRelative: false,
    });
  }

  for (const candidate of paths) {
    if (!validStoredPath(candidate.value, candidate.workspaceRelative)) {
      parsed.diagnostics.push(
        diagnostic(
          parsed.file,
          'path.invalid',
          'error',
          `Path must use '/', cannot expand '~' or environment variables, and must resolve below the workspace root when required: ${candidate.value}`,
          { fieldPath: candidate.fieldPath },
        ),
      );
      continue;
    }
    const base = candidate.workspaceRelative
      ? workspaceRoot
      : path.dirname(parsed.file);
    const resolved = path.isAbsolute(fromStoredPath(candidate.value))
      ? fromStoredPath(candidate.value)
      : path.resolve(base, fromStoredPath(candidate.value));
    if (candidate.workspaceRelative && outsideRoot(workspaceRoot, resolved)) {
      parsed.diagnostics.push(
        diagnostic(
          parsed.file,
          'path.invalid',
          'error',
          `Path must stay inside the workspace: ${candidate.value}`,
          { fieldPath: candidate.fieldPath },
        ),
      );
      continue;
    }
    const accessible = await exists(resolved);
    resolutions.push({
      fieldPath: candidate.fieldPath,
      storedPath: candidate.value,
      resolvedPath: path.resolve(resolved),
      accessible,
    });
    if (!accessible) {
      parsed.diagnostics.push(
        diagnostic(
          parsed.file,
          'path.inaccessible',
          'warning',
          `Path does not exist or is inaccessible: ${candidate.value}`,
          {
            fieldPath: candidate.fieldPath,
          },
        ),
      );
    }
  }
  return resolutions;
}

export function metadataDeclaredIds(
  kind: CanonicalFileKind,
  metadata: unknown,
): { id: string; fieldPath: string }[] {
  if (!isRecord(metadata)) return [];
  const declared: { id: string; fieldPath: string }[] = [];
  if (typeof metadata.id === 'string')
    declared.push({ id: metadata.id, fieldPath: 'id' });
  if (kind === 'project' && Array.isArray(metadata.repositories)) {
    for (const [index, repository] of metadata.repositories.entries()) {
      if (isRecord(repository) && typeof repository.id === 'string') {
        declared.push({
          id: repository.id,
          fieldPath: `repositories.${index}.id`,
        });
      }
    }
  }
  return declared;
}

function validateRelationships(files: ParsedWorkspaceFile[]): void {
  const declarations = new Map<
    string,
    { owner: ParsedWorkspaceFile; fieldPath: string }[]
  >();
  const declare = (
    id: unknown,
    owner: ParsedWorkspaceFile,
    fieldPath: string,
  ) => {
    if (typeof id !== 'string') return;
    declarations.set(id, [
      ...(declarations.get(id) ?? []),
      { owner, fieldPath },
    ]);
  };
  for (const file of files) {
    for (const { id, fieldPath } of metadataDeclaredIds(
      file.kind,
      file.metadata,
    )) {
      declare(id, file, fieldPath);
    }
  }
  for (const [id, declared] of declarations) {
    if (declared.length < 2) continue;
    for (const { owner, fieldPath } of declared) {
      owner.diagnostics.push(
        diagnostic(
          owner.file,
          'id.duplicate',
          'error',
          `Stable ID '${id}' is declared more than once.`,
          {
            fieldPath,
          },
        ),
      );
    }
  }
  const known = new Set(declarations.keys());
  for (const file of files) {
    for (const [fieldPath, target] of references(file)) {
      if (!known.has(target)) {
        file.diagnostics.push(
          diagnostic(
            file.file,
            'reference.missing',
            'error',
            `'${fieldPath}' references unknown ID '${target}'.`,
            {
              fieldPath,
            },
          ),
        );
      }
    }
  }
}

function* references(file: ParsedWorkspaceFile): Generator<[string, string]> {
  yield* metadataReferences(file.kind, file.metadata);
}

export function* metadataReferences(
  kind: CanonicalFileKind,
  metadata: unknown,
): Generator<[string, string]> {
  if (!isRecord(metadata)) return;
  const fields: string[] = [];
  if (kind === 'project') {
    fields.push('resources', 'links');
    if (Array.isArray(metadata.repositories)) {
      for (const [index, repository] of metadata.repositories.entries()) {
        if (typeof repository === 'string')
          yield [`repositories.${index}`, repository];
      }
    }
  } else if (kind === 'chat' || kind === 'resource') {
    fields.push('projects', 'links');
  } else if (kind === 'task') {
    fields.push('projects');
  } else if (kind === 'summary') {
    fields.push('sources', 'links', 'project');
  } else if (kind === 'link') {
    fields.push('from', 'to');
  }
  for (const field of fields) {
    const value = metadata[field];
    if (typeof value === 'string') yield [field, value];
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        if (typeof item === 'string') yield [`${field}.${index}`, item];
      }
    }
  }
}

function applyPathOverrides(
  settings: ParsedWorkspaceFile,
  configuredPaths: Record<keyof typeof defaultPaths, string>,
): void {
  const paths = settings.metadata?.paths;
  if (!isRecord(paths)) return;
  for (const key of Object.keys(
    defaultPaths,
  ) as (keyof typeof defaultPaths)[]) {
    const value = paths[key];
    if (typeof value === 'string') configuredPaths[key] = value;
  }
}

export function zodDiagnostic(file: string, issue: ZodIssue): Diagnostic {
  return diagnostic(file, `schema.${issue.code}`, 'error', issue.message, {
    fieldPath: issue.path.map(String).join('.') || null,
  });
}

function validStoredPath(value: string, mustBeRelative: boolean): boolean {
  if (value.includes('\\') || value.startsWith('~')) return false;
  if (/\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)|%[^%]+%/.test(value))
    return false;
  if (!mustBeRelative) return true;
  const normalized = path.normalize(fromStoredPath(value));
  return normalized !== '.' && !path.isAbsolute(normalized);
}

function fromStoredPath(value: string): string {
  return value.split('/').join(path.sep);
}

function outsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
