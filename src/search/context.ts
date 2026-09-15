import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { openDatabase, type WorkspaceDatabase } from '../index/database.js';
import { indexPath } from '../index/paths.js';
import { refreshIndex } from '../index/refresh.js';
import {
  repositoryIdsForProject,
  searchRepositories,
} from '../index/repositories.js';
import { searchIndex, type SearchScope } from '../index/search.js';
import { dedupeDiagnostics, isOperationalFailure } from './outcome.js';
import {
  MAX_CONTEXT_FILES,
  scoreBranches,
  selectBranches,
  type BranchCandidate,
  type ScoreComponents,
  type ScoredBranch,
} from './routing.js';

export type ContextScope =
  | { kind: 'global' }
  | { kind: 'project'; projectId: string }
  | { kind: 'chat'; chatId: string };

export type ContextScopeView =
  | { kind: 'global' }
  | { kind: 'project'; project: string }
  | { kind: 'chat'; chat: string };

export interface SelectedBranch {
  id: string;
  title: string;
  kind: string | null;
  project: string | null;
  path: string;
  score: ScoreComponents;
}

export interface LineRange {
  start: number;
  end: number;
}

export interface FileScore {
  branch: number;
  text: number;
  total: number;
}

export interface ContextTrail {
  branch: string;
  route: 'summary' | 'source' | 'link' | 'project' | 'fts' | 'repository';
  via: string | null;
}

export interface ContextFile {
  path: string;
  objectId: string | null;
  type: string | null;
  repositoryId: string | null;
  content: string;
  contentTruncated: boolean;
  lineRanges: LineRange[];
  score: FileScore;
  trail: ContextTrail;
}

export interface ContextTimings {
  totalMs: number;
  refreshMs: number;
  routingMs: number;
  searchMs: number;
}

export interface ContextBundle {
  query: string;
  scope: ContextScopeView;
  selectedBranches: SelectedBranch[];
  files: ContextFile[];
  timings: ContextTimings;
}

export interface ContextOutcome {
  ok: boolean;
  bundle: ContextBundle | null;
  diagnostics: Diagnostic[];
}

interface SummaryEntry {
  id: string;
  title: string;
  path: string;
  kind: string | null;
  project: string | null;
  keywords: string[];
}

interface ObjectEntry {
  id: string;
  type: string;
  path: string;
}

interface RouteResult {
  selected: ScoredBranch[];
  projects: string[];
}

interface FileEntry extends ContextFile {
  priority: number;
  repositoryLines: number[];
}

const MAX_LINE_RANGES = 5;
export const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

export async function buildContext(
  root: string,
  query: string,
  scope: ContextScope = { kind: 'global' },
): Promise<ContextOutcome> {
  const started = performance.now();
  const workspaceRoot = path.resolve(root);
  const refresh = await refreshIndex(workspaceRoot);
  const refreshed = performance.now();
  const diagnostics: Diagnostic[] = [...refresh.diagnostics];
  if (isOperationalFailure(diagnostics, false)) {
    return {
      ok: false,
      bundle: null,
      diagnostics: dedupeDiagnostics(diagnostics),
    };
  }
  const database = openDatabase(indexPath(workspaceRoot), { readonly: true });
  try {
    const route = await routeQuery(
      database,
      workspaceRoot,
      query,
      scope,
      diagnostics,
    );
    const routed = performance.now();
    if (route === null) {
      return {
        ok: false,
        bundle: null,
        diagnostics: dedupeDiagnostics(diagnostics),
      };
    }
    const files = await gatherFiles(
      database,
      workspaceRoot,
      query,
      route,
      diagnostics,
    );
    const gathered = performance.now();
    return {
      ok: true,
      bundle: {
        query,
        scope: scopeView(scope),
        selectedBranches: route.selected.map(toSelectedBranch),
        files,
        timings: {
          refreshMs: millis(refreshed - started),
          routingMs: millis(routed - refreshed),
          searchMs: millis(gathered - routed),
          totalMs: millis(gathered - started),
        },
      },
      diagnostics: dedupeDiagnostics(diagnostics),
    };
  } finally {
    database.close();
  }
}

async function routeQuery(
  database: WorkspaceDatabase,
  root: string,
  query: string,
  scope: ContextScope,
  diagnostics: Diagnostic[],
): Promise<RouteResult | null> {
  const projects = resolveScopeProjects(database, root, scope, diagnostics);
  if (projects === null) return null;
  const candidates: BranchCandidate[] = [];
  for (const summary of loadSummaries(database)) {
    if (!isCandidate(summary, scope, projects)) continue;
    candidates.push(await toCandidate(database, query, summary, diagnostics));
  }
  const selected = selectBranches(scoreBranches(query, candidates));
  if (selected.length === 0) {
    diagnostics.push(
      diagnostic(
        root,
        'context.no_branch',
        'warning',
        `No summary branch matched the query above the relevance floor; returning an empty context bundle.`,
      ),
    );
  }
  return { selected, projects };
}

function resolveScopeProjects(
  database: WorkspaceDatabase,
  root: string,
  scope: ContextScope,
  diagnostics: Diagnostic[],
): string[] | null {
  if (scope.kind === 'global') return [];
  if (scope.kind === 'project') {
    if (getObject(database, scope.projectId, 'project') === null) {
      diagnostics.push(
        diagnostic(
          root,
          'project.missing',
          'error',
          `Project '${scope.projectId}' was not found in this workspace.`,
        ),
      );
      return null;
    }
    return [scope.projectId];
  }
  const chat = database.get<{ metadata: string }>(
    "SELECT metadata FROM objects WHERE id = ? AND type = 'chat'",
    scope.chatId,
  );
  if (chat === undefined) {
    diagnostics.push(
      diagnostic(
        root,
        'chat.missing',
        'error',
        `Chat '${scope.chatId}' was not found in this workspace.`,
      ),
    );
    return null;
  }
  return stringList(readMetadata(chat.metadata)?.projects).filter(
    (projectId) => getObject(database, projectId, 'project') !== null,
  );
}

function loadSummaries(database: WorkspaceDatabase): SummaryEntry[] {
  return database
    .all<{ id: string; title: string | null; path: string; metadata: string }>(
      "SELECT id, title, path, metadata FROM objects WHERE type = 'summary' ORDER BY id, path",
    )
    .map((row) => {
      const metadata = readMetadata(row.metadata);
      return {
        id: row.id,
        title: row.title ?? '',
        path: row.path,
        kind: typeof metadata?.kind === 'string' ? metadata.kind : null,
        project:
          typeof metadata?.project === 'string' ? metadata.project : null,
        keywords: stringList(metadata?.keywords),
      };
    });
}

function isCandidate(
  summary: SummaryEntry,
  scope: ContextScope,
  projects: string[],
): boolean {
  if (scope.kind === 'global') {
    return summary.kind === 'project' || summary.kind === 'topic';
  }
  if (summary.kind === 'root') return true;
  if (summary.kind !== 'project' && summary.kind !== 'area') return false;
  if (summary.project === null) return false;
  return scope.kind === 'project'
    ? summary.project === scope.projectId
    : projects.includes(summary.project);
}

async function toCandidate(
  database: WorkspaceDatabase,
  query: string,
  summary: SummaryEntry,
  diagnostics: Diagnostic[],
): Promise<BranchCandidate> {
  const topics =
    summary.kind === 'topic'
      ? [summary.id]
      : summary.project === null
        ? []
        : projectTopics(database, summary.project);
  const scoped = await searchIndex(database, query, {
    kind: 'path',
    prefix: summary.path,
  });
  diagnostics.push(...scoped.diagnostics);
  return {
    id: summary.id,
    title: summary.title,
    path: summary.path,
    kind: summary.kind,
    project: summary.project,
    keywords: summary.keywords,
    topics,
    ftsRank: scoped.hits[0]?.rank ?? null,
  };
}

async function gatherFiles(
  database: WorkspaceDatabase,
  root: string,
  query: string,
  route: RouteResult,
  diagnostics: Diagnostic[],
): Promise<ContextFile[]> {
  const entries = new Map<string, FileEntry>();
  for (const branch of route.selected) {
    await collectBranchFiles(
      database,
      query,
      branch,
      route.projects,
      entries,
      diagnostics,
    );
  }
  await collectRepositoryMatches(
    root,
    query,
    route,
    database,
    entries,
    diagnostics,
  );
  const ordered = [...entries.values()]
    .sort(compareFileEntries)
    .slice(0, MAX_CONTEXT_FILES);
  await fillFileDetails(database, root, query, ordered);
  return ordered.map((entry) => ({
    path: entry.path,
    objectId: entry.objectId,
    type: entry.type,
    repositoryId: entry.repositoryId,
    content: entry.content,
    contentTruncated: entry.contentTruncated,
    lineRanges: entry.lineRanges,
    score: entry.score,
    trail: entry.trail,
  }));
}

async function collectBranchFiles(
  database: WorkspaceDatabase,
  query: string,
  branch: ScoredBranch,
  projects: string[],
  entries: Map<string, FileEntry>,
  diagnostics: Diagnostic[],
): Promise<void> {
  addFile(entries, {
    path: branch.path,
    objectId: branch.id,
    type: 'summary',
    repositoryId: null,
    trail: { branch: branch.id, route: 'summary', via: null },
    branchScore: branch.score.total,
    text: branch.score.fts,
    repositoryLines: [],
  });
  const references = database.all<{ target: string; relation: string }>(
    'SELECT target, relation FROM "references" WHERE source = ? AND relation IN (?, ?) ORDER BY target, relation',
    branch.id,
    'source',
    'link',
  );
  for (const reference of references) {
    const target = getObject(database, reference.target);
    if (target === null) continue;
    if (reference.relation === 'link' && target.type === 'link') {
      const endpoints = database.all<{ target: string }>(
        'SELECT target FROM "references" WHERE source = ? AND relation IN (?, ?) ORDER BY target',
        target.id,
        'from',
        'to',
      );
      for (const endpoint of endpoints) {
        const object = getObject(database, endpoint.target);
        if (object === null || object.id === branch.id) continue;
        addFile(entries, {
          path: object.path,
          objectId: object.id,
          type: object.type,
          repositoryId: null,
          trail: { branch: branch.id, route: 'link', via: target.id },
          branchScore: branch.score.total,
          text: 0,
          repositoryLines: [],
        });
      }
      continue;
    }
    addFile(entries, {
      path: target.path,
      objectId: target.id,
      type: target.type,
      repositoryId: null,
      trail: {
        branch: branch.id,
        route: reference.relation === 'link' ? 'link' : 'source',
        via: target.id,
      },
      branchScore: branch.score.total,
      text: 0,
      repositoryLines: [],
    });
  }
  const manifest = effectiveProject(branch, projects);
  if (manifest !== null) {
    const object = getObject(database, manifest, 'project');
    if (object !== null) {
      addFile(entries, {
        path: object.path,
        objectId: object.id,
        type: object.type,
        repositoryId: null,
        trail: { branch: branch.id, route: 'project', via: manifest },
        branchScore: branch.score.total,
        text: 0,
        repositoryLines: [],
      });
    }
  }
  const hits = await searchIndex(
    database,
    query,
    branchScope(branch, projects),
  );
  diagnostics.push(...hits.diagnostics);
  for (const hit of hits.hits) {
    addFile(entries, {
      path: hit.path,
      objectId: hit.objectId,
      type: hit.type,
      repositoryId: null,
      trail: { branch: branch.id, route: 'fts', via: null },
      branchScore: branch.score.total,
      text: round(10 / (1 + Math.abs(hit.rank))),
      repositoryLines: [],
    });
  }
}

async function collectRepositoryMatches(
  root: string,
  query: string,
  route: RouteResult,
  database: WorkspaceDatabase,
  entries: Map<string, FileEntry>,
  diagnostics: Diagnostic[],
): Promise<void> {
  const owners = new Map<string, ScoredBranch>();
  for (const branch of route.selected) {
    const projectId = effectiveProject(branch, route.projects);
    if (projectId === null || owners.has(projectId)) continue;
    owners.set(projectId, branch);
  }
  if (owners.size === 0) return;
  const repositories = new Map<string, ScoredBranch>();
  for (const [projectId, branch] of owners) {
    for (const repositoryId of repositoryIdsForProject(database, projectId)) {
      repositories.set(repositoryId, branch);
    }
  }
  if (repositories.size === 0) return;
  const result = await searchRepositories(root, query, {
    repositories: [...repositories.keys()],
  });
  diagnostics.push(...result.diagnostics);
  for (const match of result.matches) {
    const branch = repositories.get(match.repositoryId);
    if (branch === undefined) continue;
    addFile(entries, {
      path: match.path,
      objectId: null,
      type: null,
      repositoryId: match.repositoryId,
      trail: {
        branch: branch.id,
        route: 'repository',
        via: match.repositoryId,
      },
      branchScore: branch.score.total,
      text: 1,
      repositoryLines: [match.line],
    });
  }
}

interface FileInput {
  path: string;
  objectId: string | null;
  type: string | null;
  repositoryId: string | null;
  trail: ContextTrail;
  branchScore: number;
  text: number;
  repositoryLines: number[];
}

function addFile(entries: Map<string, FileEntry>, input: FileInput): void {
  const branch = round(input.branchScore);
  const total = round(branch + input.text);
  const key =
    input.repositoryId === null
      ? `workspace:${input.path}`
      : `repository:${input.repositoryId}:${input.path}`;
  const priority = routePriority(input.trail.route);
  const existing = entries.get(key);
  if (existing === undefined) {
    entries.set(key, {
      path: input.path,
      objectId: input.objectId,
      type: input.type,
      repositoryId: input.repositoryId,
      content: '',
      contentTruncated: false,
      trail: input.trail,
      lineRanges: [],
      score: { branch, text: round(input.text), total },
      priority,
      repositoryLines: [...input.repositoryLines],
    });
    return;
  }
  if (total > existing.score.total) {
    existing.score = { branch, text: round(input.text), total };
  }
  if (priority < existing.priority) {
    existing.trail = input.trail;
    existing.priority = priority;
    if (existing.objectId === null) existing.objectId = input.objectId;
    if (existing.type === null) existing.type = input.type;
  }
  for (const line of input.repositoryLines) {
    if (!existing.repositoryLines.includes(line)) {
      existing.repositoryLines.push(line);
    }
  }
}

function routePriority(route: ContextTrail['route']): number {
  switch (route) {
    case 'summary':
      return 0;
    case 'source':
      return 1;
    case 'link':
      return 2;
    case 'project':
      return 3;
    case 'fts':
      return 4;
    case 'repository':
      return 5;
  }
}

function compareFileEntries(left: FileEntry, right: FileEntry): number {
  if (left.score.total !== right.score.total) {
    return right.score.total - left.score.total;
  }
  if (left.priority !== right.priority) return left.priority - right.priority;
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  const leftRepository = left.repositoryId ?? '';
  const rightRepository = right.repositoryId ?? '';
  if (leftRepository !== rightRepository) {
    return leftRepository < rightRepository ? -1 : 1;
  }
  return 0;
}

async function fillFileDetails(
  database: WorkspaceDatabase,
  root: string,
  query: string,
  entries: FileEntry[],
): Promise<void> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  for (const entry of entries) {
    const absolute = absoluteFilePath(database, root, entry);
    let source: Buffer;
    try {
      source = await readFile(absolute);
    } catch {
      continue;
    }
    const bounded = boundedUtf8Content(source);
    entry.content = bounded.content;
    entry.contentTruncated = bounded.truncated;
    if (entry.repositoryId !== null) {
      entry.repositoryLines.sort((a, b) => a - b);
      entry.lineRanges = entry.repositoryLines.map((line) => ({
        start: line,
        end: line,
      }));
      continue;
    }
    entry.lineRanges = scanLines(source.toString('utf8'), terms);
  }
}

function absoluteFilePath(
  database: WorkspaceDatabase,
  root: string,
  entry: FileEntry,
): string {
  if (entry.repositoryId === null) {
    return path.resolve(root, entry.path.split('/').join(path.sep));
  }
  const repository = database.get<{ path: string }>(
    'SELECT path FROM repositories WHERE id = ?',
    entry.repositoryId,
  );
  return path.resolve(
    repository?.path ?? root,
    entry.path.split('/').join(path.sep),
  );
}

function boundedUtf8Content(source: Buffer): {
  content: string;
  truncated: boolean;
} {
  if (source.byteLength <= MAX_CONTEXT_FILE_BYTES) {
    return { content: source.toString('utf8'), truncated: false };
  }
  let content = new StringDecoder('utf8').write(
    source.subarray(0, MAX_CONTEXT_FILE_BYTES),
  );
  while (Buffer.byteLength(content, 'utf8') > MAX_CONTEXT_FILE_BYTES) {
    content = content.slice(0, -1);
  }
  return { content, truncated: true };
}

function scanLines(source: string, terms: string[]): LineRange[] {
  if (terms.length === 0) return [];
  const ranges: LineRange[] = [];
  const lines = source.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (ranges.length >= MAX_LINE_RANGES) break;
    const lowered = line.toLowerCase();
    if (terms.some((term) => lowered.includes(term))) {
      ranges.push({ start: index + 1, end: index + 1 });
    }
  }
  return ranges;
}

function effectiveProject(
  branch: ScoredBranch,
  projects: string[],
): string | null {
  return branch.project ?? projects[0] ?? null;
}

function branchScope(branch: ScoredBranch, projects: string[]): SearchScope {
  if (branch.project !== null) {
    return { kind: 'project', projectId: branch.project };
  }
  if (branch.kind === 'topic') {
    return { kind: 'topic', topic: branch.id };
  }
  const fallback = projects[0];
  return fallback === undefined
    ? { kind: 'workspace' }
    : { kind: 'project', projectId: fallback };
}

function projectTopics(
  database: WorkspaceDatabase,
  projectId: string,
): string[] {
  const row = database.get<{ metadata: string }>(
    "SELECT metadata FROM objects WHERE id = ? AND type = 'project'",
    projectId,
  );
  return row === undefined
    ? []
    : stringList(readMetadata(row.metadata)?.topics);
}

function getObject(
  database: WorkspaceDatabase,
  id: string,
  type?: string,
): ObjectEntry | null {
  const row =
    type === undefined
      ? database.get<{ id: string; type: string; path: string }>(
          'SELECT id, type, path FROM objects WHERE id = ?',
          id,
        )
      : database.get<{ id: string; type: string; path: string }>(
          'SELECT id, type, path FROM objects WHERE id = ? AND type = ?',
          id,
          type,
        );
  return row === undefined ? null : row;
}

function toSelectedBranch(branch: ScoredBranch): SelectedBranch {
  return {
    id: branch.id,
    title: branch.title,
    kind: branch.kind,
    project: branch.project,
    path: branch.path,
    score: branch.score,
  };
}

function scopeView(scope: ContextScope): ContextScopeView {
  switch (scope.kind) {
    case 'project':
      return { kind: 'project', project: scope.projectId };
    case 'chat':
      return { kind: 'chat', chat: scope.chatId };
    default:
      return { kind: 'global' };
  }
}

function readMetadata(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function millis(value: number): number {
  return Math.round(value * 1000) / 1000;
}
