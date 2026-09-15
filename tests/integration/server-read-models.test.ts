import { cp, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import {
  chatApi,
  type ChatDetailViewData,
  type InboxViewData,
  type ProjectDetailView,
  type WorkspaceViewData,
} from '../../src/server/api.js';
import { startServer, type ServerHandle } from '../../src/server/server.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: ServerHandle[] = [];
const serverTestTimeout = 20_000;

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-read-models-'));
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

async function touch(
  root: string,
  relativePath: string,
  at: Date,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await utimes(file, at, at);
}

async function startTestServer(): Promise<{
  root: string;
  baseUrl: string;
}> {
  const root = await copySampleWorkspace();
  const handle = await startServer(root, {
    host: '127.0.0.1',
    port: 0,
    webAssetsDir: path.join(root, 'no-web-assets'),
  });
  runningHandles.push(handle);
  return { root, baseUrl: handle.url };
}

async function getJson(
  baseUrl: string,
  route: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`);
  const body: unknown = await response.json();
  return { status: response.status, body };
}

function apiCall(
  root: string,
  chatId: string,
  queryString: string,
): Promise<{ status: number; body: unknown }> {
  return chatApi(root, chatId, new URLSearchParams(queryString));
}

function longChatSource(count: number): string {
  const lines: string[] = [
    '---',
    'id: chat_long_window',
    'title: Long window chat',
    'created: 2026-09-12T00:00:00Z',
    '---',
    '',
    '# Long window chat',
    '',
  ];
  for (let index = 0; index < count; index += 1) {
    const tag = String(index).padStart(3, '0');
    lines.push('## user', '', `User message ${tag}.`, '');
    lines.push('## assistant', '', `Assistant reply ${tag}.`, '');
  }
  return lines.join('\n');
}

describe('windowed chat detail reads', () => {
  it(
    'returns the newest window by default without the raw body',
    async () => {
      const { root } = await startTestServer();
      await write(root, 'chats/2026-09-12-long-window.md', longChatSource(60));

      const response = await apiCall(root, 'chat_long_window', '');
      const data = response.body as ChatDetailViewData & {
        diagnostics: Diagnostic[];
      };

      expect(response.status).toBe(200);
      expect('body' in data).toBe(false);
      expect(data.messages).toHaveLength(50);
      expect(data.hasEarlier).toBe(true);
      expect(data.earlierCursor).toBe('70');
      expect(data.messages[0]?.text).toBe('User message 035.');
      expect(data.messages.at(-1)?.text).toBe('Assistant reply 059.');
      expect(data.messages[0]?.role).toBe('user');
      expect(data.messages.at(-1)?.role).toBe('assistant');
    },
    serverTestTimeout,
  );

  it(
    'serves the default window over HTTP with bounded messages',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(root, 'chats/2026-09-12-long-window.md', longChatSource(60));

      const { status, body } = await getJson(
        baseUrl,
        '/api/chats/chat_long_window',
      );
      const data = body as ChatDetailViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect('body' in data).toBe(false);
      expect(data.messages).toHaveLength(50);
      expect(data.hasEarlier).toBe(true);
      expect(data.earlierCursor).toBe('70');
    },
    serverTestTimeout,
  );

  it(
    'respects limit and clamps it to the allowed range',
    async () => {
      const { root } = await startTestServer();
      await write(root, 'chats/2026-09-12-long-window.md', longChatSource(60));

      const small = await apiCall(root, 'chat_long_window', 'limit=10');
      const smallData = small.body as ChatDetailViewData;
      expect(small.status).toBe(200);
      expect(smallData.messages).toHaveLength(10);
      expect(smallData.hasEarlier).toBe(true);
      expect(smallData.earlierCursor).toBe('110');
      expect(smallData.messages[0]?.text).toBe('User message 055.');

      const zero = await apiCall(root, 'chat_long_window', 'limit=0');
      const zeroData = zero.body as ChatDetailViewData;
      expect(zero.status).toBe(200);
      expect(zeroData.messages).toHaveLength(1);
      expect(zeroData.messages[0]?.text).toBe('Assistant reply 059.');
      expect(zeroData.hasEarlier).toBe(true);
      expect(zeroData.earlierCursor).toBe('119');

      const huge = await apiCall(root, 'chat_long_window', 'limit=500');
      const hugeData = huge.body as ChatDetailViewData;
      expect(huge.status).toBe(200);
      expect(hugeData.messages).toHaveLength(120);
      expect(hugeData.hasEarlier).toBe(false);
      expect('earlierCursor' in hugeData).toBe(false);
    },
    serverTestTimeout,
  );

  it(
    'walks earlier windows with the before cursor down to the start',
    async () => {
      const { root } = await startTestServer();
      await write(root, 'chats/2026-09-12-long-window.md', longChatSource(60));

      const newest = await apiCall(root, 'chat_long_window', '');
      const newestData = newest.body as ChatDetailViewData;
      expect(newestData.earlierCursor).toBe('70');

      const middle = await apiCall(
        root,
        'chat_long_window',
        `before=${newestData.earlierCursor ?? ''}`,
      );
      const middleData = middle.body as ChatDetailViewData;
      expect(middle.status).toBe(200);
      expect(middleData.messages).toHaveLength(50);
      expect(middleData.messages.at(-1)?.text).toBe('Assistant reply 034.');
      expect(middleData.hasEarlier).toBe(true);
      expect(middleData.earlierCursor).toBe('20');

      const first = await apiCall(
        root,
        'chat_long_window',
        `before=${middleData.earlierCursor ?? ''}`,
      );
      const firstData = first.body as ChatDetailViewData;
      expect(first.status).toBe(200);
      expect(firstData.messages).toHaveLength(20);
      expect(firstData.messages[0]?.text).toBe('User message 000.');
      expect(firstData.messages.at(-1)?.text).toBe('Assistant reply 009.');
      expect(firstData.hasEarlier).toBe(false);
      expect('earlierCursor' in firstData).toBe(false);

      const explicitLimit = await apiCall(
        root,
        'chat_long_window',
        'limit=5&before=20',
      );
      const explicitData = explicitLimit.body as ChatDetailViewData;
      expect(explicitData.messages).toHaveLength(5);
      expect(explicitData.messages[0]?.text).toBe('Assistant reply 007.');
      expect(explicitData.hasEarlier).toBe(true);
      expect(explicitData.earlierCursor).toBe('15');
    },
    serverTestTimeout,
  );

  it(
    'rejects malformed limit and before parameters with 400',
    async () => {
      const { root } = await startTestServer();
      await write(root, 'chats/2026-09-12-long-window.md', longChatSource(60));

      for (const queryString of [
        'limit=abc',
        'limit=-1',
        'limit=1.5',
        'before=abc',
        'before=-1',
        'before=1.5',
      ]) {
        const response = await apiCall(root, 'chat_long_window', queryString);
        expect(response.status, queryString).toBe(400);
        expect(
          typeof (response.body as { error: unknown }).error,
          queryString,
        ).toBe('string');
      }

      const missing = await apiCall(root, 'chat_nowhere', '');
      expect(missing.status).toBe(404);
      expect(
        (missing.body as { diagnostics: Diagnostic[] }).diagnostics[0]?.code,
      ).toBe('chat.missing');
    },
    serverTestTimeout,
  );

  it(
    'round-trips message metadata through the window',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/chats/chat_lab_agenda',
      );
      const data = body as ChatDetailViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect('body' in data).toBe(false);
      expect(data.messages).toHaveLength(2);
      expect(data.hasEarlier).toBe(false);
      expect('earlierCursor' in data).toBe(false);
      expect(data.messages[0]?.role).toBe('user');
      expect(data.messages[0]?.metadata).toBeNull();
      const metadata = data.messages[1]?.metadata as {
        provider?: string;
        model?: string;
        attachments?: { id: string; label: string }[];
      } | null;
      expect(metadata?.provider).toBe('openai');
      expect(metadata?.model).toBe('gpt-5.6');
      expect(metadata?.attachments?.[0]?.label).toBe('Scaling notes');
      expect(typeof data.contentHash).toBe('string');
    },
    serverTestTimeout,
  );
});

describe('workspace read model', () => {
  it(
    'reports validation counts, index state, storage, and recent activity',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(
        root,
        'chats/2026-09-03-broken.md',
        [
          '---',
          'id: chat_broken_reference',
          'title: Broken reference',
          'created: 2026-09-03T09:00:00Z',
          'projects:',
          '  - project_nowhere',
          '---',
          '',
          '# Broken reference',
          '',
        ].join('\n'),
      );

      const { status, body } = await getJson(baseUrl, '/api/workspace');
      const data = body as WorkspaceViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.title).toBe('Optimizer research sample');
      expect(data.counts.chat).toBe(4);
      expect(data.validation.errors).toBeGreaterThanOrEqual(1);
      expect(data.validation.warnings).toBeGreaterThanOrEqual(0);
      expect(
        data.diagnostics.some((entry) => entry.code === 'reference.missing'),
      ).toBe(true);

      expect(data.index.path.endsWith('index.sqlite')).toBe(true);
      expect(Number.isNaN(Date.parse(data.index.modifiedAt))).toBe(false);
      expect(data.index.counts.files).toBeGreaterThan(0);
      expect(data.index.counts.objects).toBeGreaterThan(0);
      expect(data.index.counts.references).toBeGreaterThan(0);
      expect(data.storage.indexBytes).toBeGreaterThan(0);
    },
    serverTestTimeout,
  );

  it(
    'lists at most ten recent activity entries, newest first',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const older = new Date(Date.now() + 60_000);
      const newer = new Date(Date.now() + 120_000);
      await write(
        root,
        'chats/2026-09-12-activity-a.md',
        [
          '---',
          'id: chat_activity_probe_a',
          'title: Activity probe A',
          'created: 2026-09-12T00:00:00Z',
          '---',
          '',
          '# Activity probe A',
          '',
        ].join('\n'),
      );
      await touch(root, 'chats/2026-09-12-activity-a.md', older);
      await write(
        root,
        'inbox/activity-b.md',
        [
          '---',
          'id: resource_activity_probe_b',
          'title: Activity probe B',
          'kind: note',
          '---',
          '',
          '# Activity probe B',
          '',
        ].join('\n'),
      );
      await touch(root, 'inbox/activity-b.md', newer);

      const { status, body } = await getJson(baseUrl, '/api/workspace');
      const data = body as WorkspaceViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.recentActivity.length).toBeLessThanOrEqual(10);
      for (let index = 1; index < data.recentActivity.length; index += 1) {
        const previous = data.recentActivity[index - 1];
        const current = data.recentActivity[index];
        expect(previous).toBeDefined();
        expect(current).toBeDefined();
        if (previous === undefined || current === undefined) continue;
        expect(
          Date.parse(previous.modifiedAt) >= Date.parse(current.modifiedAt),
        ).toBe(true);
      }
      const first = data.recentActivity[0];
      expect(first?.kind).toBe('resource');
      expect(first?.id).toBe('resource_activity_probe_b');
      expect(first?.title).toBe('Activity probe B');
      expect(first?.path).toBe('inbox/activity-b.md');
      expect(Date.parse(first?.modifiedAt ?? '')).toBe(newer.getTime());
      const second = data.recentActivity[1];
      expect(second?.kind).toBe('chat');
      expect(second?.id).toBe('chat_activity_probe_a');
      expect(second?.title).toBe('Activity probe A');
      expect(second?.path).toBe('chats/2026-09-12-activity-a.md');
      expect(Date.parse(second?.modifiedAt ?? '')).toBe(older.getTime());
    },
    serverTestTimeout,
  );
});

describe('project read model', () => {
  it(
    'reports chat counts, owned files, repositories, and inbound references',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const future = new Date(Date.now() + 300_000);
      await touch(
        root,
        'projects/evolutionary-optimization/context/posterior.md',
        future,
      );

      const { status, body } = await getJson(
        baseUrl,
        '/api/projects/project_evon',
      );
      const data = body as ProjectDetailView & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.chatCount).toBe(2);
      expect(data.chats.map((chat) => chat.id)).toEqual([
        'chat_rank_diagnostics',
        'chat_shared_curvature',
      ]);

      const ownedPaths = data.ownedFiles.map((file) => file.path);
      expect(ownedPaths).toContain(
        'projects/evolutionary-optimization/project.yml',
      );
      expect(ownedPaths).toContain(
        'projects/evolutionary-optimization/README.md',
      );
      expect(ownedPaths).toContain(
        'projects/evolutionary-optimization/context/posterior.md',
      );
      for (const file of data.ownedFiles) {
        expect(typeof file.kind).toBe('string');
        expect(file.sizeBytes).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(file.modifiedAt))).toBe(false);
      }
      const posterior = data.ownedFiles.find(
        (file) =>
          file.path ===
          'projects/evolutionary-optimization/context/posterior.md',
      );
      expect(posterior?.kind).toBe('resource');
      expect(posterior?.title).toBe('Posterior update notes');

      expect(Date.parse(data.lastActivity ?? '')).toBe(future.getTime());
      expect(data.repositories).toHaveLength(1);
      const repository = data.repositories[0];
      expect(repository?.id).toBe('resource_repo_evon');
      expect(repository?.path).not.toBeNull();
      expect(repository?.path?.includes('repositories')).toBe(true);
      expect(repository?.exists).toBe(true);
      expect('title' in (repository ?? {})).toBe(false);

      const inboundIds = data.inboundReferences.map(
        (reference) => reference.sourceId,
      );
      expect(inboundIds).toContain('chat_rank_diagnostics');
      expect(inboundIds).toContain('chat_shared_curvature');
      expect(inboundIds).toContain('task_baseline_notes');
      expect(inboundIds).toContain('summary_evon');
      expect(inboundIds).toContain('resource_evon_posterior');
      const task = data.inboundReferences.find(
        (reference) => reference.sourceId === 'task_baseline_notes',
      );
      expect(task?.sourceKind).toBe('task');
      expect(task?.relation).toBe('project');
      expect(task?.sourcePath).toBe('tasks/baseline-notes.md');
      expect(task?.updated).toBe('2026-09-02');
      const chat = data.inboundReferences.find(
        (reference) => reference.sourceId === 'chat_rank_diagnostics',
      );
      expect(chat?.sourceKind).toBe('chat');
      expect(chat?.relation).toBe('project');
      expect(chat?.sourcePath).toBe('chats/2026-09-02-rank-diagnostics.md');
      expect(chat?.updated).toBeUndefined();
      expect(
        data.inboundReferences.every(
          (reference) => typeof reference.sourceTitle === 'string',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'flags missing repository paths and resolves id-only repository entries',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(
        root,
        'projects/ghost/project.yml',
        [
          'id: project_ghost',
          'title: Ghost repository project',
          'repositories:',
          '  - id: resource_repo_ghost',
          '    path: ../../repositories/ghost',
        ].join('\n'),
      );
      await write(
        root,
        'projects/byref/project.yml',
        [
          'id: project_byref',
          'title: Repository by reference',
          'repositories:',
          '  - resource_repo_evon',
        ].join('\n'),
      );

      const ghost = await getJson(baseUrl, '/api/projects/project_ghost');
      const ghostData = ghost.body as ProjectDetailView;
      expect(ghost.status).toBe(200);
      expect(ghostData.chatCount).toBe(0);
      expect(ghostData.ownedFiles).toHaveLength(1);
      expect(ghostData.ownedFiles[0]?.path).toBe('projects/ghost/project.yml');
      expect(ghostData.ownedFiles[0]?.kind).toBe('project');
      expect(ghostData.repositories).toHaveLength(1);
      expect(ghostData.repositories[0]?.id).toBe('resource_repo_ghost');
      expect(ghostData.repositories[0]?.path).not.toBeNull();
      expect(ghostData.repositories[0]?.exists).toBe(false);
      expect(ghostData.lastActivity).not.toBeNull();

      const byref = await getJson(baseUrl, '/api/projects/project_byref');
      const byrefData = byref.body as ProjectDetailView;
      expect(byref.status).toBe(200);
      expect(byrefData.repositories).toHaveLength(1);
      expect(byrefData.repositories[0]?.id).toBe('resource_repo_evon');
      expect(byrefData.repositories[0]?.path).not.toBeNull();
      expect(byrefData.repositories[0]?.exists).toBe(true);
    },
    serverTestTimeout,
  );
});

describe('inbox read model', () => {
  it(
    'adds size, modification time, and a safe read URL to inbox files',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(
        root,
        'inbox/snapshot.md',
        [
          '---',
          'id: resource_snapshot',
          'title: Mirrored thread',
          'kind: snapshot',
          '---',
          '',
          '# Mirrored thread',
          '',
          'Thread body with substance.',
          '',
        ].join('\n'),
      );
      await write(root, 'inbox/notes.txt', 'plain text\n');

      const { status, body } = await getJson(baseUrl, '/api/inbox');
      const data = body as InboxViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      const snapshot = data.files.find(
        (file) => file.path === 'inbox/snapshot.md',
      );
      expect(snapshot?.sizeBytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(snapshot?.modifiedAt ?? ''))).toBe(false);
      expect(snapshot?.readUrl).toBe(
        `/api/file?path=${encodeURIComponent('inbox/snapshot.md')}`,
      );
      const raw = data.files.find((file) => file.path === 'inbox/notes.txt');
      expect(raw?.sizeBytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(raw?.modifiedAt ?? ''))).toBe(false);
      expect(raw?.readUrl).toBe(
        `/api/file?path=${encodeURIComponent('inbox/notes.txt')}`,
      );
      const keep = data.files.find((file) => file.path === 'inbox/.gitkeep');
      expect(keep?.sizeBytes).toBeGreaterThanOrEqual(0);
      expect(keep?.readUrl).toBe(
        `/api/file?path=${encodeURIComponent('inbox/.gitkeep')}`,
      );

      const readResponse = await fetch(`${baseUrl}${snapshot?.readUrl ?? ''}`);
      expect(readResponse.status).toBe(200);
      const readBody = (await readResponse.json()) as { body?: unknown };
      expect(String(readBody.body)).toContain('Thread body with substance.');
    },
    serverTestTimeout,
  );
});

describe('attachables picker endpoint', () => {
  interface AttachableEntry {
    id: string;
    kind: string;
    title: string;
    path: string;
    label: string;
  }

  interface AttachablesData {
    attachables: AttachableEntry[];
    total: number;
    returned: number;
    limit: number;
    hasMore: boolean;
  }

  it(
    'lists every attachable object kind ordered by kind then title',
    async () => {
      const { baseUrl } = await startTestServer();

      const { status, body } = await getJson(baseUrl, '/api/attachables');
      const data = body as AttachablesData;

      expect(status).toBe(200);
      expect(data.total).toBe(17);
      expect(data.returned).toBe(17);
      expect(data.hasMore).toBe(false);
      const kinds = [...new Set(data.attachables.map((entry) => entry.kind))];
      expect(kinds).toEqual(['task', 'resource', 'summary', 'chat', 'project']);
      const task = data.attachables.find(
        (entry) => entry.id === 'task_writers_room',
      );
      expect(task?.title).toBe(task?.label);
      expect(task?.label.includes('/')).toBe(false);
      expect(task?.path).toBe('tasks/writers-room.md');
    },
    serverTestTimeout,
  );

  it(
    'narrows by a title or id substring and by kinds',
    async () => {
      const { baseUrl } = await startTestServer();

      const search = await getJson(baseUrl, '/api/attachables?q=writers');
      const searchData = search.body as AttachablesData;
      expect(search.status).toBe(200);
      expect(searchData.total).toBe(1);
      expect(searchData.attachables[0]?.id).toBe('task_writers_room');

      const byId = await getJson(baseUrl, '/api/attachables?q=chat_lab');
      expect((byId.body as AttachablesData).attachables[0]?.id).toBe(
        'chat_lab_agenda',
      );

      const tasksOnly = await getJson(baseUrl, '/api/attachables?kinds=task');
      const tasksData = tasksOnly.body as AttachablesData;
      expect(tasksData.total).toBe(4);
      expect(
        tasksData.attachables.every((entry) => entry.kind === 'task'),
      ).toBe(true);

      const mixed = await getJson(baseUrl, '/api/attachables?kinds=task,chat');
      expect((mixed.body as AttachablesData).total).toBe(7);
    },
    serverTestTimeout,
  );

  it(
    'bounds the initial set and reports the remainder',
    async () => {
      const { baseUrl } = await startTestServer();

      const { status, body } = await getJson(
        baseUrl,
        '/api/attachables?limit=5',
      );
      const data = body as AttachablesData;

      expect(status).toBe(200);
      expect(data.returned).toBe(5);
      expect(data.limit).toBe(5);
      expect(data.total).toBe(17);
      expect(data.hasMore).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'rejects malformed limit and kinds parameters',
    async () => {
      const { baseUrl } = await startTestServer();

      const badLimit = await getJson(baseUrl, '/api/attachables?limit=abc');
      expect(badLimit.status).toBe(400);

      const badKinds = await getJson(baseUrl, '/api/attachables?kinds=bogus');
      expect(badKinds.status).toBe(400);
    },
    serverTestTimeout,
  );
});
