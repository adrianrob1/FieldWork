import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { countRows, rebuildIndex } from '../../src/index/build.js';
import { openDatabase } from '../../src/index/database.js';
import { indexDirectory, indexPath } from '../../src/index/paths.js';
import { refreshIndex } from '../../src/index/refresh.js';
import type { IndexCounts } from '../../src/index/result.js';
import { searchIndex } from '../../src/index/search.js';
import {
  applyWatchBatch,
  startWorkspaceWatcher,
  type WatchBatchResult,
  type WatcherHandle,
  type WatcherOptions,
} from '../../src/watch/watcher.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: WatcherHandle[] = [];
const watcherTestTimeout = 20_000;

afterEach(async () => {
  await Promise.all(runningHandles.splice(0).map((handle) => handle.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-watch-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function copySampleWorkspaceUnderRepository(): Promise<string> {
  const root = await mkdtemp(
    path.join(repositoryRoot, '.fieldwork-watch-native-'),
  );
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function write(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function startTestWatcher(
  root: string,
  extra: Partial<WatcherOptions> = {},
): Promise<{ handle: WatcherHandle; batches: WatchBatchResult[] }> {
  const batches: WatchBatchResult[] = [];
  const handle = await startWorkspaceWatcher(root, {
    debounceMs: 25,
    awaitWriteFinish: { stabilityThresholdMs: 20, pollIntervalMs: 5 },
    polling: { usePolling: true, intervalMs: 20 },
    ...extra,
    onBatch: (batch) => {
      batches.push(batch);
    },
  });
  runningHandles.push(handle);
  return { handle, batches };
}

async function waitForCondition(
  description: string,
  condition: () => boolean,
): Promise<void> {
  await vi.waitFor(
    () => {
      if (!condition()) throw new Error(`not yet satisfied: ${description}`);
    },
    { timeout: 10_000, interval: 10 },
  );
}

async function waitForBatch(
  batches: WatchBatchResult[],
  description: string,
  predicate: (batch: WatchBatchResult) => boolean,
): Promise<WatchBatchResult> {
  await waitForCondition(description, () => batches.some(predicate));
  const found = batches.find(predicate);
  if (found === undefined) throw new Error(`batch disappeared: ${description}`);
  return found;
}

function indexCounts(root: string): IndexCounts {
  const database = openDatabase(indexPath(root), { readonly: true });
  try {
    return {
      files: countRows(database, 'files'),
      objects: countRows(database, 'objects'),
      references: countRows(database, '"references"'),
      repositories: countRows(database, 'repositories'),
      documents: countRows(database, 'documents_fts'),
    };
  } finally {
    database.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const baselineCounts: IndexCounts = {
  files: 18,
  objects: 17,
  references: 20,
  repositories: 2,
  documents: 17,
};

const newChatSource = [
  '---',
  'id: chat_new',
  'title: New chat',
  'created: 2026-09-03T10:00:00Z',
  'projects:',
  '  - project_soap_bubbles',
  '---',
  '',
  'A quartz lantern note.',
  '',
].join('\n');

describe('startWorkspaceWatcher', () => {
  it(
    'applies an added chat as a delta, not a full rebuild',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      expect(indexCounts(root)).toEqual(baselineCounts);

      await write(root, 'chats/2026-09-03-new-chat.md', newChatSource);

      const batch = await waitForBatch(
        batches,
        'add chat batch',
        (entry) =>
          entry.applied &&
          entry.paths.added.includes('chats/2026-09-03-new-chat.md'),
      );
      expect(batch.paths.changed).toEqual([]);
      expect(batch.paths.deleted).toEqual([]);
      expect(batch.diagnostics).toEqual([]);
      expect(indexCounts(root)).toEqual({
        files: 19,
        objects: 18,
        references: 21,
        repositories: 2,
        documents: 18,
      });
      const found = await searchIndex(root, 'quartz');
      expect(found.hits.map((hit) => hit.objectId)).toEqual(['chat_new']);
    },
    watcherTestTimeout,
  );

  it(
    'applies an edited chat without touching other rows',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const current = await readFile(
        path.join(root, ...chatPath.split('/')),
        'utf8',
      );

      await write(
        root,
        chatPath,
        current.replace('became the basis', 'became the zephyr basis'),
      );

      const batch = await waitForBatch(
        batches,
        'change chat batch',
        (entry) => entry.applied && entry.paths.changed.includes(chatPath),
      );
      expect(batch.paths.added).toEqual([]);
      expect(batch.paths.deleted).toEqual([]);
      expect(indexCounts(root)).toEqual(baselineCounts);
      const changed = await searchIndex(root, 'zephyr');
      expect(changed.hits).toHaveLength(1);
      expect(changed.hits[0]?.path).toBe(chatPath);
      expect(changed.hits[0]?.objectId).toBe('chat_rank_diagnostics');
    },
    watcherTestTimeout,
  );

  it(
    'applies a deleted chat so its rows disappear',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      const chatPath = 'chats/2026-09-02-shared-curvature.md';

      await rm(path.join(root, ...chatPath.split('/')));

      await waitForBatch(
        batches,
        'delete chat batch',
        (entry) => entry.applied && entry.paths.deleted.includes(chatPath),
      );
      const counts = indexCounts(root);
      expect(counts.files).toBe(17);
      expect(counts.objects).toBe(16);
      expect(counts.documents).toBe(16);
      const database = openDatabase(indexPath(root), { readonly: true });
      expect(
        database.get<{ source: string }>(
          'SELECT source FROM "references" WHERE source = ?',
          'chat_shared_curvature',
        ),
      ).toBeUndefined();
      database.close();
      const removed = await searchIndex(root, 'curvature');
      expect(
        removed.hits.some((hit) => hit.path.includes('shared-curvature')),
      ).toBe(false);
    },
    watcherTestTimeout,
  );

  it(
    'treats a rename as delete of the old path and discovery of the new while keeping the stable id',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      const oldPath = 'chats/2026-09-02-shared-curvature.md';
      const newPath = 'chats/2026-09-02-curvature-renamed.md';

      await rename(
        path.join(root, ...oldPath.split('/')),
        path.join(root, ...newPath.split('/')),
      );

      await waitForCondition(
        'rename batches',
        () =>
          batches.some((entry) => entry.paths.deleted.includes(oldPath)) &&
          batches.some((entry) => entry.paths.added.includes(newPath)),
      );
      const counts = indexCounts(root);
      expect(counts.files).toBe(18);
      expect(counts.objects).toBe(17);
      const database = openDatabase(indexPath(root), { readonly: true });
      expect(
        database.get<{ id: string }>(
          'SELECT id FROM objects WHERE path = ?',
          oldPath,
        ),
      ).toBeUndefined();
      expect(
        database.get<{ id: string }>(
          'SELECT id FROM objects WHERE path = ?',
          newPath,
        )?.id,
      ).toBe('chat_shared_curvature');
      database.close();
      const found = await searchIndex(root, 'curvature');
      const matching = found.hits.filter(
        (hit) => hit.objectId === 'chat_shared_curvature',
      );
      expect(matching).toHaveLength(1);
      expect(matching[0]?.path).toBe(newPath);
    },
    watcherTestTimeout,
  );

  it(
    'coalesces duplicate saves into exactly one batch application',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      const chatPath = 'chats/2026-09-03-duplicate.md';
      const source = newChatSource
        .replace('chat_new', 'chat_duplicate')
        .replace('quartz lantern', 'halide prism');

      await Promise.all([
        write(root, chatPath, source),
        write(root, chatPath, source),
        write(root, chatPath, source),
      ]);

      await waitForCondition('duplicate save batch', () =>
        batches.some((entry) => entry.paths.added.includes(chatPath)),
      );
      await sleep(500);
      const touching = batches.filter(
        (entry) =>
          entry.paths.added.includes(chatPath) ||
          entry.paths.changed.includes(chatPath) ||
          entry.paths.deleted.includes(chatPath),
      );
      expect(touching).toHaveLength(1);
      const database = openDatabase(indexPath(root), { readonly: true });
      expect(
        database.get<{ n: number }>(
          'SELECT count(*) AS n FROM objects WHERE id = ?',
          'chat_duplicate',
        )?.n,
      ).toBe(1);
      database.close();
      const found = await searchIndex(root, 'halide');
      expect(found.hits.map((hit) => hit.objectId)).toEqual(['chat_duplicate']);
    },
    watcherTestTimeout,
  );

  it(
    'reports a malformed file as a diagnostic and keeps applying later batches',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);
      const brokenPath = 'chats/2026-09-03-broken.md';
      await write(
        root,
        brokenPath,
        '---\nid: chat_broken\ntitle: [unclosed\n---\n\nA broken note.\n',
      );

      const batch = await waitForBatch(
        batches,
        'malformed chat batch',
        (entry) => entry.paths.added.includes(brokenPath),
      );
      expect(batch.applied).toBe(true);
      expect(
        batch.diagnostics.some((entry) => entry.severity === 'error'),
      ).toBe(true);
      const counts = indexCounts(root);
      expect(counts.files).toBe(19);
      expect(counts.objects).toBe(17);

      const validPath = 'chats/2026-09-03-valid.md';
      await write(
        root,
        validPath,
        newChatSource
          .replace('chat_new', 'chat_valid')
          .replace('quartz lantern', 'opal beacon'),
      );
      await waitForBatch(
        batches,
        'valid chat batch after malformed file',
        (entry) => entry.applied && entry.paths.added.includes(validPath),
      );
      const found = await searchIndex(root, 'opal');
      expect(found.hits.map((hit) => hit.objectId)).toEqual(['chat_valid']);
    },
    watcherTestTimeout,
  );

  it(
    'rolls back a failed batch and heals with the next successful batch',
    async () => {
      const root = await copySampleWorkspace();
      let calls = 0;
      const { batches } = await startTestWatcher(root, {
        applyBatch: async (input) => {
          calls += 1;
          if (calls === 1) throw new Error('injected failure');
          return await applyWatchBatch(input);
        },
      });

      await write(
        root,
        'chats/2026-09-03-first.md',
        newChatSource
          .replace('chat_new', 'chat_first')
          .replace('quartz lantern', 'firstmarker'),
      );
      const failed = await waitForBatch(
        batches,
        'rolled back batch',
        (entry) => !entry.applied,
      );
      expect(
        failed.diagnostics.some(
          (entry) =>
            entry.code === 'watch.batch_failed' && entry.severity === 'error',
        ),
      ).toBe(true);
      expect(indexCounts(root)).toEqual(baselineCounts);
      expect((await searchIndex(root, 'firstmarker')).hits).toEqual([]);

      await write(
        root,
        'chats/2026-09-03-second.md',
        newChatSource
          .replace('chat_new', 'chat_second')
          .replace('quartz lantern', 'secondmarker'),
      );
      await waitForBatch(
        batches,
        'successful batch restoring consistency',
        (entry) =>
          entry.applied &&
          entry.paths.added.includes('chats/2026-09-03-second.md'),
      );
      expect(indexCounts(root)).toEqual({
        files: 20,
        objects: 19,
        references: 22,
        repositories: 2,
        documents: 19,
      });
      expect(
        (await searchIndex(root, 'firstmarker')).hits.map(
          (hit) => hit.objectId,
        ),
      ).toEqual(['chat_first']);
      expect(
        (await searchIndex(root, 'secondmarker')).hits.map(
          (hit) => hit.objectId,
        ),
      ).toEqual(['chat_second']);
    },
    watcherTestTimeout,
  );

  it(
    'stops cleanly, flushing pending changes and releasing all handles',
    async () => {
      const root = await copySampleWorkspace();
      const { handle } = await startTestWatcher(root);
      const chatPath = 'chats/2026-09-03-flushed.md';
      await write(
        root,
        chatPath,
        newChatSource
          .replace('chat_new', 'chat_flushed')
          .replace('quartz lantern', 'flushproof'),
      );

      await handle.stop();
      await handle.stop();

      const found = await searchIndex(root, 'flushproof');
      expect(found.hits.map((hit) => hit.objectId)).toEqual(['chat_flushed']);
      const renamed = path.join(indexDirectory(root), 'renamed.sqlite');
      await rename(indexPath(root), renamed);
      await rename(renamed, indexPath(root));
    },
    watcherTestTimeout,
  );

  it.runIf(process.platform === 'win32')(
    'delivers changes and releases native Windows watcher handles on stop',
    async () => {
      const root = await copySampleWorkspaceUnderRepository();
      const { handle, batches } = await startTestWatcher(root, {
        polling: { usePolling: false },
      });
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const current = await readFile(
        path.join(root, ...chatPath.split('/')),
        'utf8',
      );

      await write(
        root,
        chatPath,
        current.replace('became the basis', 'became the native basis'),
      );

      await waitForBatch(
        batches,
        'native Windows change batch',
        (entry) => entry.applied && entry.paths.changed.includes(chatPath),
      );
      expect(
        (await searchIndex(root, 'native')).hits.map((hit) => hit.objectId),
      ).toContain('chat_rank_diagnostics');

      await handle.stop();
      await handle.stop();

      const renamedRoot = `${root}-released`;
      temporaryDirectories.push(renamedRoot);
      await rename(root, renamedRoot);
      await rm(renamedRoot, { recursive: true });
    },
    watcherTestTimeout,
  );

  it(
    'ignores changes inside registered and archived repositories',
    async () => {
      const root = await copySampleWorkspace();
      const { batches } = await startTestWatcher(root);

      await write(
        root,
        'repositories/evon/README.md',
        'changed repository content\n',
      );
      await write(
        root,
        'repositories-archive/soap-bubbles/README.md',
        'changed archive content\n',
      );
      await sleep(500);
      expect(batches).toEqual([]);

      await write(
        root,
        'inbox/placeholder.md',
        [
          '---',
          'id: resource_placeholder',
          'title: Placeholder',
          '---',
          '',
          'repository watch probe',
          '',
        ].join('\n'),
      );
      await waitForBatch(
        batches,
        'canonical batch proving the watcher is alive',
        (entry) =>
          entry.applied && entry.paths.added.includes('inbox/placeholder.md'),
      );
      expect(batches).toHaveLength(1);
    },
    watcherTestTimeout,
  );
});

describe('index correctness without the watcher', () => {
  it('returns current metadata from refreshIndex when the watcher never ran', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);
    const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
    const current = await readFile(
      path.join(root, ...chatPath.split('/')),
      'utf8',
    );
    await write(
      root,
      chatPath,
      current.replace('became the basis', 'became the zephyr basis'),
    );

    const result = await refreshIndex(root);

    expect(result.rebuilt).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.counts).toEqual({
      files: 18,
      objects: 17,
      references: 20,
      repositories: 2,
      documents: 17,
    });
    const found = await searchIndex(root, 'zephyr');
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]?.path).toBe(chatPath);
  });
});
