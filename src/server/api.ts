import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { MessageMetadata } from '../domain/transcript.js';
import {
  parseWorkspace,
  workspaceAreaPaths,
  type CanonicalFileKind,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import {
  parseTranscript,
  windowMessages,
  type TranscriptWindowOptions,
} from '../files/transcript.js';
import { openDatabase } from '../index/database.js';
import { indexPath } from '../index/paths.js';
import { refreshIndex } from '../index/refresh.js';
import type { IndexCounts, IndexResult } from '../index/result.js';
import { canonicalPath } from '../index/rows.js';
import { findFileById, missingObjectDiagnostic } from '../operations/lookup.js';
import {
  applyBodyEdit,
  applyFrontmatterPatch,
  loadEditableFile,
  type BodyEditInput,
  type EditApplyOutcome,
  type EditOutcomeStatus,
  type FrontmatterPatchInput,
} from '../operations/frontmatterEdit.js';
import {
  buildContext,
  type ContextBundle,
  type ContextScope,
} from '../search/context.js';
import {
  lexicalSearch,
  type LexicalSearchData,
  type LexicalSearchOptions,
} from '../search/lexical.js';

export interface ViewSuccess<T> {
  ok: true;
  data: T;
  diagnostics: Diagnostic[];
}

export interface ViewFailure {
  ok: false;
  notFound: boolean;
  diagnostics: Diagnostic[];
}

export type ViewOutcome<T> = ViewSuccess<T> | ViewFailure;

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface WorkspaceViewData {
  root: string;
  title: string | null;
  counts: Record<CanonicalFileKind, number>;
  validation: WorkspaceValidationCounts;
  index: WorkspaceIndexStatus;
  storage: WorkspaceStorageStatus;
  recentActivity: WorkspaceActivityEntry[];
}

export interface WorkspaceValidationCounts {
  errors: number;
  warnings: number;
}

export interface WorkspaceIndexStatus {
  path: string;
  modifiedAt: string;
  counts: IndexCounts;
}

export interface WorkspaceStorageStatus {
  indexBytes: number;
}

export interface WorkspaceActivityEntry {
  kind: CanonicalFileKind;
  id?: string;
  title: string;
  path: string;
  modifiedAt: string;
}

export interface RepositoryPathEntry {
  id: string;
  title: string | null;
  storedPath: string | null;
  resolvedPath: string | null;
  accessible: boolean | null;
}

export interface ProjectListEntry {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  path: string;
  repositories: RepositoryPathEntry[];
}

export interface ResourceEntry {
  id: string;
  title: string | null;
  kind: string | null;
  path: string | null;
  targetPath: string | null;
  url: string | null;
}

export interface ChatListEntry {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  projects: string[];
  topics: string[];
  provider: string | null;
  model: string | null;
  links: string[];
  path: string;
}

export type ChatListFilter =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'project'; projectId: string };

export interface ProjectSummaryOption {
  id: string;
  title: string;
}

export interface SummaryDocumentView {
  path: string;
  title: string | null;
  body: string | null;
}

export interface ProjectOwnedFileEntry {
  path: string;
  kind: CanonicalFileKind;
  title: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ProjectRepositoryEntry {
  id: string;
  path: string | null;
  title?: string;
  exists: boolean;
}

export interface ProjectInboundReferenceEntry {
  sourceKind: string;
  sourceId: string;
  sourceTitle: string | null;
  sourcePath: string;
  relation: string;
  updated?: string;
}

export interface ProjectDetailView {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  links: string[];
  path: string;
  repositories: ProjectRepositoryEntry[];
  resources: ResourceEntry[];
  chats: ChatListEntry[];
  summaryDocument: SummaryDocumentView | null;
  chatCount: number;
  ownedFiles: ProjectOwnedFileEntry[];
  lastActivity: string | null;
  inboundReferences: ProjectInboundReferenceEntry[];
  contentHash: string | null;
}

export interface ChatListViewData {
  filter: ChatListFilter;
  chats: ChatListEntry[];
  projects: ProjectSummaryOption[];
}

export interface ChatMessageView {
  role: string;
  text: string;
  metadata: MessageMetadata | null;
}

export interface ChatDetailViewData {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  projects: string[];
  topics: string[];
  provider: string | null;
  model: string | null;
  links: string[];
  path: string;
  contentHash: string | null;
  messages: ChatMessageView[];
  hasEarlier: boolean;
  earlierCursor?: string;
}

export interface InboxFileEntry {
  path: string;
  id: string | null;
  title: string | null;
  kind: CanonicalFileKind | null;
  sizeBytes: number;
  modifiedAt: string;
  readUrl: string;
  diagnostics: Diagnostic[];
}

export interface InboxViewData {
  chats: ChatListEntry[];
  files: InboxFileEntry[];
}

const recentActivityLimit = 10;
const unknownModifiedAt = '1970-01-01T00:00:00.000Z';

export async function workspaceView(
  root: string,
): Promise<ViewOutcome<WorkspaceViewData>> {
  const parsed = await parseWorkspace(root);
  const counts: Record<CanonicalFileKind, number> = {
    workspace: 0,
    project: 0,
    chat: 0,
    resource: 0,
    summary: 0,
    link: 0,
    task: 0,
  };
  for (const file of parsed.files) counts[file.kind] += 1;
  const refresh = await refreshIndexSafely(root);
  const indexStats = await statOrNull(refresh.indexPath);
  return {
    ok: true,
    data: {
      root: parsed.root,
      title: workspaceTitleOf(parsed.files),
      counts,
      validation: {
        errors: parsed.diagnostics.filter((entry) => entry.severity === 'error')
          .length,
        warnings: parsed.diagnostics.filter(
          (entry) => entry.severity === 'warning',
        ).length,
      },
      index: {
        path: refresh.indexPath,
        modifiedAt:
          indexStats === null
            ? unknownModifiedAt
            : indexStats.mtime.toISOString(),
        counts: refresh.counts,
      },
      storage: { indexBytes: indexStats === null ? 0 : indexStats.size },
      recentActivity: await recentActivityOf(parsed.root, parsed.files),
    },
    diagnostics: [...parsed.diagnostics, ...refresh.diagnostics],
  };
}

export async function projectListView(
  root: string,
): Promise<ViewOutcome<ProjectListEntry[]>> {
  const parsed = await parseWorkspace(root);
  const projects = parsed.files
    .filter(
      (file) =>
        file.kind === 'project' && typeof file.metadata?.id === 'string',
    )
    .map((file) => {
      const metadata = file.metadata ?? {};
      return {
        id: textOf(metadata.id),
        title: textOf(metadata.title),
        summary: textOrNull(metadata.summary),
        topics: stringListOf(metadata.topics),
        path: canonicalPath(parsed.root, file.file),
        repositories: repositoriesOf(file, parsed.files),
      };
    })
    .sort((left, right) => compareText(left.id, right.id));
  return { ok: true, data: projects, diagnostics: parsed.diagnostics };
}

export async function projectDetailView(
  root: string,
  projectId: string,
): Promise<ViewOutcome<ProjectDetailView>> {
  const parsed = await parseWorkspace(root);
  const project = findFileById(parsed.files, 'project', projectId);
  if (project === null || project.metadata === null) {
    return {
      ok: false,
      notFound: true,
      diagnostics: [missingObjectDiagnostic(parsed.root, 'project', projectId)],
    };
  }
  const metadata = project.metadata;
  const summaryFile = parsed.files.find(
    (file) =>
      file.kind === 'summary' &&
      file.metadata !== null &&
      file.metadata.kind === 'project' &&
      file.metadata.project === projectId,
  );
  const refresh = await refreshIndexSafely(root);
  const chats = attachedChats(parsed.files, parsed.root, projectId);
  const ownedFiles = await ownedFilesOf(parsed.root, project, parsed.files);
  let lastActivity: string | null = null;
  for (const file of ownedFiles) {
    lastActivity = latestIso(lastActivity, file.modifiedAt);
  }
  for (const chat of parsed.files) {
    if (chat.kind !== 'chat') continue;
    if (!stringListOf(chat.metadata?.projects).includes(projectId)) continue;
    const stats = await statOrNull(chat.file);
    if (stats !== null) {
      lastActivity = latestIso(lastActivity, stats.mtime.toISOString());
    }
  }
  return {
    ok: true,
    data: {
      id: projectId,
      title: textOf(metadata.title),
      summary: textOrNull(metadata.summary),
      topics: stringListOf(metadata.topics),
      links: stringListOf(metadata.links),
      path: canonicalPath(parsed.root, project.file),
      repositories: await repositoryStatusesOf(
        project,
        parsed.files,
        refresh.indexPath,
      ),
      resources: resourcesOf(metadata, parsed.files, parsed.root),
      chats,
      summaryDocument:
        summaryFile === undefined
          ? null
          : {
              path: canonicalPath(parsed.root, summaryFile.file),
              title: textOrNull(summaryFile.metadata?.title),
              body: summaryFile.body,
            },
      chatCount: chats.length,
      ownedFiles,
      lastActivity,
      inboundReferences: inboundReferencesOf(refresh.indexPath, projectId),
      contentHash: project.contentHash,
    },
    diagnostics: [...parsed.diagnostics, ...refresh.diagnostics],
  };
}

export async function chatListView(
  root: string,
  filter: ChatListFilter,
): Promise<ViewOutcome<ChatListViewData>> {
  const parsed = await parseWorkspace(root);
  if (
    filter.kind === 'project' &&
    findFileById(parsed.files, 'project', filter.projectId) === null
  ) {
    return {
      ok: false,
      notFound: true,
      diagnostics: [
        missingObjectDiagnostic(parsed.root, 'project', filter.projectId),
      ],
    };
  }
  const chats = parsed.files
    .filter((file) => file.kind === 'chat')
    .filter((file) => matchesFilter(file, filter))
    .map((file) => chatEntryOf(parsed.root, file))
    .sort(compareChats);
  const projects = parsed.files
    .filter(
      (file) =>
        file.kind === 'project' && typeof file.metadata?.id === 'string',
    )
    .map((file) => ({
      id: textOf(file.metadata?.id),
      title: textOf(file.metadata?.title),
    }))
    .sort((left, right) => compareText(left.id, right.id));
  return {
    ok: true,
    data: { filter, chats, projects },
    diagnostics: parsed.diagnostics,
  };
}

export async function chatDetailView(
  root: string,
  chatId: string,
  options: TranscriptWindowOptions = {},
): Promise<ViewOutcome<ChatDetailViewData>> {
  const parsed = await parseWorkspace(root);
  const chat = findFileById(parsed.files, 'chat', chatId);
  if (chat === null) {
    return {
      ok: false,
      notFound: true,
      diagnostics: [missingObjectDiagnostic(parsed.root, 'chat', chatId)],
    };
  }
  const metadata = chat.metadata ?? {};
  const transcript = parseTranscript(chat.body ?? '', chat.file);
  const window = windowMessages(transcript.messages, options);
  const data: ChatDetailViewData = {
    id: chatId,
    title: textOf(metadata.title),
    created: dateTextOf(metadata.created),
    updated: dateTextOf(metadata.updated),
    projects: stringListOf(metadata.projects),
    topics: stringListOf(metadata.topics),
    provider: textOrNull(metadata.provider),
    model: textOrNull(metadata.model),
    links: stringListOf(metadata.links),
    path: canonicalPath(parsed.root, chat.file),
    contentHash: chat.contentHash,
    messages: window.messages.map((message) => ({
      role: message.role,
      text: message.text,
      metadata: message.metadata,
    })),
    hasEarlier: window.hasEarlier,
  };
  if (window.hasEarlier && window.earlierCursor !== undefined) {
    data.earlierCursor = window.earlierCursor;
  }
  return {
    ok: true,
    data,
    diagnostics: [...parsed.diagnostics, ...transcript.diagnostics],
  };
}

export async function inboxView(
  root: string,
): Promise<ViewOutcome<InboxViewData>> {
  const parsed = await parseWorkspace(root);
  const chats = parsed.files
    .filter((file) => file.kind === 'chat')
    .filter((file) => stringListOf(file.metadata?.projects).length === 0)
    .map((file) => chatEntryOf(parsed.root, file))
    .sort(compareChats);

  const areas = await workspaceAreaPaths(parsed.root);
  const discovered = await listFilesRecursive(areas.inbox);
  const byAbsolute = new Map(
    parsed.files.map((file) => [path.resolve(file.file), file]),
  );
  const files: InboxFileEntry[] = [];
  for (const file of discovered) {
    const resolved = parsedFileLookup(byAbsolute, file);
    const metadata = resolved?.metadata ?? null;
    const stats = await statOrNull(file);
    const storedPath = canonicalPath(parsed.root, file);
    files.push({
      path: storedPath,
      id: typeof metadata?.id === 'string' ? metadata.id : null,
      title: typeof metadata?.title === 'string' ? metadata.title : null,
      kind: resolved === undefined ? null : resolved.kind,
      sizeBytes: stats === null ? 0 : stats.size,
      modifiedAt:
        stats === null ? unknownModifiedAt : stats.mtime.toISOString(),
      readUrl: `/api/file?path=${encodeURIComponent(storedPath)}`,
      diagnostics: resolved === undefined ? [] : resolved.diagnostics,
    });
  }
  return { ok: true, data: { chats, files }, diagnostics: parsed.diagnostics };
}

export async function searchView(
  root: string,
  options: LexicalSearchOptions,
): Promise<ViewOutcome<LexicalSearchData>> {
  const result = await lexicalSearch(root, options);
  if (!result.ok) {
    return { ok: false, notFound: false, diagnostics: result.diagnostics };
  }
  return { ok: true, data: result.data, diagnostics: result.diagnostics };
}

export async function contextView(
  root: string,
  query: string,
  scope: ContextScope,
): Promise<ViewOutcome<ContextBundle>> {
  const result = await buildContext(root, query, scope);
  if (!result.ok || result.bundle === null) {
    return { ok: false, notFound: false, diagnostics: result.diagnostics };
  }
  return { ok: true, data: result.bundle, diagnostics: result.diagnostics };
}

export function requiredQueryParam(
  query: URLSearchParams,
  name: string,
): string | null {
  const value = query.get(name);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

export function parseChatListQuery(
  query: URLSearchParams,
): { ok: true; filter: ChatListFilter } | { ok: false; message: string } {
  const view = query.get('view') ?? 'all';
  if (view === 'all') return { ok: true, filter: { kind: 'all' } };
  if (view === 'unassigned')
    return { ok: true, filter: { kind: 'unassigned' } };
  if (view === 'project') {
    const project = requiredQueryParam(query, 'project');
    if (project === null) {
      return {
        ok: false,
        message: "The 'project' parameter is required when 'view=project'.",
      };
    }
    return { ok: true, filter: { kind: 'project', projectId: project } };
  }
  return { ok: false, message: `Unknown chats view '${view}'.` };
}

export function parseContextScope(
  query: URLSearchParams,
): { ok: true; scope: ContextScope } | { ok: false; message: string } {
  const project = requiredQueryParam(query, 'project');
  const chat = requiredQueryParam(query, 'chat');
  if (project !== null && chat !== null) {
    return {
      ok: false,
      message: "The 'project' and 'chat' parameters cannot be combined.",
    };
  }
  if (chat !== null) return { ok: true, scope: { kind: 'chat', chatId: chat } };
  if (project !== null) {
    return { ok: true, scope: { kind: 'project', projectId: project } };
  }
  return { ok: true, scope: { kind: 'global' } };
}

export function parseNonNegativeIntegerParam(
  query: URLSearchParams,
  name: string,
):
  | { ok: true; present: boolean; value: number }
  | { ok: false; message: string } {
  const raw = query.get(name);
  if (raw === null || raw.trim() === '') {
    return { ok: true, present: false, value: 0 };
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return {
      ok: false,
      message: `The '${name}' parameter must be a non-negative integer.`,
    };
  }
  return { ok: true, present: true, value: Number(trimmed) };
}

export async function workspaceApi(root: string): Promise<ApiResponse> {
  return respond(await workspaceView(root));
}

export async function projectsApi(root: string): Promise<ApiResponse> {
  const view = await projectListView(root);
  if (!view.ok) return viewError(view);
  return {
    status: 200,
    body: { projects: view.data, diagnostics: view.diagnostics },
  };
}

export async function projectApi(
  root: string,
  projectId: string,
): Promise<ApiResponse> {
  return respond(await projectDetailView(root, projectId));
}

export async function chatsApi(
  root: string,
  query: URLSearchParams,
): Promise<ApiResponse> {
  const parsedQuery = parseChatListQuery(query);
  if (!parsedQuery.ok) return badRequest(parsedQuery.message);
  return respond(await chatListView(root, parsedQuery.filter));
}

export async function chatApi(
  root: string,
  chatId: string,
  query: URLSearchParams = new URLSearchParams(),
): Promise<ApiResponse> {
  const limit = parseNonNegativeIntegerParam(query, 'limit');
  if (!limit.ok) return badRequest(limit.message);
  const before = parseNonNegativeIntegerParam(query, 'before');
  if (!before.ok) return badRequest(before.message);
  const options: TranscriptWindowOptions = {};
  if (limit.present) options.limit = limit.value;
  if (before.present) options.before = String(before.value);
  return respond(await chatDetailView(root, chatId, options));
}

export async function inboxApi(root: string): Promise<ApiResponse> {
  return respond(await inboxView(root));
}

export async function searchApi(
  root: string,
  query: URLSearchParams,
): Promise<ApiResponse> {
  const q = requiredQueryParam(query, 'q');
  if (q === null) return badRequest("The 'q' parameter is required.");
  const project = requiredQueryParam(query, 'project');
  const limit = parseNonNegativeIntegerParam(query, 'limit');
  if (!limit.ok) return badRequest(limit.message);
  const offset = parseNonNegativeIntegerParam(query, 'offset');
  if (!offset.ok) return badRequest(offset.message);
  const options: LexicalSearchOptions = { query: q };
  if (project !== null) options.scope = { kind: 'project', project };
  if (limit.present) options.limit = limit.value;
  if (offset.present) options.offset = offset.value;
  return respond(await searchView(root, options));
}

export async function contextApi(
  root: string,
  query: URLSearchParams,
): Promise<ApiResponse> {
  const q = requiredQueryParam(query, 'q');
  if (q === null) return badRequest("The 'q' parameter is required.");
  const scope = parseContextScope(query);
  if (!scope.ok) return badRequest(scope.message);
  return respond(await contextView(root, q, scope.scope));
}

export async function fileApi(
  root: string,
  query: URLSearchParams,
): Promise<ApiResponse> {
  const targetPath = requiredQueryParam(query, 'path');
  if (targetPath === null) {
    return badRequest("The 'path' parameter is required.");
  }
  const outcome = await loadEditableFile(root, targetPath);
  if (outcome.status === 'ok' && outcome.view !== null) {
    return {
      status: 200,
      body: { ...outcome.view, diagnostics: outcome.diagnostics },
    };
  }
  return editFailure(outcome.status, outcome.diagnostics);
}

export function parseFrontmatterEditPayload(
  payload: unknown,
): { ok: true; input: FrontmatterPatchInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.path !== 'string' || payload.path.trim() === '') {
    return { ok: false, message: "The 'path' field is required." };
  }
  if (!isRecord(payload.changes)) {
    return { ok: false, message: "The 'changes' field must be an object." };
  }
  return {
    ok: true,
    input: {
      path: payload.path,
      changes: payload.changes,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseBodyEditPayload(
  payload: unknown,
): { ok: true; input: BodyEditInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.path !== 'string' || payload.path.trim() === '') {
    return { ok: false, message: "The 'path' field is required." };
  }
  if (typeof payload.body !== 'string') {
    return { ok: false, message: "The 'body' field must be a string." };
  }
  return {
    ok: true,
    input: {
      path: payload.path,
      body: payload.body,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export async function editFrontmatterApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseFrontmatterEditPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root);
  }
  return editApplyResponse(await applyFrontmatterPatch(root, parsed.input));
}

export async function editBodyApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBodyEditPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root);
  }
  return editApplyResponse(await applyBodyEdit(root, parsed.input));
}

const editStatusCodes: Record<EditOutcomeStatus, number> = {
  ok: 200,
  invalid: 422,
  conflict: 409,
  notFound: 404,
  outOfScope: 400,
};

function editApplyResponse(outcome: EditApplyOutcome): ApiResponse {
  if (outcome.status === 'ok') {
    return {
      status: 200,
      body: {
        changed: outcome.changed,
        diagnostics: outcome.diagnostics,
        contentHash: outcome.contentHash,
      },
    };
  }
  if (outcome.status === 'conflict') {
    return editFailure('conflict', outcome.diagnostics, {
      currentHash: outcome.contentHash,
    });
  }
  return editFailure(outcome.status, outcome.diagnostics);
}

function editFailure(
  status: EditOutcomeStatus,
  diagnostics: Diagnostic[],
  extra: Record<string, unknown> = {},
): ApiResponse {
  return apiFailure(editStatusCodes[status], diagnostics, extra);
}

function respond<T>(view: ViewOutcome<T>): ApiResponse {
  if (!view.ok) return viewError(view);
  return {
    status: 200,
    body: { ...spreadData(view.data), diagnostics: view.diagnostics },
  };
}

function viewError(view: ViewFailure): ApiResponse {
  const status = view.notFound ? 404 : 500;
  const message =
    view.diagnostics.find((entry) => entry.severity === 'error')?.message ??
    'The request could not be completed.';
  return {
    status,
    body: { error: message, diagnostics: view.diagnostics },
  };
}

export function badRequest(message: string): ApiResponse {
  return { status: 400, body: { error: message, diagnostics: [] } };
}

export function hashRequiredResponse(
  root: string,
  hashSource = 'GET /api/file',
): ApiResponse {
  const entry = diagnostic(
    root,
    'edit.hash_required',
    'error',
    `The 'expectedHash' field is required and must be the 64-character content hash reported by ${hashSource}.`,
    { fieldPath: 'expectedHash' },
  );
  return { status: 400, body: { error: entry.message, diagnostics: [entry] } };
}

export function apiFailure(
  status: number,
  diagnostics: Diagnostic[],
  extra: Record<string, unknown> = {},
): ApiResponse {
  const message =
    diagnostics.find((entry) => entry.severity === 'error')?.message ??
    'The request could not be completed.';
  return { status, body: { error: message, diagnostics, ...extra } };
}

function spreadData(data: unknown): Record<string, unknown> {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { data };
}

function workspaceTitleOf(files: ParsedWorkspaceFile[]): string | null {
  const settings = files.find((file) => file.kind === 'workspace');
  return typeof settings?.metadata?.title === 'string'
    ? settings.metadata.title
    : null;
}

function repositoriesOf(
  project: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
): RepositoryPathEntry[] {
  const entries = Array.isArray(project.metadata?.repositories)
    ? project.metadata.repositories
    : [];
  const views: RepositoryPathEntry[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const resource = files.find((file) => file.metadata?.id === entry);
      views.push({
        id: entry,
        title: textOrNull(resource?.metadata?.title),
        storedPath: textOrNull(resource?.metadata?.path),
        resolvedPath: resolvedPathOf(resource, 'path'),
        accessible:
          resource === undefined
            ? null
            : (resolvedEntryOf(resource, 'path')?.accessible ?? null),
      });
      return;
    }
    if (isRecord(entry)) {
      const fieldPath = `repositories.${String(index)}.path`;
      views.push({
        id: textOf(entry.id),
        title: textOrNull(entry.title),
        storedPath: textOrNull(entry.path),
        resolvedPath: resolvedPathOf(project, fieldPath),
        accessible: resolvedEntryOf(project, fieldPath)?.accessible ?? null,
      });
    }
  });
  return views;
}

function resourcesOf(
  metadata: Record<string, unknown>,
  files: ParsedWorkspaceFile[],
  root: string,
): ResourceEntry[] {
  return stringListOf(metadata.resources).map((id) => {
    const resource = files.find((file) => file.metadata?.id === id);
    return {
      id,
      title: textOrNull(resource?.metadata?.title),
      kind: resource === undefined ? null : resource.kind,
      path: resource === undefined ? null : canonicalPath(root, resource.file),
      targetPath:
        resource === undefined ? null : resolvedPathOf(resource, 'path'),
      url: textOrNull(resource?.metadata?.url),
    };
  });
}

async function refreshIndexSafely(root: string): Promise<IndexResult> {
  try {
    return await refreshIndex(root);
  } catch (error) {
    return {
      indexPath: indexPath(path.resolve(root)),
      rebuilt: false,
      counts: {
        files: 0,
        objects: 0,
        references: 0,
        repositories: 0,
        documents: 0,
      },
      diagnostics: [
        diagnostic(
          root,
          'index.refresh_failed',
          'error',
          `The index refresh failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      ],
    };
  }
}

async function statOrNull(file: string): Promise<Stats | null> {
  try {
    return await stat(file);
  } catch {
    return null;
  }
}

async function recentActivityOf(
  root: string,
  files: ParsedWorkspaceFile[],
): Promise<WorkspaceActivityEntry[]> {
  const candidates: (WorkspaceActivityEntry & { mtimeMs: number })[] = [];
  for (const file of files) {
    const stats = await statOrNull(file.file);
    if (stats === null) continue;
    const entry: WorkspaceActivityEntry & { mtimeMs: number } = {
      kind: file.kind,
      title: fileTitleOf(file),
      path: canonicalPath(root, file.file),
      modifiedAt: stats.mtime.toISOString(),
      mtimeMs: stats.mtimeMs,
    };
    const id = file.metadata?.id;
    if (typeof id === 'string') entry.id = id;
    candidates.push(entry);
  }
  candidates.sort(
    (left, right) =>
      right.mtimeMs - left.mtimeMs || compareText(left.path, right.path),
  );
  return candidates.slice(0, recentActivityLimit).map((candidate) => {
    const entry: WorkspaceActivityEntry = {
      kind: candidate.kind,
      title: candidate.title,
      path: candidate.path,
      modifiedAt: candidate.modifiedAt,
    };
    if (candidate.id !== undefined) entry.id = candidate.id;
    return entry;
  });
}

function fileTitleOf(file: ParsedWorkspaceFile): string {
  const title = file.metadata?.title;
  if (typeof title === 'string' && title.trim() !== '') return title;
  const base = path.basename(file.file);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function latestIso(current: string | null, candidate: string): string {
  return current !== null && current >= candidate ? current : candidate;
}

async function ownedFilesOf(
  root: string,
  project: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
): Promise<ProjectOwnedFileEntry[]> {
  const directory = path.dirname(project.file);
  const entries: ProjectOwnedFileEntry[] = [];
  for (const file of files) {
    if (!isInsideDirectory(directory, file.file)) continue;
    const stats = await statOrNull(file.file);
    if (stats === null) continue;
    entries.push({
      path: canonicalPath(root, file.file),
      kind: file.kind,
      title: fileTitleOf(file),
      sizeBytes: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    });
  }
  entries.sort((left, right) => compareText(left.path, right.path));
  return entries;
}

function isInsideDirectory(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function repositoryStatusesOf(
  project: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
  indexTarget: string,
): Promise<ProjectRepositoryEntry[]> {
  const entries = Array.isArray(project.metadata?.repositories)
    ? project.metadata.repositories
    : [];
  const views: ProjectRepositoryEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry === 'string') {
      const resource = files.find((file) => file.metadata?.id === entry);
      const resolved = resolvedPathOf(resource, 'path');
      views.push(
        await repositoryStatusEntry(
          entry,
          resolved ?? repositoryPathFromIndex(indexTarget, entry),
          textOrNull(resource?.metadata?.title),
        ),
      );
      continue;
    }
    if (!isRecord(entry)) continue;
    const id = textOf(entry.id);
    if (id === '') continue;
    views.push(
      await repositoryStatusEntry(
        id,
        resolvedPathOf(project, `repositories.${String(index)}.path`),
        textOrNull(entry.title),
      ),
    );
  }
  return views;
}

async function repositoryStatusEntry(
  id: string,
  resolvedPath: string | null,
  title: string | null,
): Promise<ProjectRepositoryEntry> {
  const entry: ProjectRepositoryEntry = {
    id,
    path: resolvedPath,
    exists: resolvedPath !== null && (await statOrNull(resolvedPath)) !== null,
  };
  if (title !== null) entry.title = title;
  return entry;
}

function repositoryPathFromIndex(target: string, id: string): string | null {
  try {
    const database = openDatabase(target, { readonly: true });
    try {
      const row = database.get<{ path: string }>(
        'SELECT path FROM repositories WHERE id = ?',
        id,
      );
      return row?.path ?? null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
}

interface InboundReferenceRow {
  source: string;
  relation: string;
  type: string | null;
  title: string | null;
  path: string | null;
  metadata: string | null;
}

function inboundReferencesOf(
  indexTarget: string,
  projectId: string,
): ProjectInboundReferenceEntry[] {
  let rows: InboundReferenceRow[] = [];
  try {
    const database = openDatabase(indexTarget, { readonly: true });
    try {
      rows = database.all<InboundReferenceRow>(
        `SELECT "references".source AS source,
                "references".relation AS relation,
                objects.type AS type,
                objects.title AS title,
                objects.path AS path,
                objects.metadata AS metadata
         FROM "references"
         LEFT JOIN objects ON objects.id = "references".source
         WHERE "references".target = ?
         ORDER BY "references".source, "references".relation`,
        projectId,
      );
    } finally {
      database.close();
    }
  } catch {
    return [];
  }
  return rows.map((row) => {
    const entry: ProjectInboundReferenceEntry = {
      sourceKind: row.type ?? 'unknown',
      sourceId: row.source,
      sourceTitle: row.title,
      sourcePath: row.path ?? '',
      relation: row.relation,
    };
    const updated = updatedOfRoutingMetadata(row.metadata);
    if (updated !== null) entry.updated = updated;
    return entry;
  });
}

function updatedOfRoutingMetadata(metadata: string | null): string | null {
  if (metadata === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata) as unknown;
  } catch {
    return null;
  }
  return isRecord(parsed) && typeof parsed.updated === 'string'
    ? parsed.updated
    : null;
}

function matchesFilter(
  file: ParsedWorkspaceFile,
  filter: ChatListFilter,
): boolean {
  const projects = stringListOf(file.metadata?.projects);
  switch (filter.kind) {
    case 'all':
      return true;
    case 'unassigned':
      return projects.length === 0;
    default:
      return projects.includes(filter.projectId);
  }
}

function compareChats(left: ChatListEntry, right: ChatListEntry): number {
  const leftCreated = left.created ?? '';
  const rightCreated = right.created ?? '';
  if (leftCreated !== rightCreated) {
    return leftCreated > rightCreated ? -1 : 1;
  }
  return compareText(left.id, right.id);
}

function resolvedPathOf(
  file: ParsedWorkspaceFile | undefined,
  fieldPath: string,
): string | null {
  return resolvedEntryOf(file, fieldPath)?.resolvedPath ?? null;
}

function resolvedEntryOf(
  file: ParsedWorkspaceFile | undefined,
  fieldPath: string,
) {
  return file?.resolvedPaths.find((entry) => entry.fieldPath === fieldPath);
}

function attachedChats(
  files: ParsedWorkspaceFile[],
  root: string,
  projectId: string,
): ChatListEntry[] {
  return files
    .filter(
      (file) =>
        file.kind === 'chat' &&
        stringListOf(file.metadata?.projects).includes(projectId),
    )
    .map((file) => chatEntryOf(root, file))
    .sort(compareChats);
}

function chatEntryOf(root: string, file: ParsedWorkspaceFile): ChatListEntry {
  const metadata = file.metadata ?? {};
  return {
    id: textOf(metadata.id),
    title: textOf(metadata.title),
    created: dateTextOf(metadata.created),
    updated: dateTextOf(metadata.updated),
    projects: stringListOf(metadata.projects),
    topics: stringListOf(metadata.topics),
    provider: textOrNull(metadata.provider),
    model: textOrNull(metadata.model),
    links: stringListOf(metadata.links),
    path: canonicalPath(root, file.file),
  };
}

async function listFilesRecursive(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files.sort((left, right) => compareText(left, right));
}

function parsedFileLookup(
  byAbsolute: Map<string, ParsedWorkspaceFile>,
  file: string,
): ParsedWorkspaceFile | undefined {
  return byAbsolute.get(path.resolve(file));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function dateTextOf(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString();
  }
  return typeof value === 'string' ? value : null;
}

function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
