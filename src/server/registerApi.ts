import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { metadataDeclaredIds, parseWorkspace } from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import { hashOf } from '../operations/edit.js';
import { findFileById } from '../operations/lookup.js';
import {
  addProjectRepository,
  registerProject,
  type AddProjectRepositoryInput,
} from '../operations/register.js';
import type { ProjectRegistration } from '../operations/result.js';
import {
  apiFailure,
  badRequest,
  hashRequiredResponse,
  isContentHash,
  type ApiResponse,
} from './api.js';

export interface RepositoryPayload {
  path: string;
  id: string | undefined;
  title: string | undefined;
  remote: string | undefined;
  defaultBranch: string | undefined;
}

export interface ProjectCreatePayloadInput {
  title: string;
  directory: string;
  id: string | undefined;
  repository: RepositoryPayload | undefined;
}

export interface RepositoryAddPayloadInput {
  path: string;
  id: string | undefined;
  title: string | undefined;
  remote: string | undefined;
  defaultBranch: string | undefined;
  expectedHash: string | null;
}

export function parseProjectCreatePayload(payload: unknown):
  | {
      ok: true;
      input: ProjectCreatePayloadInput;
    }
  | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.title !== 'string' || payload.title.trim().length === 0) {
    return {
      ok: false,
      message: "The 'title' field must be a non-empty string.",
    };
  }
  if (
    typeof payload.directory !== 'string' ||
    payload.directory.trim().length === 0
  ) {
    return {
      ok: false,
      message: "The 'directory' field must be a non-empty string.",
    };
  }
  if (payload.id !== undefined && typeof payload.id !== 'string') {
    return { ok: false, message: "The 'id' field must be a string." };
  }
  const repository = repositoryPayloadOf(payload.repository);
  if (payload.repository !== undefined && repository === undefined) {
    return {
      ok: false,
      message:
        "The 'repository' field must be an object with a non-empty 'path' string.",
    };
  }
  return {
    ok: true,
    input: {
      title: payload.title,
      directory: payload.directory,
      id: payload.id,
      repository,
    },
  };
}

export function parseRepositoryAddPayload(payload: unknown):
  | {
      ok: true;
      input: RepositoryAddPayloadInput;
    }
  | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.path !== 'string' || payload.path.trim().length === 0) {
    return {
      ok: false,
      message: "The 'path' field must be a non-empty string.",
    };
  }
  if (payload.id !== undefined && typeof payload.id !== 'string') {
    return { ok: false, message: "The 'id' field must be a string." };
  }
  if (payload.title !== undefined && typeof payload.title !== 'string') {
    return { ok: false, message: "The 'title' field must be a string." };
  }
  if (payload.remote !== undefined && typeof payload.remote !== 'string') {
    return { ok: false, message: "The 'remote' field must be a string." };
  }
  if (
    payload.default_branch !== undefined &&
    typeof payload.default_branch !== 'string'
  ) {
    return {
      ok: false,
      message: "The 'default_branch' field must be a string.",
    };
  }
  return {
    ok: true,
    input: {
      path: payload.path,
      id: payload.id,
      title: payload.title,
      remote: payload.remote,
      defaultBranch: payload.default_branch,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export async function createProjectApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseProjectCreatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const id =
    parsed.input.id ?? (await derivedProjectId(root, parsed.input.title));
  const repository = parsed.input.repository;
  const enriched =
    repository !== undefined &&
    (repository.id !== undefined ||
      repository.title !== undefined ||
      repository.remote !== undefined ||
      repository.defaultBranch !== undefined);
  const repositoryPaths =
    repository === undefined || enriched ? [] : [repository.path];
  const created = await registerProject(root, {
    directory: parsed.input.directory,
    id,
    title: parsed.input.title,
    repositories: repositoryPaths,
  });
  if (!created.success || created.data === null) {
    return registerFailureResponse(root, null, created.diagnostics);
  }
  if (repository === undefined || !enriched) {
    return {
      status: 201,
      body: {
        project: projectBody(root, created.data),
        diagnostics: created.diagnostics,
      },
    };
  }
  const manifestHash = await manifestHashOf(created.data.file);
  if (manifestHash === null) {
    return apiFailure(500, [
      diagnostic(
        created.data.file,
        'file.unreadable',
        'error',
        'The project manifest could not be read after it was created.',
      ),
    ]);
  }
  const added = await addProjectRepository(root, {
    projectId: id,
    path: repository.path,
    id: repository.id,
    title: repository.title,
    remote: repository.remote,
    defaultBranch: repository.defaultBranch,
    expectedHash: manifestHash,
  });
  if (!added.success || added.data === null) {
    return {
      status: 201,
      body: {
        project: projectBody(root, created.data),
        diagnostics: [...created.diagnostics, ...added.diagnostics],
      },
    };
  }
  return {
    status: 201,
    body: {
      project: {
        id: created.data.id,
        title: created.data.title,
        directory: created.data.directory,
        path: canonicalPath(path.resolve(root), created.data.file),
        repositories: added.data.project.repositories,
      },
      diagnostics: [...created.diagnostics, ...added.diagnostics],
    },
  };
}

export async function projectRepositoriesApi(
  root: string,
  projectId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseRepositoryAddPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/projects/:id');
  }
  const input: AddProjectRepositoryInput = {
    projectId,
    path: parsed.input.path,
    id: parsed.input.id,
    title: parsed.input.title,
    remote: parsed.input.remote,
    defaultBranch: parsed.input.defaultBranch,
    expectedHash: parsed.input.expectedHash,
  };
  const result = await addProjectRepository(root, input);
  if (!result.success || result.data === null) {
    return registerFailureResponse(root, projectId, result.diagnostics);
  }
  return {
    status: 200,
    body: {
      project: result.data.project,
      contentHash: result.data.contentHash,
      diagnostics: result.diagnostics,
    },
  };
}

function projectBody(root: string, registration: ProjectRegistration) {
  return {
    id: registration.id,
    title: registration.title,
    directory: registration.directory,
    path: canonicalPath(path.resolve(root), registration.file),
    repositories: registration.repositories,
  };
}

async function derivedProjectId(root: string, title: string): Promise<string> {
  const parsed = await parseWorkspace(root);
  const taken = new Set<string>();
  for (const file of parsed.files) {
    for (const declared of metadataDeclaredIds(file.kind, file.metadata)) {
      taken.add(declared.id);
    }
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = slug.length === 0 ? 'project' : `project_${slug}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function manifestHashOf(file: string): Promise<string | null> {
  try {
    return hashOf(await readFile(file));
  } catch {
    return null;
  }
}

async function currentProjectHash(
  root: string,
  projectId: string,
): Promise<string | null> {
  const parsed = await parseWorkspace(root);
  const project = findFileById(parsed.files, 'project', projectId);
  return project === null ? null : project.contentHash;
}

type RegisterFailureStatus =
  'notFound' | 'conflict' | 'writeFailed' | 'invalid';

const registerFailureStatusCodes: Record<RegisterFailureStatus, number> = {
  notFound: 404,
  conflict: 409,
  writeFailed: 500,
  invalid: 422,
};

function registerFailureStatusOf(
  diagnostics: Diagnostic[],
): RegisterFailureStatus {
  if (diagnostics.some((entry) => entry.code === 'project.missing')) {
    return 'notFound';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'edit.stale_hash' ||
        entry.code === 'write.conflict' ||
        entry.code === 'id.duplicate' ||
        entry.code === 'operation.target_exists',
    )
  ) {
    return 'conflict';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'write.failed' || entry.code === 'file.unreadable',
    )
  ) {
    return 'writeFailed';
  }
  return 'invalid';
}

async function registerFailureResponse(
  root: string,
  projectId: string | null,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const status = registerFailureStatusOf(diagnostics);
  const extra: Record<string, unknown> = {};
  if (status === 'conflict' && projectId !== null) {
    extra.currentHash = await currentProjectHash(root, projectId);
  }
  return apiFailure(registerFailureStatusCodes[status], diagnostics, extra);
}

function repositoryPayloadOf(value: unknown): RepositoryPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.path !== 'string' || value.path.trim().length === 0) {
    return undefined;
  }
  if (value.id !== undefined && typeof value.id !== 'string') return undefined;
  if (value.title !== undefined && typeof value.title !== 'string') {
    return undefined;
  }
  if (value.remote !== undefined && typeof value.remote !== 'string') {
    return undefined;
  }
  if (
    value.default_branch !== undefined &&
    typeof value.default_branch !== 'string'
  ) {
    return undefined;
  }
  return {
    path: value.path,
    id: value.id,
    title: value.title,
    remote: value.remote,
    defaultBranch: value.default_branch,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
