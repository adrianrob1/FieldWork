import { stat } from 'node:fs/promises';
import path from 'node:path';

import { watch } from 'chokidar';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  discoverWorkspaceFiles,
  parseWorkspace,
  parseWorkspaceFile,
  type DiscoveredWorkspaceFile,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { openDatabase, type WorkspaceDatabase } from '../index/database.js';
import { fileExists, indexDirectory, indexPath } from '../index/paths.js';
import { refreshIndex } from '../index/refresh.js';
import type { IndexResult } from '../index/result.js';
import {
  buildFileRows,
  buildReferenceRows,
  canonicalPath,
  deleteFileRows,
  fingerprint,
  insertDocumentRow,
  insertFileRows,
  insertReferenceRows,
  insertRepositoryRows,
  knownIdsFromIndex,
  type FileFingerprint,
  type FileRows,
  type ReferenceRow,
} from '../index/rows.js';

export interface WatchBatchPaths {
  added: string[];
  changed: string[];
  deleted: string[];
}

export interface WatchBatchResult {
  applied: boolean;
  paths: WatchBatchPaths;
  diagnostics: Diagnostic[];
}

export interface WatchBatchInput {
  root: string;
  database: WorkspaceDatabase;
  upserts: DiscoveredWorkspaceFile[];
  removals: string[];
}

export type WatchBatchApplier = (
  input: WatchBatchInput,
) => Promise<WatchBatchResult>;

export interface AwaitWriteFinishOptions {
  stabilityThresholdMs?: number;
  pollIntervalMs?: number;
}

export interface WatcherPollingOptions {
  usePolling?: boolean;
  intervalMs?: number;
}

export interface WatcherOptions {
  debounceMs?: number;
  awaitWriteFinish?: AwaitWriteFinishOptions;
  onBatch?: (batch: WatchBatchResult) => void | Promise<void>;
  applyBatch?: WatchBatchApplier;
  polling?: WatcherPollingOptions;
}

export interface WatcherHandle {
  readonly root: string;
  readonly scan: IndexResult;
  stop(): Promise<void>;
}

interface ReparsedFile {
  file: ParsedWorkspaceFile;
  canonical: string;
  print: FileFingerprint;
  rows: FileRows;
}

interface PendingEvents {
  upserts: Set<string>;
  removals: Set<string>;
  dirUpserts: Set<string>;
  dirRemovals: Set<string>;
  retried: boolean;
}

const defaultDebounceMs = 150;
const defaultStabilityThresholdMs = 75;
const defaultPollIntervalMs = 25;
const stopSettleMs = 50;

const areaPathDefaults: Record<string, string> = {
  projects: 'projects',
  chats: 'chats',
  topics: 'topics',
  tasks: 'tasks',
  inbox: 'inbox',
  external: 'external',
};

export async function applyWatchBatch(
  input: WatchBatchInput,
): Promise<WatchBatchResult> {
  const { root, database, upserts, removals } = input;
  const diagnostics: Diagnostic[] = [];
  const effectiveRemovals = new Set(removals);
  const reparsed: ReparsedFile[] = [];
  for (const candidate of upserts) {
    const canonical = canonicalPath(root, candidate.file);
    if (!(await present(candidate.file))) {
      effectiveRemovals.add(canonical);
      continue;
    }
    const parsedFile = await parseWorkspaceFile(
      candidate.file,
      candidate.kind,
      candidate.area,
      root,
    );
    reparsed.push({
      file: parsedFile,
      canonical,
      print: await fingerprint(candidate.file),
      rows: buildFileRows(parsedFile, root, null),
    });
  }
  for (const item of reparsed) effectiveRemovals.delete(item.canonical);

  const prior = priorPaths(database, [
    ...effectiveRemovals,
    ...reparsed.map((item) => item.canonical),
  ]);
  const referenceRows: ReferenceRow[] = [];
  database.transaction(() => {
    for (const canonical of effectiveRemovals)
      deleteFileRows(database, canonical);
    for (const item of reparsed) deleteFileRows(database, item.canonical);
    for (const item of reparsed) {
      insertFileRows(
        database,
        item.canonical,
        item.file.area,
        item.print,
        item.rows,
      );
      insertRepositoryRows(database, item.rows.repositories);
      if (item.rows.document !== null) {
        insertDocumentRow(database, item.rows.document);
      }
    }
    const knownIds = knownIdsFromIndex(database);
    for (const item of reparsed) {
      if (item.rows.object === null) continue;
      referenceRows.push(
        ...buildReferenceRows(
          item.file,
          item.rows.object.id,
          knownIds,
          item.rows.diagnostics,
        ),
      );
    }
    insertReferenceRows(database, referenceRows);
  });
  for (const item of reparsed) {
    diagnostics.push(...item.file.diagnostics, ...item.rows.diagnostics);
  }
  const added: string[] = [];
  const changed: string[] = [];
  for (const item of reparsed) {
    (prior.has(item.canonical) ? changed : added).push(item.canonical);
  }
  const deleted = [...effectiveRemovals].filter((canonical) =>
    prior.has(canonical),
  );
  return {
    applied: true,
    paths: {
      added: added.sort(),
      changed: changed.sort(),
      deleted: deleted.sort(),
    },
    diagnostics,
  };
}

export async function startWorkspaceWatcher(
  root: string,
  options: WatcherOptions = {},
): Promise<WatcherHandle> {
  const workspaceRoot = path.resolve(root);
  const debounceMs = options.debounceMs ?? defaultDebounceMs;
  const stabilityThreshold =
    options.awaitWriteFinish?.stabilityThresholdMs ??
    defaultStabilityThresholdMs;
  const pollInterval =
    options.awaitWriteFinish?.pollIntervalMs ?? defaultPollIntervalMs;
  const applier = options.applyBatch ?? applyWatchBatch;

  const scan = await refreshIndex(workspaceRoot);
  const targets = await watchTargets(workspaceRoot);
  const repositoryRoots = await registeredRepositoryRoots(workspaceRoot);
  const database = openDatabase(indexPath(workspaceRoot));

  let pending = emptyPending(false);
  let retry: PendingEvents | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();
  let accepting = true;
  let stopPromise: Promise<void> | null = null;
  const graceMs = stabilityThreshold + pollInterval * 2 + 50;

  const fsWatcher = watch(targets, {
    ignoreInitial: true,
    usePolling: options.polling?.usePolling ?? false,
    interval: options.polling?.intervalMs ?? 100,
    ignored: (candidate) => {
      const resolved = path.resolve(candidate);
      if (containsPath(indexDirectory(workspaceRoot), resolved)) return true;
      return repositoryRoots.some((repository) =>
        containsPath(repository, resolved),
      );
    },
    awaitWriteFinish: { stabilityThreshold, pollInterval },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: unknown): void => {
        fsWatcher.off('ready', onReady);
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const onReady = (): void => {
        fsWatcher.off('error', onError);
        resolve();
      };
      fsWatcher.once('error', onError);
      fsWatcher.once('ready', onReady);
    });
  } catch (error) {
    database.close();
    await fsWatcher.close();
    throw error;
  }
  fsWatcher.on('error', () => undefined);

  fsWatcher.on('add', (file) => {
    recordUpsert(file);
  });
  fsWatcher.on('change', (file) => {
    recordUpsert(file);
  });
  fsWatcher.on('unlink', (file) => {
    recordRemoval(file);
  });
  fsWatcher.on('addDir', (directory) => {
    recordDirUpsert(directory);
  });
  fsWatcher.on('unlinkDir', (directory) => {
    recordDirRemoval(directory);
  });

  function recordUpsert(file: string): void {
    if (!accepting) return;
    const resolved = path.resolve(file);
    pending.removals.delete(resolved);
    pending.upserts.add(resolved);
    schedule();
  }

  function recordRemoval(file: string): void {
    if (!accepting) return;
    const resolved = path.resolve(file);
    pending.upserts.delete(resolved);
    pending.removals.add(resolved);
    schedule();
  }

  function recordDirUpsert(directory: string): void {
    if (!accepting) return;
    const resolved = path.resolve(directory);
    pending.dirRemovals.delete(resolved);
    pending.dirUpserts.add(resolved);
    schedule();
  }

  function recordDirRemoval(directory: string): void {
    if (!accepting) return;
    const resolved = path.resolve(directory);
    pending.dirUpserts.delete(resolved);
    pending.dirRemovals.add(resolved);
    schedule();
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      chain = chain.then(() => drain());
    }, debounceMs);
  }

  async function drain(): Promise<void> {
    const fresh = pending;
    pending = emptyPending(false);
    const batch =
      retry === null ? fresh : { ...mergePending(retry, fresh), retried: true };
    retry = null;
    if (!hasEvents(batch)) return;

    const discovery = await discoverWorkspaceFiles(workspaceRoot);
    const candidates = new Map<string, DiscoveredWorkspaceFile>();
    for (const file of discovery.files) {
      candidates.set(path.resolve(file.file), file);
    }
    if (discovery.settings !== null) {
      candidates.set(path.resolve(discovery.settings.file), {
        file: discovery.settings.file,
        kind: 'workspace',
        area: discovery.settings.area,
      });
    }

    const upserts: DiscoveredWorkspaceFile[] = [];
    const seen = new Set<string>();
    const include = (file: string): void => {
      const resolved = path.resolve(file);
      const candidate = candidates.get(resolved);
      if (candidate === undefined || seen.has(resolved)) return;
      seen.add(resolved);
      upserts.push(candidate);
    };
    for (const file of batch.upserts) include(file);
    for (const directory of batch.dirUpserts) {
      for (const file of candidates.keys()) {
        if (containsPath(directory, file)) include(file);
      }
    }

    const removals = new Set<string>();
    for (const file of batch.removals) {
      removals.add(canonicalPath(workspaceRoot, file));
    }
    if (batch.dirRemovals.size > 0) {
      const rows = database.all<{ path: string }>('SELECT path FROM files');
      for (const row of rows) {
        const absolute = path.resolve(workspaceRoot, fromStored(row.path));
        for (const directory of batch.dirRemovals) {
          if (containsPath(directory, absolute)) removals.add(row.path);
        }
      }
    }
    for (const candidate of upserts) {
      removals.delete(canonicalPath(workspaceRoot, candidate.file));
    }
    const indexed = new Set(
      database
        .all<{ path: string }>('SELECT path FROM files')
        .map((row) => row.path),
    );
    for (const canonical of [...removals]) {
      if (!indexed.has(canonical)) removals.delete(canonical);
    }
    if (upserts.length === 0 && removals.size === 0) return;

    let result: WatchBatchResult;
    try {
      result = await applier({
        root: workspaceRoot,
        database,
        upserts,
        removals: [...removals].sort(),
      });
    } catch (error) {
      result = {
        applied: false,
        paths: { added: [], changed: [], deleted: [] },
        diagnostics: [
          diagnostic(
            indexPath(workspaceRoot),
            'watch.batch_failed',
            'error',
            `The watch batch failed; its index changes were rolled back and will be retried with the next batch or a manual refresh: ${messageOf(error)}`,
          ),
        ],
      };
      if (!batch.retried) retry = batch;
    }
    const notify = options.onBatch;
    if (notify === undefined) return;
    await Promise.resolve()
      .then(() => notify(result))
      .catch(() => undefined);
  }

  function stop(): Promise<void> {
    if (stopPromise !== null) return stopPromise;
    stopPromise = stopGracefully();
    return stopPromise;
  }

  async function stopGracefully(): Promise<void> {
    await sleep(graceMs);
    accepting = false;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    chain = chain.then(() => drain());
    await chain;
    await fsWatcher.close();
    database.close();
    await sleep(stopSettleMs);
  }

  return { root: workspaceRoot, scan, stop };
}

async function watchTargets(workspaceRoot: string): Promise<string[]> {
  const targets: string[] = [];
  const seen = new Set<string>();
  const add = (target: string): void => {
    const resolved = path.resolve(target);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    targets.push(resolved);
  };
  const settingsFile = path.join(workspaceRoot, 'workspace.yml');
  add(settingsFile);
  add(path.join(workspaceRoot, 'README.md'));

  const configured: Record<string, string> = { ...areaPathDefaults };
  if (await fileExists(settingsFile)) {
    const settings = await parseWorkspaceFile(
      settingsFile,
      'workspace',
      'root',
      workspaceRoot,
    );
    const overrides = settings.metadata?.paths;
    if (isRecord(overrides)) {
      for (const key of Object.keys(areaPathDefaults)) {
        const value = overrides[key];
        if (typeof value === 'string') configured[key] = value;
      }
    }
  }
  for (const stored of Object.values(configured)) {
    if (stored.includes('\\') || path.isAbsolute(stored)) continue;
    const resolved = path.resolve(
      workspaceRoot,
      stored.split('/').join(path.sep),
    );
    if (!containsPath(workspaceRoot, resolved)) continue;
    add(resolved);
  }
  return targets;
}

async function registeredRepositoryRoots(
  workspaceRoot: string,
): Promise<string[]> {
  const parsed = await parseWorkspace(workspaceRoot);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const file of parsed.files) {
    if (file.kind !== 'project') continue;
    for (const resolution of file.resolvedPaths) {
      if (!/^repositories\.\d+\.path$/.test(resolution.fieldPath)) continue;
      const resolved = path.resolve(resolution.resolvedPath);
      if (!containsPath(workspaceRoot, resolved) || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      roots.push(resolved);
    }
  }
  return roots;
}

function emptyPending(retried: boolean): PendingEvents {
  return {
    upserts: new Set(),
    removals: new Set(),
    dirUpserts: new Set(),
    dirRemovals: new Set(),
    retried,
  };
}

function mergePending(
  base: PendingEvents,
  extra: PendingEvents,
): PendingEvents {
  for (const file of extra.upserts) {
    base.removals.delete(file);
    base.upserts.add(file);
  }
  for (const file of extra.removals) {
    base.upserts.delete(file);
    base.removals.add(file);
  }
  for (const directory of extra.dirUpserts) {
    base.dirRemovals.delete(directory);
    base.dirUpserts.add(directory);
  }
  for (const directory of extra.dirRemovals) {
    base.dirUpserts.delete(directory);
    base.dirRemovals.add(directory);
  }
  return base;
}

function hasEvents(batch: PendingEvents): boolean {
  return (
    batch.upserts.size +
      batch.removals.size +
      batch.dirUpserts.size +
      batch.dirRemovals.size >
    0
  );
}

function priorPaths(
  database: WorkspaceDatabase,
  candidates: string[],
): Set<string> {
  const indexed = new Set(
    database
      .all<{ path: string }>('SELECT path FROM files')
      .map((row) => row.path),
  );
  return new Set(candidates.filter((canonical) => indexed.has(canonical)));
}

function containsPath(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function fromStored(stored: string): string {
  return stored.split('/').join(path.sep);
}

async function present(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
