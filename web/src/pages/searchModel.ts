import { parseDiagnostics } from '../shared/responses.js';
import type { DiagnosticView } from '../shared/types.js';
import { formatClock } from './workspaceModel.js';

export type SearchSource = 'workspace' | 'repository';

export type SearchScope =
  { kind: 'workspace' } | { kind: 'project'; project: string };

export interface SearchIndexStatus {
  path: string;
  modifiedAt: string;
  counts: Record<string, number> | null;
}

export interface SearchResultEntry {
  source: SearchSource;
  kind: string;
  path: string;
  objectId: string | null;
  repositoryId: string | null;
  title: string;
  snippet: string;
  lineStart: number | null;
  lineEnd: number | null;
  matchCount: number;
}

export interface SearchData {
  query: string;
  scope: SearchScope;
  results: SearchResultEntry[];
  totalResults: number;
  returnedResults: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  durationMs: number;
  index: SearchIndexStatus;
  diagnostics: DiagnosticView[];
}

export interface SnippetSegment {
  text: string;
  match: boolean;
}

export type HitTarget =
  | { navigable: true; to: string }
  | { navigable: false; repositoryId: string; path: string };

export interface SearchStatusView {
  hitsLabel: string;
  durationLabel: string;
  indexLabel: string;
}

const knownModifiedAt = '1970-01-01T00:00:00.000Z';

export function toSearchData(data: unknown): SearchData {
  const record = isRecord(data) ? data : {};
  return {
    query: stringOf(record.query),
    scope: parseScope(record.scope),
    results: parseResults(record.results),
    totalResults: numberOf(record.totalResults),
    returnedResults: numberOf(record.returnedResults),
    limit: numberOf(record.limit),
    offset: numberOf(record.offset),
    hasMore: record.hasMore === true,
    durationMs: numberOf(record.durationMs),
    index: parseIndex(record.index),
    diagnostics: parseDiagnostics(data),
  };
}

function parseScope(value: unknown): SearchScope {
  const record = isRecord(value) ? value : {};
  const project = stringOrNull(record.project);
  if (record.kind === 'project' && project !== null) {
    return { kind: 'project', project };
  }
  return { kind: 'workspace' };
}

function parseIndex(value: unknown): SearchIndexStatus {
  const record = isRecord(value) ? value : {};
  return {
    path: stringOf(record.path),
    modifiedAt: stringOf(record.modifiedAt),
    counts: numberRecordOrNull(record.counts),
  };
}

function parseResults(value: unknown): SearchResultEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SearchResultEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const path = stringOrNull(item.path);
    if (path === null) continue;
    entries.push({
      source: item.source === 'repository' ? 'repository' : 'workspace',
      kind: stringOrNull(item.kind) ?? 'document',
      path,
      objectId: stringOrNull(item.objectId),
      repositoryId: stringOrNull(item.repositoryId),
      title: stringOrNull(item.title) ?? path,
      snippet: stringOf(item.snippet),
      lineStart: numberOrNull(item.lineStart),
      lineEnd: numberOrNull(item.lineEnd),
      matchCount: numberOf(item.matchCount),
    });
  }
  return entries;
}

// The live FTS snippet and the ripgrep marker both wrap matched terms in square
// brackets: snippet(..., '[', ']', ...) in the index and markTerms() for
// repositories. Some fixtures use <mark> markers, so both forms are parsed. The
// snippet is inert text; callers render the segments as React nodes and never
// inject them as HTML.
export function parseSnippet(snippet: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let buffer = '';
  let index = 0;
  const flush = () => {
    if (buffer !== '') {
      segments.push({ text: buffer, match: false });
      buffer = '';
    }
  };
  while (index < snippet.length) {
    if (snippet.startsWith('<mark>', index)) {
      flush();
      const close = snippet.indexOf('</mark>', index + 6);
      const end = close === -1 ? snippet.length : close;
      const text = snippet.slice(index + 6, end);
      if (text !== '') segments.push({ text, match: true });
      index = close === -1 ? snippet.length : close + 7;
      continue;
    }
    if (snippet[index] === '[') {
      const close = snippet.indexOf(']', index + 1);
      if (close !== -1) {
        flush();
        const text = snippet.slice(index + 1, close);
        if (text !== '') segments.push({ text, match: true });
        index = close + 1;
        continue;
      }
    }
    buffer += snippet[index];
    index += 1;
  }
  flush();
  return segments;
}

// Route for a document. Chats and projects open their detail page when the
// index carries an object id; every other workspace document opens in the
// editor by path. Repository hits are not navigable: the interface shows the
// repository id and path instead of a link.
export function documentTarget(
  kind: string,
  objectId: string | null,
  storedPath: string,
): HitTarget {
  if (kind === 'chat' && objectId !== null) {
    return { navigable: true, to: `/chats/${encodeURIComponent(objectId)}` };
  }
  if (kind === 'project' && objectId !== null) {
    return {
      navigable: true,
      to: `/projects/${encodeURIComponent(objectId)}`,
    };
  }
  return {
    navigable: true,
    to: `/edit?path=${encodeURIComponent(storedPath)}`,
  };
}

export function hitTarget(hit: SearchResultEntry): HitTarget {
  if (hit.source === 'repository') {
    return {
      navigable: false,
      repositoryId: hit.repositoryId ?? '',
      path: hit.path,
    };
  }
  return documentTarget(hit.kind, hit.objectId, hit.path);
}

export function lineRangeLabel(hit: SearchResultEntry): string {
  if (hit.lineStart === null) return '';
  const end = hit.lineEnd ?? hit.lineStart;
  if (end === hit.lineStart) return `line ${String(hit.lineStart)}`;
  return `lines ${String(hit.lineStart)}-${String(end)}`;
}

export function matchLabel(count: number): string {
  return `${String(count)} ${count === 1 ? 'match' : 'matches'}`;
}

export function searchStatus(data: SearchData, now: Date): SearchStatusView {
  const documents = data.index.counts?.documents ?? null;
  const hitWord = data.totalResults === 1 ? 'hit' : 'hits';
  const hitsLabel =
    documents === null
      ? `${String(data.totalResults)} ${hitWord}`
      : `${String(data.totalResults)} ${hitWord} in ${String(documents)} documents`;
  const fresh =
    data.index.modifiedAt === '' || data.index.modifiedAt === knownModifiedAt;
  return {
    hitsLabel,
    durationLabel: `${String(data.durationMs)} ms`,
    indexLabel: fresh
      ? 'index freshness unknown'
      : `index current as of ${formatClock(data.index.modifiedAt, now)}`,
  };
}

export function showingLabel(total: number, returned: number): string {
  const word = total === 1 ? 'result' : 'results';
  return `Showing ${String(returned)} of ${String(total)} ${word}`;
}

export function appendResults(
  existing: readonly SearchResultEntry[],
  incoming: readonly SearchResultEntry[],
): SearchResultEntry[] {
  return [...existing, ...incoming];
}

export function searchRoute(
  query: string,
  project: string | null,
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams();
  params.set('q', query);
  if (project !== null && project !== '') params.set('project', project);
  if (offset > 0) params.set('offset', String(offset));
  if (limit > 0) params.set('limit', String(limit));
  return `/api/search?${params.toString()}`;
}

export function searchPagePath(query: string, project: string | null): string {
  const params = new URLSearchParams();
  params.set('q', query);
  if (project !== null && project !== '') params.set('project', project);
  return `/search?${params.toString()}`;
}

function numberRecordOrNull(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      result[key] = entry;
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
