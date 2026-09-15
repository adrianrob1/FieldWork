import { parseDiagnostics } from '../responses.js';
import type { DiagnosticView } from '../types.js';

export type RepositoryState = 'live' | 'missing' | 'unknown';

export interface RepositoryEntry {
  id: string;
  title: string | null;
  path: string | null;
  state: RepositoryState;
}

export interface ProjectListEntry {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  path: string;
  repositories: RepositoryEntry[];
}

export interface OwnedFileEntry {
  path: string;
  kind: string;
  title: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface ProjectResourceEntry {
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
  path: string;
}

export interface SummaryDocument {
  path: string;
  title: string | null;
  body: string | null;
}

export interface InboundReferenceEntry {
  sourceKind: string;
  sourceId: string;
  sourceTitle: string | null;
  sourcePath: string;
  relation: string;
  updated: string | null;
}

export interface ProjectDetail {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  links: string[];
  path: string;
  repositories: RepositoryEntry[];
  resources: ProjectResourceEntry[];
  chats: ChatListEntry[];
  summaryDocument: SummaryDocument | null;
  chatCount: number;
  ownedFiles: OwnedFileEntry[];
  lastActivity: string | null;
  inboundReferences: InboundReferenceEntry[];
  contentHash: string | null;
  diagnostics: DiagnosticView[];
}

// Display name for a registered repository: an explicit title wins, otherwise
// the final segment of its path, otherwise the stable id.
export function repositoryName(repository: RepositoryEntry): string {
  if (repository.title !== null && repository.title !== '') {
    return repository.title;
  }
  if (repository.path !== null && repository.path !== '') {
    const segments = repository.path
      .split(/[\\/]+/)
      .filter((segment) => segment.length > 0);
    const last = segments[segments.length - 1];
    if (last !== undefined) return last;
  }
  return repository.id;
}

export function toProjectListEntries(data: unknown): ProjectListEntry[] {
  const record = isRecord(data) ? data : {};
  if (!Array.isArray(record.projects)) return [];
  return record.projects
    .map((entry) => parseListEntry(entry))
    .filter((entry): entry is ProjectListEntry => entry !== null);
}

export function toChatListEntries(data: unknown): ChatListEntry[] {
  const record = isRecord(data) ? data : {};
  if (!Array.isArray(record.chats)) return [];
  return record.chats
    .map((entry) => parseChatEntry(entry))
    .filter((entry): entry is ChatListEntry => entry !== null);
}

export function toProjectDetail(data: unknown): ProjectDetail {
  const record = isRecord(data) ? data : {};
  return {
    id: stringOf(record.id),
    title: stringOf(record.title),
    summary: stringOrNull(record.summary),
    topics: stringList(record.topics),
    links: stringList(record.links),
    path: stringOf(record.path),
    repositories: parseRepositories(record.repositories),
    resources: parseResources(record.resources),
    chats: Array.isArray(record.chats)
      ? record.chats
          .map((entry) => parseChatEntry(entry))
          .filter((entry): entry is ChatListEntry => entry !== null)
      : [],
    summaryDocument: parseSummaryDocument(record.summaryDocument),
    chatCount: numberOf(record.chatCount),
    ownedFiles: parseOwnedFiles(record.ownedFiles),
    lastActivity: stringOrNull(record.lastActivity),
    inboundReferences: parseInboundReferences(record.inboundReferences),
    contentHash: stringOrNull(record.contentHash),
    diagnostics: parseDiagnostics(data),
  };
}

function parseListEntry(value: unknown): ProjectListEntry | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  if (id === null) return null;
  return {
    id,
    title: stringOrNull(value.title) ?? id,
    summary: stringOrNull(value.summary),
    topics: stringList(value.topics),
    path: stringOf(value.path),
    repositories: parseRepositories(value.repositories),
  };
}

function parseRepositories(value: unknown): RepositoryEntry[] {
  if (!Array.isArray(value)) return [];
  const repositories: RepositoryEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = stringOrNull(item.id) ?? stringOrNull(item.title);
    if (id === null) continue;
    repositories.push({
      id,
      title: stringOrNull(item.title),
      path:
        stringOrNull(item.path) ??
        stringOrNull(item.resolvedPath) ??
        stringOrNull(item.storedPath),
      state: repositoryState(item),
    });
  }
  return repositories;
}

function repositoryState(value: Record<string, unknown>): RepositoryState {
  if (typeof value.exists === 'boolean') {
    return value.exists ? 'live' : 'missing';
  }
  if (typeof value.accessible === 'boolean') {
    return value.accessible ? 'live' : 'missing';
  }
  return 'unknown';
}

function parseOwnedFiles(value: unknown): OwnedFileEntry[] {
  if (!Array.isArray(value)) return [];
  const files: OwnedFileEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = stringOrNull(item.path);
    if (path === null) continue;
    files.push({
      path,
      kind: stringOf(item.kind),
      title: stringOrNull(item.title) ?? path,
      sizeBytes: numberOf(item.sizeBytes),
      modifiedAt: stringOf(item.modifiedAt),
    });
  }
  return files;
}

function parseResources(value: unknown): ProjectResourceEntry[] {
  if (!Array.isArray(value)) return [];
  const resources: ProjectResourceEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = stringOrNull(item.id) ?? stringOrNull(item.title);
    if (id === null) continue;
    resources.push({
      id,
      title: stringOrNull(item.title),
      kind: stringOrNull(item.kind),
      path: stringOrNull(item.path),
      targetPath: stringOrNull(item.targetPath),
      url: stringOrNull(item.url),
    });
  }
  return resources;
}

function parseChatEntry(value: unknown): ChatListEntry | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  if (id === null) return null;
  return {
    id,
    title: stringOrNull(value.title) ?? id,
    created: stringOrNull(value.created),
    updated: stringOrNull(value.updated),
    projects: stringList(value.projects),
    topics: stringList(value.topics),
    provider: stringOrNull(value.provider),
    model: stringOrNull(value.model),
    path: stringOf(value.path),
  };
}

function parseSummaryDocument(value: unknown): SummaryDocument | null {
  if (!isRecord(value)) return null;
  const path = stringOrNull(value.path);
  if (path === null) return null;
  return {
    path,
    title: stringOrNull(value.title),
    body: stringOrNull(value.body),
  };
}

function parseInboundReferences(value: unknown): InboundReferenceEntry[] {
  if (!Array.isArray(value)) return [];
  const references: InboundReferenceEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const sourceId = stringOrNull(item.sourceId);
    const sourcePath = stringOrNull(item.sourcePath);
    if (sourceId === null || sourcePath === null) continue;
    references.push({
      sourceKind: stringOf(item.sourceKind),
      sourceId,
      sourceTitle: stringOrNull(item.sourceTitle),
      sourcePath,
      relation: stringOf(item.relation),
      updated: stringOrNull(item.updated),
    });
  }
  return references;
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
