import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { hashOf } from '../../src/operations/edit.js';
import type { EditableFileView } from '../../src/operations/frontmatterEdit.js';
import type { LexicalSearchData } from '../../src/search/lexical.js';
import type { ChatListEntry } from '../../src/server/api.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-editing-'));
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

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function hash(root: string, relativePath: string): Promise<string> {
  return hashOf(await readFile(path.join(root, ...relativePath.split('/'))));
}

function bodySlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(closing);
}

function frontmatterSlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(0, closing);
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

async function postJson(
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function postRaw(
  baseUrl: string,
  route: string,
  raw: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function postWithHeaders(
  baseUrl: string,
  route: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

describe('editing API', () => {
  it(
    'loads an editable file with kind, policy, unknown keys, body, and hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(
        root,
        'chats/2026-09-02-rank-diagnostics.md',
        [
          '---',
          'id: chat_rank_diagnostics',
          'title: Rank diagnostics',
          'created: 2026-09-02T10:00:00Z',
          'projects:',
          '  - project_evon',
          '  - project_posterior_diagnostics',
          'topics:',
          '  - topic_preconditioning',
          'provider: local',
          'model: sample-model',
          'messages: []',
          'x-custom: keep-me',
          '---',
          '',
          '# Rank diagnostics',
          '',
          'Discussion of rank diagnostics.',
          '',
        ].join('\n'),
      );

      const { status, body } = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('chats/2026-09-02-rank-diagnostics.md')}`,
      );
      const data = body as EditableFileView & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.kind).toBe('chat');
      expect(data.path).toBe('chats/2026-09-02-rank-diagnostics.md');
      expect(data.metadata.title).toBe('Rank diagnostics');
      expect(data.unknownKeys).toEqual(['messages', 'x-custom']);
      expect(data.body).toContain('# Rank diagnostics');
      expect(data.editableFields.map((field) => field.field)).toEqual([
        'title',
        'topics',
        'projects',
        'provider',
        'model',
      ]);
      expect(data.contentHash).toBe(
        await hash(root, 'chats/2026-09-02-rank-diagnostics.md'),
      );
      expect(Array.isArray(data.diagnostics)).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'requires the path parameter',
    async () => {
      const { baseUrl } = await startTestServer();
      const missing = await getJson(baseUrl, '/api/file');
      expect(missing.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'changes a chat title while preserving the body, unknown keys, and search freshness',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      await write(
        root,
        chatPath,
        [
          '---',
          'id: chat_rank_diagnostics',
          'title: Rank diagnostics',
          'created: 2026-09-02T10:00:00Z',
          'projects:',
          '  - project_evon',
          '  - project_posterior_diagnostics',
          'topics:',
          '  - topic_preconditioning',
          'provider: local',
          'model: sample-model',
          'x-custom: keep-me',
          '---',
          '',
          '# Rank diagnostics',
          '',
          'Body must survive byte for byte.',
          '',
        ].join('\n'),
      );
      const before = await read(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/edit/frontmatter',
        {
          path: chatPath,
          changes: { title: 'Rank diagnostics rewritten' },
          expectedHash: hashOf(Buffer.from(before, 'utf8')),
        },
      );
      const applied = body as {
        changed: boolean;
        diagnostics: Diagnostic[];
        contentHash: string | null;
      };

      expect(status).toBe(200);
      expect(applied.changed).toBe(true);
      expect(typeof applied.contentHash).toBe('string');
      expect(
        applied.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const after = await read(root, chatPath);
      expect(after).toContain('title: Rank diagnostics rewritten');
      expect(after).toContain('x-custom: keep-me');
      expect(bodySlice(after)).toBe(bodySlice(before));

      const chats = await getJson(baseUrl, '/api/chats');
      const edited = (chats.body as { chats: ChatListEntry[] }).chats.find(
        (chat) => chat.id === 'chat_rank_diagnostics',
      );
      expect(edited?.title).toBe('Rank diagnostics rewritten');

      const search = await getJson(baseUrl, '/api/search?q=rewritten');
      const results = (search.body as LexicalSearchData).results;
      expect(results.some((entry) => entry.path === chatPath)).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'rejects invalid patches with 422 and leaves the file untouched',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const beforeHash = await hash(root, chatPath);

      const typed = await postJson(baseUrl, '/api/edit/frontmatter', {
        path: chatPath,
        changes: { title: 123 },
        expectedHash: beforeHash,
      });
      expect(typed.status).toBe(422);
      const typedBody = typed.body as { diagnostics: Diagnostic[] };
      expect(
        typedBody.diagnostics.some(
          (entry) => entry.severity === 'error' && entry.fieldPath === 'title',
        ),
      ).toBe(true);

      const referenced = await postJson(baseUrl, '/api/edit/frontmatter', {
        path: chatPath,
        changes: { projects: ['project_nowhere'] },
        expectedHash: beforeHash,
      });
      expect(referenced.status).toBe(422);
      const referencedBody = referenced.body as { diagnostics: Diagnostic[] };
      expect(
        referencedBody.diagnostics.some(
          (entry) =>
            entry.severity === 'error' && entry.fieldPath === 'projects.0',
        ),
      ).toBe(true);

      expect(await hash(root, chatPath)).toBe(beforeHash);
    },
    serverTestTimeout,
  );

  it(
    'rejects patches to fields outside the policy',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const beforeHash = await hash(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/edit/frontmatter',
        {
          path: chatPath,
          changes: { id: 'chat_other' },
          expectedHash: beforeHash,
        },
      );

      expect(status).toBe(422);
      const data = body as { diagnostics: Diagnostic[] };
      expect(
        data.diagnostics.some(
          (entry) =>
            entry.code === 'edit.field_not_editable' &&
            entry.fieldPath === 'id' &&
            entry.message.includes('id'),
        ),
      ).toBe(true);
      expect(await hash(root, chatPath)).toBe(beforeHash);
    },
    serverTestTimeout,
  );

  it(
    'reports stale hashes as 409 with the current hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const loaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const staleHash = (loaded.body as EditableFileView).contentHash;

      const original = await read(root, chatPath);
      await write(root, chatPath, `${original}Concurrent line.\n`);
      const concurrentHash = await hash(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/edit/frontmatter',
        {
          path: chatPath,
          changes: { title: 'Too late' },
          expectedHash: staleHash,
        },
      );

      expect(status).toBe(409);
      const data = body as {
        currentHash: string | null;
        diagnostics: Diagnostic[];
      };
      expect(data.currentHash).toBe(concurrentHash);
      expect(
        data.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
      expect(await hash(root, chatPath)).toBe(concurrentHash);
    },
    serverTestTimeout,
  );

  it(
    'accepts an uppercase fresh hash for frontmatter and body edits',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';

      const loaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const frontmatterHash = (
        loaded.body as EditableFileView
      ).contentHash.toUpperCase();

      const frontmatter = await postJson(baseUrl, '/api/edit/frontmatter', {
        path: chatPath,
        changes: { title: 'Uppercase hash title' },
        expectedHash: frontmatterHash,
      });
      expect(frontmatter.status).toBe(200);
      expect((frontmatter.body as { changed: boolean }).changed).toBe(true);
      expect(await read(root, chatPath)).toContain(
        'title: Uppercase hash title',
      );

      const reloaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const bodyHash = (
        reloaded.body as EditableFileView
      ).contentHash.toUpperCase();

      const bodyEdit = await postJson(baseUrl, '/api/edit/body', {
        path: chatPath,
        body: '\n# Uppercase hash body\n',
        expectedHash: bodyHash,
      });
      expect(bodyEdit.status).toBe(200);
      expect((bodyEdit.body as { changed: boolean }).changed).toBe(true);
      expect(await read(root, chatPath)).toContain('# Uppercase hash body');
    },
    serverTestTimeout,
  );

  it(
    'reports an uppercase stale hash as 409 with the lowercase current hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const loaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const staleHash = (
        loaded.body as EditableFileView
      ).contentHash.toUpperCase();

      const original = await read(root, chatPath);
      await write(root, chatPath, `${original}Concurrent line.\n`);
      const concurrentHash = await hash(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/edit/frontmatter',
        {
          path: chatPath,
          changes: { title: 'Too late' },
          expectedHash: staleHash,
        },
      );

      expect(status).toBe(409);
      const data = body as {
        currentHash: string | null;
        diagnostics: Diagnostic[];
      };
      expect(data.currentHash).toBe(concurrentHash);
      expect(
        data.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
      expect(await hash(root, chatPath)).toBe(concurrentHash);
    },
    serverTestTimeout,
  );

  it(
    'replaces a summary body verbatim with one trailing newline',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const summaryPath = 'topics/preconditioning.md';
      const original = [
        '---',
        'id: topic_preconditioning',
        'title: Matrix preconditioning',
        'kind: topic',
        'summary: Cross-project notes about matrix-valued optimizer statistics.',
        'sources:',
        '  - chat_shared_curvature',
        '  - chat_rank_diagnostics',
        'reviewed: 2026-09-02',
        '---',
        '',
        '# Matrix preconditioning',
        '',
        'Both sample projects use this topic.',
        '',
      ].join('\n');
      await write(root, summaryPath, original);
      const before = await read(root, summaryPath);

      const { status, body } = await postJson(baseUrl, '/api/edit/body', {
        path: summaryPath,
        body: '\n# Matrix preconditioning\n\nRewritten summary body.\n',
        expectedHash: hashOf(Buffer.from(before, 'utf8')),
      });
      const applied = body as {
        changed: boolean;
        contentHash: string | null;
      };

      expect(status).toBe(200);
      expect(applied.changed).toBe(true);
      const after = await read(root, summaryPath);
      expect(frontmatterSlice(after)).toBe(frontmatterSlice(before));
      expect(bodySlice(after)).toBe(
        '\n---\n\n# Matrix preconditioning\n\nRewritten summary body.\n',
      );

      const normalized = await postJson(baseUrl, '/api/edit/body', {
        path: summaryPath,
        body: 'Trailing text.\n\n\n\n',
        expectedHash: applied.contentHash,
      });
      expect(normalized.status).toBe(200);
      const finalContent = await read(root, summaryPath);
      expect(finalContent.endsWith('Trailing text.\n')).toBe(true);
      expect(finalContent.endsWith('Trailing text.\n\n')).toBe(false);
    },
    serverTestTimeout,
  );

  it(
    'enforces the path policy for reads and writes',
    async () => {
      const { baseUrl } = await startTestServer();

      const traversal = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('../workspace.yml')}`,
      );
      expect(traversal.status).toBe(400);
      expect(
        (traversal.body as { diagnostics: Diagnostic[] }).diagnostics[0]
          ?.fieldPath ?? '',
      ).toBe('path');

      const absolute = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('/etc/hosts')}`,
      );
      expect(absolute.status).toBe(400);

      const backslash = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('chats\\escape.md')}`,
      );
      expect(backslash.status).toBe(400);

      const manifest = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('projects/evolutionary-optimization/project.yml')}`,
      );
      expect(manifest.status).toBe(400);

      const settings = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('workspace.yml')}`,
      );
      expect(settings.status).toBe(400);

      const missing = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent('chats/does-not-exist.md')}`,
      );
      expect(missing.status).toBe(404);

      const postTraversal = await postJson(baseUrl, '/api/edit/frontmatter', {
        path: '../workspace.yml',
        changes: { title: 'nope' },
        expectedHash: 'ab'.repeat(32),
      });
      expect(postTraversal.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'rejects malformed edit requests',
    async () => {
      const { baseUrl } = await startTestServer();

      const noPath = await postJson(baseUrl, '/api/edit/frontmatter', {
        changes: { title: 'No path' },
      });
      expect(noPath.status).toBe(400);

      const noChanges = await postJson(baseUrl, '/api/edit/frontmatter', {
        path: 'chats/2026-09-02-rank-diagnostics.md',
      });
      expect(noChanges.status).toBe(400);

      const noBody = await postJson(baseUrl, '/api/edit/body', {
        path: 'chats/2026-09-02-rank-diagnostics.md',
      });
      expect(noBody.status).toBe(400);

      const malformed = await postRaw(baseUrl, '/api/edit/frontmatter', '{');
      expect(malformed.status).toBe(400);

      const readOnly = await fetch(`${baseUrl}/api/workspace`, {
        method: 'POST',
      });
      expect(readOnly.status).toBe(405);

      const editGet = await fetch(`${baseUrl}/api/edit/frontmatter`);
      expect(editGet.status).toBe(405);
    },
    serverTestTimeout,
  );
});

describe('edit endpoint request gates', () => {
  it(
    'refuses the cross-origin text/plain attack with 403 and leaves the file untouched',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const before = await read(root, chatPath);

      const attack = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        { origin: 'https://attacker.example', 'content-type': 'text/plain' },
        { path: chatPath, body: '\n# Attacker note\n' },
      );

      expect(attack.status).toBe(403);
      const data = attack.body as { error: string; diagnostics: Diagnostic[] };
      expect(data.error).toContain('https://attacker.example');
      expect(
        data.diagnostics.some(
          (entry) => entry.code === 'serve.origin_rejected',
        ),
      ).toBe(true);
      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'refuses cross-origin writes even with a JSON content type',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const before = await read(root, chatPath);

      const attack = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        {
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        { path: chatPath, body: '\n# Attacker note\n' },
      );

      expect(attack.status).toBe(403);
      expect(
        (attack.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'serve.origin_rejected',
        ),
      ).toBe(true);
      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'refuses text/plain writes without an Origin header with 415',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const before = await read(root, chatPath);
      const expectedHash = await hash(root, chatPath);

      const plain = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        { 'content-type': 'text/plain' },
        { path: chatPath, body: '\n# Plain body\n', expectedHash },
      );

      expect(plain.status).toBe(415);
      const plainBody = plain.body as {
        error: string;
        diagnostics: Diagnostic[];
      };
      expect(plainBody.error).toContain('text/plain');
      expect(
        plainBody.diagnostics.some(
          (entry) => entry.code === 'serve.content_type_required',
        ),
      ).toBe(true);

      const plainCharset = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        { 'content-type': 'text/plain; charset=UTF-8' },
        { path: chatPath, body: '\n# Plain body\n', expectedHash },
      );

      expect(plainCharset.status).toBe(415);
      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'requires a 64-hex-character expectedHash on JSON edits',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const before = await read(root, chatPath);

      const invalidHashes: unknown[] = [
        undefined,
        null,
        '',
        'ab'.repeat(31) + 'a',
        'zz'.repeat(32),
        42,
      ];
      for (const expectedHash of invalidHashes) {
        const response = await postWithHeaders(
          baseUrl,
          '/api/edit/body',
          { 'content-type': 'application/json' },
          { path: chatPath, body: '\n# Hashless body\n', expectedHash },
        );
        expect(response.status, String(expectedHash)).toBe(400);
        const data = response.body as { diagnostics: Diagnostic[] };
        expect(
          data.diagnostics.some((entry) => entry.code === 'edit.hash_required'),
          String(expectedHash),
        ).toBe(true);
      }

      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'still reports a well-formed but stale expectedHash as 409',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const loaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const staleHash = (loaded.body as EditableFileView).contentHash;

      const original = await read(root, chatPath);
      await write(root, chatPath, `${original}Concurrent line.\n`);
      const concurrentHash = await hash(root, chatPath);

      const response = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        { 'content-type': 'application/json' },
        {
          path: chatPath,
          body: '\n# Too late\n',
          expectedHash: staleHash,
        },
      );

      expect(response.status).toBe(409);
      const data = response.body as {
        currentHash: string | null;
        diagnostics: Diagnostic[];
      };
      expect(data.currentHash).toBe(concurrentHash);
      expect(
        data.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
      expect(await hash(root, chatPath)).toBe(concurrentHash);
    },
    serverTestTimeout,
  );

  it(
    'applies edits from browser-like same-origin requests with fresh hashes',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const loaded = await getJson(
        baseUrl,
        `/api/file?path=${encodeURIComponent(chatPath)}`,
      );
      const freshHash = (loaded.body as EditableFileView).contentHash;

      const bodyEdit = await postWithHeaders(
        baseUrl,
        '/api/edit/body',
        { origin: baseUrl, 'content-type': 'application/json' },
        {
          path: chatPath,
          body: '\n# Rank diagnostics\n\nBrowser-driven body.\n',
          expectedHash: freshHash,
        },
      );
      expect(bodyEdit.status).toBe(200);

      const frontmatterEdit = await postWithHeaders(
        baseUrl,
        '/api/edit/frontmatter',
        {
          origin: baseUrl,
          'content-type': 'application/json; charset=utf-8',
        },
        {
          path: chatPath,
          changes: { title: 'Browser-driven title' },
          expectedHash: (bodyEdit.body as { contentHash: string }).contentHash,
        },
      );
      expect(frontmatterEdit.status).toBe(200);

      const after = await read(root, chatPath);
      expect(after).toContain('Browser-driven body.');
      expect(after).toContain('title: Browser-driven title');
    },
    serverTestTimeout,
  );

  it(
    'leaves GET routes unaffected by the mutation gates',
    async () => {
      const { baseUrl } = await startTestServer();
      const response = await fetch(`${baseUrl}/api/workspace`, {
        headers: { origin: 'https://attacker.example' },
      });
      expect(response.status).toBe(200);
    },
    serverTestTimeout,
  );
});
