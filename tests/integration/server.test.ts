import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import type { ContextBundle } from '../../src/search/context.js';
import type { LexicalSearchData } from '../../src/search/lexical.js';
import type {
  ChatDetailViewData,
  ChatListEntry,
  InboxViewData,
  ProjectDetailView,
  ProjectListEntry,
  WorkspaceViewData,
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-server-'));
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

async function getHtml(
  baseUrl: string,
  route: string,
): Promise<{ status: number; contentType: string; html: string }> {
  const response = await fetch(`${baseUrl}${route}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    html: await response.text(),
  };
}

describe('JSON API', () => {
  it(
    'serves the workspace summary with counts and diagnostics',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(baseUrl, '/api/workspace');
      const data = body as WorkspaceViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.title).toBe('Optimizer research sample');
      expect(typeof data.root).toBe('string');
      expect(data.counts.workspace).toBe(1);
      expect(data.counts.project).toBe(3);
      expect(data.counts.chat).toBe(3);
      expect(Array.isArray(data.diagnostics)).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'lists projects with summaries, topics, paths, and repositories',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(baseUrl, '/api/projects');
      const data = body as {
        projects: ProjectListEntry[];
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.projects.map((project) => project.id)).toEqual([
        'project_evon',
        'project_posterior_diagnostics',
        'project_soap_bubbles',
      ]);
      const evon = data.projects[0];
      expect(evon?.title).toBe('Evolutionary optimization');
      expect(evon?.summary).toContain('variational');
      expect(evon?.topics).toEqual(['topic_preconditioning']);
      expect(evon?.path).toBe('projects/evolutionary-optimization/project.yml');
      expect(evon?.repositories).toHaveLength(1);
      expect(evon?.repositories[0]?.id).toBe('resource_repo_evon');
      expect(evon?.repositories[0]?.resolvedPath).not.toBeNull();
      expect(evon?.repositories[0]?.accessible).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'shows one project with attached chats, resources, and summary path',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/projects/project_evon',
      );
      const data = body as ProjectDetailView & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.id).toBe('project_evon');
      expect(data.path).toBe('projects/evolutionary-optimization/project.yml');
      expect(data.chats.map((chat) => chat.id)).toEqual([
        'chat_rank_diagnostics',
        'chat_shared_curvature',
      ]);
      expect(data.resources).toHaveLength(1);
      expect(data.resources[0]?.id).toBe('resource_evon_posterior');
      expect(data.resources[0]?.path).toBe(
        'projects/evolutionary-optimization/context/posterior.md',
      );
      expect(data.summaryDocument?.path).toBe(
        'projects/evolutionary-optimization/README.md',
      );
    },
    serverTestTimeout,
  );

  it(
    'returns 404 with a JSON error body for an unknown project',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/projects/project_nowhere',
      );
      const data = body as { error: string; diagnostics: Diagnostic[] };

      expect(status).toBe(404);
      expect(typeof data.error).toBe('string');
      expect(data.diagnostics[0]?.code).toBe('project.missing');
    },
    serverTestTimeout,
  );

  it(
    'lists chats with frontmatter fields and canonical paths',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(baseUrl, '/api/chats');
      const data = body as {
        filter: { kind: string };
        chats: ChatListEntry[];
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.filter.kind).toBe('all');
      expect(data.chats.map((chat) => chat.id)).toEqual([
        'chat_lab_agenda',
        'chat_rank_diagnostics',
        'chat_shared_curvature',
      ]);
      const chat = data.chats.find(
        (entry) => entry.id === 'chat_rank_diagnostics',
      );
      expect(chat?.title).toBe('Rank diagnostics');
      expect(chat?.created).toMatch(/^2026-09-02T10:00:00/);
      expect(chat?.projects).toEqual([
        'project_evon',
        'project_posterior_diagnostics',
      ]);
      expect(chat?.provider).toBe('local');
      expect(chat?.model).toBe('sample-model');
      expect(chat?.path).toBe('chats/2026-09-02-rank-diagnostics.md');
    },
    serverTestTimeout,
  );

  it(
    'filters chats by unassigned and project views',
    async () => {
      const { baseUrl, root } = await startTestServer();

      const unassignedBefore = await getJson(
        baseUrl,
        '/api/chats?view=unassigned',
      );
      expect(
        (unassignedBefore.body as { chats: ChatListEntry[] }).chats.map(
          (chat) => chat.id,
        ),
      ).toEqual(['chat_lab_agenda']);

      await write(
        root,
        'chats/spare.md',
        [
          '---',
          'id: chat_spare',
          'title: Spare notes',
          'created: 2026-09-03T08:00:00Z',
          '---',
          '',
          '# Spare notes',
          '',
        ].join('\n'),
      );

      const unassignedAfter = await getJson(
        baseUrl,
        '/api/chats?view=unassigned',
      );
      expect(
        (unassignedAfter.body as { chats: ChatListEntry[] }).chats.map(
          (chat) => chat.id,
        ),
      ).toEqual(['chat_lab_agenda', 'chat_spare']);

      const forEvon = await getJson(
        baseUrl,
        '/api/chats?view=project&project=project_evon',
      );
      expect(
        (forEvon.body as { chats: ChatListEntry[] }).chats.map(
          (chat) => chat.id,
        ),
      ).toEqual(['chat_rank_diagnostics', 'chat_shared_curvature']);

      const forSoap = await getJson(
        baseUrl,
        '/api/chats?view=project&project=project_soap_bubbles',
      );
      expect((forSoap.body as { chats: ChatListEntry[] }).chats).toEqual([]);

      const missingProject = await getJson(
        baseUrl,
        '/api/chats?view=project&project=project_nowhere',
      );
      expect(missingProject.status).toBe(404);
    },
    serverTestTimeout,
  );

  it(
    'rejects malformed chat list queries with 400',
    async () => {
      const { baseUrl } = await startTestServer();

      const unknownView = await getJson(baseUrl, '/api/chats?view=bogus');
      expect(unknownView.status).toBe(400);
      expect(typeof (unknownView.body as { error: unknown }).error).toBe(
        'string',
      );

      const missingProject = await getJson(baseUrl, '/api/chats?view=project');
      expect(missingProject.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'shows one chat with a windowed transcript and no raw body',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/chats/chat_rank_diagnostics',
      );
      const data = body as ChatDetailViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.id).toBe('chat_rank_diagnostics');
      expect(data.path).toBe('chats/2026-09-02-rank-diagnostics.md');
      expect('body' in data).toBe(false);
      expect(data.projects).toContain('project_evon');
      expect(Array.isArray(data.messages)).toBe(true);
      expect(data.hasEarlier).toBe(false);
      expect('earlierCursor' in data).toBe(false);
      expect(typeof data.contentHash).toBe('string');
    },
    serverTestTimeout,
  );

  it(
    'returns 404 for an unknown chat',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/chats/chat_nowhere',
      );

      expect(status).toBe(404);
      expect((body as { diagnostics: Diagnostic[] }).diagnostics[0]?.code).toBe(
        'chat.missing',
      );
    },
    serverTestTimeout,
  );

  it(
    'lists unassigned chats and inbox files, parseable or raw',
    async () => {
      const { baseUrl, root } = await startTestServer();

      const initial = await getJson(baseUrl, '/api/inbox');
      const initialData = initial.body as InboxViewData & {
        diagnostics: Diagnostic[];
      };
      expect(initial.status).toBe(200);
      expect(initialData.chats.map((chat) => chat.id)).toEqual([
        'chat_lab_agenda',
      ]);
      const rawEntry = initialData.files.find(
        (file) => file.path === 'inbox/.gitkeep',
      );
      expect(rawEntry).toBeDefined();
      expect(rawEntry?.id).toBeNull();
      expect(rawEntry?.kind).toBeNull();

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
        ].join('\n'),
      );
      await write(root, 'inbox/notes.txt', 'plain text\n');
      await write(
        root,
        'chats/spare.md',
        [
          '---',
          'id: chat_spare',
          'title: Spare notes',
          'created: 2026-09-03T08:00:00Z',
          '---',
          '',
          '# Spare notes',
          '',
        ].join('\n'),
      );

      const after = await getJson(baseUrl, '/api/inbox');
      const data = after.body as InboxViewData;
      expect(data.chats.map((chat) => chat.id)).toEqual([
        'chat_lab_agenda',
        'chat_spare',
      ]);
      const snapshot = data.files.find(
        (file) => file.path === 'inbox/snapshot.md',
      );
      expect(snapshot?.id).toBe('resource_snapshot');
      expect(snapshot?.title).toBe('Mirrored thread');
      expect(snapshot?.kind).toBe('resource');
      const raw = data.files.find((file) => file.path === 'inbox/notes.txt');
      expect(raw?.id).toBeNull();
      expect(raw?.kind).toBeNull();
    },
    serverTestTimeout,
  );

  it(
    'runs lexical search with scope and diagnostics',
    async () => {
      const { baseUrl } = await startTestServer();

      const workspace = await getJson(baseUrl, '/api/search?q=posterior');
      const data = workspace.body as LexicalSearchData & {
        diagnostics: Diagnostic[];
      };
      expect(workspace.status).toBe(200);
      expect(data.query).toBe('posterior');
      expect(data.scope).toEqual({ kind: 'workspace' });
      expect(data.results.length).toBeGreaterThan(0);
      for (const entry of data.results) {
        expect(typeof entry.path).toBe('string');
        expect(typeof entry.snippet).toBe('string');
        expect(typeof entry.title).toBe('string');
        expect(typeof entry.matchCount).toBe('number');
        expect(
          entry.source === 'workspace' || entry.source === 'repository',
        ).toBe(true);
      }
      expect(data.totalResults).toBeGreaterThanOrEqual(data.results.length);
      expect(data.returnedResults).toBe(data.results.length);
      expect(typeof data.limit).toBe('number');
      expect(data.offset).toBe(0);
      expect(typeof data.hasMore).toBe('boolean');
      expect(typeof data.durationMs).toBe('number');
      expect(typeof data.index.path).toBe('string');
      expect(typeof data.index.modifiedAt).toBe('string');
      expect(Array.isArray(data.diagnostics)).toBe(true);

      const project = await getJson(
        baseUrl,
        '/api/search?q=posterior&project=project_evon',
      );
      const scoped = project.body as LexicalSearchData;
      expect(scoped.scope).toEqual({
        kind: 'project',
        project: 'project_evon',
      });
      expect(scoped.results.length).toBeGreaterThan(0);

      const paged = await getJson(
        baseUrl,
        '/api/search?q=posterior&limit=2&offset=1',
      );
      const page = paged.body as LexicalSearchData;
      expect(paged.status).toBe(200);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(1);
      expect(page.results).toHaveLength(2);
      expect(page.returnedResults).toBe(2);
      expect(page.totalResults).toBeGreaterThanOrEqual(3);
      expect(page.hasMore).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'returns 400 for search without a query and 500 for an unknown project',
    async () => {
      const { baseUrl } = await startTestServer();

      const missing = await getJson(baseUrl, '/api/search');
      expect(missing.status).toBe(400);

      const badLimit = await getJson(baseUrl, '/api/search?q=x&limit=nope');
      expect(badLimit.status).toBe(400);

      const negativeLimit = await getJson(baseUrl, '/api/search?q=x&limit=-1');
      expect(negativeLimit.status).toBe(400);

      const badOffset = await getJson(baseUrl, '/api/search?q=x&offset=1.5');
      expect(badOffset.status).toBe(400);

      const unknown = await getJson(
        baseUrl,
        '/api/search?q=posterior&project=project_nowhere',
      );
      expect(unknown.status).toBe(500);
      expect(
        (unknown.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'project.missing',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'builds context bundles with branches, trails, scores, and line ranges',
    async () => {
      const { baseUrl } = await startTestServer();

      const global = await getJson(baseUrl, '/api/context?q=posterior');
      const bundle = global.body as ContextBundle & {
        diagnostics: Diagnostic[];
      };
      expect(global.status).toBe(200);
      expect(bundle.query).toBe('posterior');
      expect(bundle.scope).toEqual({ kind: 'global' });
      expect(bundle.selectedBranches.length).toBeGreaterThan(0);
      expect(bundle.files.length).toBeGreaterThan(0);
      for (const file of bundle.files) {
        expect(typeof file.path).toBe('string');
        expect(typeof file.trail.branch).toBe('string');
        expect(typeof file.trail.route).toBe('string');
        expect(typeof file.score.total).toBe('number');
        expect(Array.isArray(file.lineRanges)).toBe(true);
        expect(typeof file.contentTruncated).toBe('boolean');
        expect(typeof file.content).toBe('string');
      }

      const project = await getJson(
        baseUrl,
        '/api/context?q=posterior&project=project_evon',
      );
      const scoped = project.body as ContextBundle;
      expect(scoped.scope).toEqual({
        kind: 'project',
        project: 'project_evon',
      });
      expect(
        scoped.files.some(
          (file) =>
            file.path ===
            'projects/evolutionary-optimization/context/posterior.md',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'validates context query parameters',
    async () => {
      const { baseUrl } = await startTestServer();

      const missing = await getJson(baseUrl, '/api/context');
      expect(missing.status).toBe(400);

      const combined = await getJson(
        baseUrl,
        '/api/context?q=x&project=project_evon&chat=chat_rank_diagnostics',
      );
      expect(combined.status).toBe(400);

      const unknown = await getJson(
        baseUrl,
        '/api/context?q=x&project=project_nowhere',
      );
      expect(unknown.status).toBe(500);
    },
    serverTestTimeout,
  );

  it(
    'returns 404 for unknown API routes and 405 for other methods',
    async () => {
      const { baseUrl } = await startTestServer();

      const unknown = await getJson(baseUrl, '/api/nope');
      expect(unknown.status).toBe(404);
      expect(typeof (unknown.body as { error: unknown }).error).toBe('string');

      const response = await fetch(`${baseUrl}/api/workspace`, {
        method: 'POST',
      });
      expect(response.status).toBe(405);
    },
    serverTestTimeout,
  );

  it(
    'flows validation diagnostics into the workspace endpoint',
    async () => {
      const { baseUrl, root } = await startTestServer();
      await write(
        root,
        'chats/broken.md',
        [
          '---',
          'id: chat_broken',
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
      expect(
        data.diagnostics.some((entry) => entry.code === 'reference.missing'),
      ).toBe(true);
    },
    serverTestTimeout,
  );
});

describe('HTML pages', () => {
  const pageRoutes = [
    '/',
    '/projects',
    '/projects/project_evon',
    '/chats',
    '/chats/new',
    '/chats/chat_rank_diagnostics',
    '/inbox',
    '/search',
    '/context',
    '/edit',
    '/settings',
    '/tasks',
  ];

  it(
    'serves every SPA route with the build notice when assets are missing',
    async () => {
      const { baseUrl } = await startTestServer();
      for (const route of pageRoutes) {
        const { status, contentType, html } = await getHtml(baseUrl, route);
        expect(status, route).toBe(200);
        expect(contentType, route).toBe('text/html; charset=utf-8');
        expect(html, route).toContain('npm run build:web');
      }
    },
    serverTestTimeout,
  );

  it(
    'returns 404 HTML pages for unknown pages',
    async () => {
      const { baseUrl } = await startTestServer();
      const unknown = await getHtml(baseUrl, '/nope');
      expect(unknown.status).toBe(404);
      expect(unknown.contentType).toBe('text/html; charset=utf-8');
    },
    serverTestTimeout,
  );
});

describe('server lifecycle', () => {
  it(
    'stops cleanly and rejects later requests',
    async () => {
      const { baseUrl } = await startTestServer();
      const handle = runningHandles[runningHandles.length - 1];
      expect(handle).toBeDefined();

      const before = await fetch(`${baseUrl}/api/workspace`);
      expect(before.status).toBe(200);

      await handle?.stop();
      await expect(fetch(`${baseUrl}/api/workspace`)).rejects.toThrow();
      await expect(handle?.stop()).resolves.toBeUndefined();
    },
    serverTestTimeout,
  );
});
