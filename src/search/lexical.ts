import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Diagnostic } from '../domain/diagnostics.js';
import { openDatabase } from '../index/database.js';
import { indexPath } from '../index/paths.js';
import { refreshIndex } from '../index/refresh.js';
import type { IndexCounts } from '../index/result.js';
import {
  repositoryIdsForProject,
  searchRepositories,
  type RepositoryMatch,
} from '../index/repositories.js';
import {
  searchIndex,
  type SearchHit,
  type SearchScope,
} from '../index/search.js';
import { dedupeDiagnostics, isOperationalFailure } from './outcome.js';

export type LexicalScope =
  { kind: 'workspace' } | { kind: 'project'; project: string };

export interface LexicalSearchOptions {
  query: string;
  scope?: LexicalScope;
  limit?: number;
  offset?: number;
}

export interface SearchResultEntry {
  source: 'workspace' | 'repository';
  kind: string;
  path: string;
  objectId?: string;
  repositoryId?: string;
  title: string;
  snippet: string;
  lineStart?: number;
  lineEnd?: number;
  matchCount: number;
}

export interface LexicalIndexStatus {
  path: string;
  modifiedAt: string;
  counts?: IndexCounts;
}

export interface LexicalSearchData {
  query: string;
  scope: LexicalScope;
  results: SearchResultEntry[];
  totalResults: number;
  returnedResults: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  durationMs: number;
  index: LexicalIndexStatus;
  diagnostics: Diagnostic[];
}

export interface LexicalSearchOutcome {
  ok: boolean;
  data: LexicalSearchData;
  diagnostics: Diagnostic[];
}

export interface ResultPage {
  results: SearchResultEntry[];
  totalResults: number;
  returnedResults: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const DEFAULT_RESULT_LIMIT = 50;
const MIN_RESULT_LIMIT = 1;
const MAX_RESULT_LIMIT = 200;
const ENRICH_MAX_FILE_BYTES = 512 * 1024;
const ENRICH_MAX_LINES = 5000;
const MAX_LINE_MATCHES = 999;
const UNKNOWN_MODIFIED_AT = '1970-01-01T00:00:00.000Z';

export function queryTerms(query: string): string[] {
  return query.split(/\s+/).filter((term) => term.length > 0);
}

export function markTerms(text: string, terms: string[]): string {
  if (terms.length === 0) return text;
  const distinct = [...new Set(terms)].sort(
    (left, right) => right.length - left.length,
  );
  const pattern = new RegExp(`(${distinct.map(escapeRegExp).join('|')})`, 'gi');
  return text.replace(pattern, '[$1]');
}

interface FileAggregate {
  repositoryId: string;
  path: string;
  first: RepositoryMatch;
  count: number;
}

export function repositoryEntriesFrom(
  matches: RepositoryMatch[],
  terms: string[],
): SearchResultEntry[] {
  const files = new Map<string, FileAggregate>();
  for (const match of matches) {
    const key = `${match.repositoryId}:${match.path}`;
    const file = files.get(key);
    if (file === undefined) {
      files.set(key, {
        repositoryId: match.repositoryId,
        path: match.path,
        first: match,
        count: 1,
      });
      continue;
    }
    file.count += 1;
  }
  const entries: SearchResultEntry[] = [...files.values()].map((file) => ({
    source: 'repository',
    kind: 'repository',
    path: file.path,
    repositoryId: file.repositoryId,
    title: titleOfPath(file.path),
    snippet: markTerms(file.first.text, terms),
    lineStart: file.first.line,
    lineEnd: file.first.line,
    matchCount: file.count,
  }));
  entries.sort(compareRepositoryEntries);
  return entries;
}

export function mergeResults(
  workspaceEntries: SearchResultEntry[],
  repositoryEntries: SearchResultEntry[],
  limit?: number,
  offset?: number,
): ResultPage {
  const merged = [...workspaceEntries, ...repositoryEntries];
  const pageLimit = normalizedLimit(limit);
  const pageOffset = normalizedOffset(offset);
  const results = merged.slice(pageOffset, pageOffset + pageLimit);
  const totalResults = merged.length;
  const returnedResults = results.length;
  return {
    results,
    totalResults,
    returnedResults,
    limit: pageLimit,
    offset: pageOffset,
    hasMore: totalResults > pageOffset + returnedResults,
  };
}

export async function lexicalSearch(
  root: string,
  options: LexicalSearchOptions,
): Promise<LexicalSearchOutcome> {
  const startedAt = Date.now();
  const scope: LexicalScope = options.scope ?? { kind: 'workspace' };
  const terms = queryTerms(options.query);
  const searchScope: SearchScope =
    scope.kind === 'project'
      ? { kind: 'project', projectId: scope.project }
      : { kind: 'workspace' };
  const refresh = await refreshIndex(root);
  const found = await searchIndex(root, options.query, searchScope);
  const workspaceEntries = await Promise.all(
    found.hits.map((hit) => workspaceEntry(root, hit, terms)),
  );
  const repositories =
    scope.kind === 'project'
      ? await searchRepositories(root, options.query, {
          repositories: projectRepositories(root, scope.project),
        })
      : await searchRepositories(root, options.query);
  const repositoryEntries = repositoryEntriesFrom(repositories.matches, terms);
  const page = mergeResults(
    workspaceEntries,
    repositoryEntries,
    options.limit,
    options.offset,
  );
  const diagnostics = dedupeDiagnostics([
    ...refresh.diagnostics,
    ...found.diagnostics,
    ...repositories.diagnostics,
  ]);
  const data: LexicalSearchData = {
    query: options.query,
    scope,
    results: page.results,
    totalResults: page.totalResults,
    returnedResults: page.returnedResults,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
    durationMs: Date.now() - startedAt,
    index: await indexStatus(refresh.indexPath, refresh.counts),
    diagnostics,
  };
  return {
    ok: !isOperationalFailure(diagnostics, true),
    data,
    diagnostics,
  };
}

function projectRepositories(root: string, projectId: string): string[] {
  const database = openDatabase(indexPath(root), { readonly: true });
  try {
    return repositoryIdsForProject(database, projectId);
  } finally {
    database.close();
  }
}

async function workspaceEntry(
  root: string,
  hit: SearchHit,
  terms: string[],
): Promise<SearchResultEntry> {
  const entry: SearchResultEntry = {
    source: 'workspace',
    kind: hit.type ?? 'document',
    path: hit.path,
    title: hit.title ?? titleOfPath(hit.path),
    snippet: hit.snippet,
    matchCount: 0,
  };
  if (hit.objectId !== null) entry.objectId = hit.objectId;
  const scan = await scanWorkspaceFile(root, hit.path, terms);
  if (scan === null) return entry;
  entry.matchCount = scan.matchCount;
  if (scan.firstLine !== null) {
    entry.lineStart = scan.firstLine;
    entry.lineEnd = scan.firstLine;
  }
  return entry;
}

interface LineScan {
  firstLine: number | null;
  matchCount: number;
}

async function scanWorkspaceFile(
  root: string,
  storedPath: string,
  terms: string[],
): Promise<LineScan | null> {
  if (terms.length === 0) return null;
  const file = path.resolve(root, ...storedPath.split('/'));
  let content: string;
  try {
    const stats = await stat(file);
    if (stats.size > ENRICH_MAX_FILE_BYTES) return null;
    content = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  const needles = terms.map((term) => term.toLowerCase());
  const lines = content.split(/\r?\n/).slice(0, ENRICH_MAX_LINES);
  let firstLine: number | null = null;
  let matchCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').toLowerCase();
    if (!needles.some((term) => line.includes(term))) continue;
    if (firstLine === null) firstLine = index + 1;
    matchCount += 1;
    if (matchCount === MAX_LINE_MATCHES) break;
  }
  return { firstLine, matchCount };
}

async function indexStatus(
  target: string,
  counts: IndexCounts,
): Promise<LexicalIndexStatus> {
  try {
    const stats = await stat(target);
    return { path: target, modifiedAt: stats.mtime.toISOString(), counts };
  } catch {
    return { path: target, modifiedAt: UNKNOWN_MODIFIED_AT, counts };
  }
}

function titleOfPath(storedPath: string): string {
  const base = storedPath.split('/').pop() ?? storedPath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function compareRepositoryEntries(
  left: SearchResultEntry,
  right: SearchResultEntry,
): number {
  if (left.matchCount !== right.matchCount) {
    return right.matchCount - left.matchCount;
  }
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  const leftRepository = left.repositoryId ?? '';
  const rightRepository = right.repositoryId ?? '';
  if (leftRepository !== rightRepository) {
    return leftRepository < rightRepository ? -1 : 1;
  }
  return 0;
}

function normalizedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_RESULT_LIMIT;
  }
  return Math.min(
    MAX_RESULT_LIMIT,
    Math.max(MIN_RESULT_LIMIT, Math.floor(limit)),
  );
}

function normalizedOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
