import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { hashOf } from '../../src/operations/edit.js';
import { todayDate } from '../../src/operations/start.js';
import type { BackendSettingsSnapshot } from '../../src/operations/backendSettings.js';
import type { ChatDetailViewData } from '../../src/server/api.js';
import { startServer, type ServerHandle } from '../../src/server/server.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: ServerHandle[] = [];
const stubServers: Server[] = [];
const secretEnvName = 'FIELDWORK_TEST_SAMPLE_KEY';
const secretEnvValue = 'lh-test-secret-do-not-print';
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
  await Promise.all(
    stubServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  delete process.env[secretEnvName];
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-serverapi-'));
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

async function startTestServer(): Promise<{
  root: string;
  baseUrl: string;
}> {
  const root = await copySampleWorkspace();
  const handle = await startServer(root, { host: '127.0.0.1', port: 0 });
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

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

interface StubServer {
  url: string;
  requests: CapturedRequest[];
  respond(status: number, body: string): void;
}

const cannedCompletion = JSON.stringify({
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  model: 'stub-model-v2',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Triffid marker reply about posterior diagnostics.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
});

async function startStubServer(): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  let status = 200;
  let responseBody = cannedCompletion;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      requests.push({
        url: request.url ?? '',
        method: request.method ?? '',
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address !== 'object') {
    throw new Error('The stub server did not report an address.');
  }
  stubServers.push(server);
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    respond(nextStatus: number, nextBody: string) {
      status = nextStatus;
      responseBody = nextBody;
    },
  };
}

async function addBackend(
  baseUrl: string,
  entry: {
    name: string;
    type: string;
    config: Record<string, unknown>;
  },
  expectedHash: string,
): Promise<{ status: number; body: unknown }> {
  return postJson(baseUrl, '/api/backends/add', { ...entry, expectedHash });
}

async function listBackends(baseUrl: string): Promise<{
  status: number;
  view: BackendSettingsSnapshot & { diagnostics: Diagnostic[] };
}> {
  const { status, body } = await getJson(baseUrl, '/api/backends');
  return {
    status,
    view: body as BackendSettingsSnapshot & { diagnostics: Diagnostic[] },
  };
}

async function workspaceHash(baseUrl: string): Promise<string> {
  const { view } = await listBackends(baseUrl);
  if (view.workspaceHash === null) {
    throw new Error('The backends view did not report a workspace hash.');
  }
  return view.workspaceHash;
}

describe('chat creation API', () => {
  it(
    'creates a chat with a generated id, fresh hash, and dated file',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/chats', {
        title: 'Gradient Notes',
      });
      const data = body as {
        chatId: string;
        title: string;
        file: string;
        contentHash: string | null;
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(201);
      expect(data.chatId).toBe('gradient_notes');
      expect(data.title).toBe('Gradient Notes');
      expect(data.file).toBe(`chats/${todayDate()}-gradient-notes.md`);
      expect(data.contentHash).toBe(
        await hash(root, `chats/${todayDate()}-gradient-notes.md`),
      );
      expect(
        data.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const contents = await read(
        root,
        `chats/${todayDate()}-gradient-notes.md`,
      );
      expect(contents).toContain('id: gradient_notes');
      expect(contents).toContain('title: Gradient Notes');
      expect(contents).toContain(`created: ${todayDate()}`);
    },
    serverTestTimeout,
  );

  it(
    'creates a chat with an explicit id, topics, projects, and a first message',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/chats', {
        title: 'Curvature Questions',
        id: 'chat_curvature_questions',
        topics: ['topic_preconditioning'],
        projects: ['project_evon'],
        message: 'First question about curvature.',
      });
      const data = body as { chatId: string; file: string };

      expect(status).toBe(201);
      expect(data.chatId).toBe('chat_curvature_questions');
      expect(data.file).toBe(`chats/${todayDate()}-curvature-questions.md`);
      const contents = await read(root, data.file);
      expect(contents).toContain('id: chat_curvature_questions');
      expect(contents).toContain('topics:');
      expect(contents).toContain('- topic_preconditioning');
      expect(contents).toContain('- project_evon');
      expect(contents).toContain('## user\n\nFirst question about curvature.');

      const detail = await getJson(
        baseUrl,
        '/api/chats/chat_curvature_questions',
      );
      const view = detail.body as ChatDetailViewData;
      expect(detail.status).toBe(200);
      expect(view.projects).toEqual(['project_evon']);
      expect(view.topics).toEqual(['topic_preconditioning']);
      expect(view.messages.map((message) => message.role)).toEqual(['user']);
      expect(view.messages[0]?.text).toBe('First question about curvature.');
    },
    serverTestTimeout,
  );

  it(
    'generates unique ids against existing chats',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(
        root,
        'chats/2026-01-01-fresh-topic.md',
        [
          '---',
          'id: fresh_topic',
          'title: Fresh topic',
          'created: 2026-01-01',
          '---',
          '',
          '# Fresh topic',
          '',
        ].join('\n'),
      );

      const { status, body } = await postJson(baseUrl, '/api/chats', {
        title: 'Fresh topic',
      });
      const data = body as { chatId: string; file: string };

      expect(status).toBe(201);
      expect(data.chatId).toBe('fresh_topic_2');
      expect(data.file).toBe(`chats/${todayDate()}-fresh-topic.md`);
    },
    serverTestTimeout,
  );

  it(
    'rejects invalid titles, ids, and project references with 422',
    async () => {
      const { baseUrl } = await startTestServer();

      const emptyTitle = await postJson(baseUrl, '/api/chats', { title: '' });
      expect(emptyTitle.status).toBe(422);
      expect(
        (emptyTitle.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'operation.target_invalid',
        ),
      ).toBe(true);

      const badId = await postJson(baseUrl, '/api/chats', {
        title: 'Notes',
        id: 'Bad ID',
      });
      expect(badId.status).toBe(422);

      const badProject = await postJson(baseUrl, '/api/chats', {
        title: 'Notes',
        id: 'chat_broken_project',
        projects: ['project_nowhere'],
      });
      expect(badProject.status).toBe(422);
      expect(
        (badProject.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'reference.missing',
        ),
      ).toBe(true);

      const malformed = await postJson(baseUrl, '/api/chats', { title: 7 });
      expect(malformed.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'rejects duplicate ids and same-day duplicate files with 409',
    async () => {
      const { root, baseUrl } = await startTestServer();

      const duplicateId = await postJson(baseUrl, '/api/chats', {
        title: 'Whatever',
        id: 'chat_lab_agenda',
      });
      expect(duplicateId.status).toBe(409);
      expect(
        (duplicateId.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'id.duplicate',
        ),
      ).toBe(true);

      const first = await postJson(baseUrl, '/api/chats', {
        title: 'Rank diagnostics',
      });
      expect(first.status).toBe(201);
      expect((first.body as { chatId: string }).chatId).toBe(
        'rank_diagnostics',
      );

      const duplicateFile = await postJson(baseUrl, '/api/chats', {
        title: 'Rank diagnostics',
      });
      expect(duplicateFile.status).toBe(409);
      expect(
        (duplicateFile.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'operation.target_exists',
        ),
      ).toBe(true);
      expect(
        await read(root, `chats/${todayDate()}-rank-diagnostics.md`),
      ).toContain('id: rank_diagnostics');
    },
    serverTestTimeout,
  );
});

describe('chat detail API', () => {
  it(
    'includes the content hash and windowed transcript messages',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await getJson(
        baseUrl,
        '/api/chats/chat_lab_agenda',
      );
      const data = body as ChatDetailViewData & { diagnostics: Diagnostic[] };

      expect(status).toBe(200);
      expect(data.contentHash).toBe(
        await hash(root, 'chats/2026-09-10-lab-agenda.md'),
      );
      expect(data.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      for (const message of data.messages) {
        expect(Object.keys(message).sort()).toEqual([
          'metadata',
          'role',
          'text',
        ]);
      }
      expect(data.messages[0]?.text).toContain(
        "Please draft the agenda for Thursday's lab meeting.",
      );
      expect(data.messages[0]?.metadata).toBeNull();
      expect(data.messages[1]?.metadata?.provider).toBe('openai');
      expect(data.messages[1]?.metadata?.model).toBe('gpt-5.6');
      expect('body' in data).toBe(false);
      expect(data.hasEarlier).toBe(false);
    },
    serverTestTimeout,
  );
});

describe('chat send API', () => {
  it(
    'appends an exchange and returns the committed state',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      expect(
        (
          await addBackend(
            baseUrl,
            {
              name: 'stub-model',
              type: 'openai',
              config: { base_url: stub.url, model: 'test-model' },
            },
            await workspaceHash(baseUrl),
          )
        ).status,
      ).toBe(201);

      const before = await hash(root, 'chats/2026-09-10-lab-agenda.md');
      const { status, body } = await postJson(
        baseUrl,
        `/api/chats/${encodeURIComponent('chat_lab_agenda')}/messages`,
        {
          message: 'What is the agenda for Thursday?',
          backend: 'stub-model',
          expectedHash: before,
        },
      );
      const data = body as {
        chatId: string;
        file: string;
        backend: string;
        contentHash: string | null;
        exchange: {
          user: { role: string; text: string; metadata: unknown };
          assistant: {
            role: string;
            text: string;
            metadata: {
              provider?: string;
              model?: string;
              backend?: string;
              at?: string;
              usage?: Record<string, unknown>;
            };
          };
        };
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.chatId).toBe('chat_lab_agenda');
      expect(data.file).toBe('chats/2026-09-10-lab-agenda.md');
      expect(data.backend).toBe('stub-model');
      expect(data.contentHash).toBe(
        await hash(root, 'chats/2026-09-10-lab-agenda.md'),
      );
      expect(data.contentHash).not.toBe(before);
      expect(data.exchange.user).toEqual({
        role: 'user',
        text: 'What is the agenda for Thursday?',
        metadata: null,
      });
      expect(data.exchange.assistant.role).toBe('assistant');
      expect(data.exchange.assistant.text).toContain('Triffid marker reply');
      const assistantMetadata = data.exchange.assistant.metadata;
      expect(assistantMetadata.provider).toBe('openai-compatible');
      expect(assistantMetadata.model).toBe('stub-model-v2');
      expect(assistantMetadata.backend).toBe('stub-model');
      expect(assistantMetadata.usage?.total_tokens).toBe(19);
      expect('messages' in data).toBe(false);
      expect('appendedCount' in data).toBe(false);
      expect('reply' in data).toBe(false);
      expect(
        data.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const contents = await read(root, 'chats/2026-09-10-lab-agenda.md');
      expect(contents).toContain('## user\n\nWhat is the agenda for Thursday?');
      expect(contents).toContain('provider: openai-compatible');
      expect(contents).toContain('model: stub-model-v2');
      expect(contents).toContain('Triffid marker reply');

      expect(stub.requests).toHaveLength(1);
      const request = stub.requests[0];
      expect(request?.url).toBe('/v1/chat/completions');
      expect(request?.method).toBe('POST');
      expect(request?.headers.authorization).toBeUndefined();
      const sentBody = JSON.parse(request?.body ?? '{}') as {
        model: string;
        messages: { role: string; content: string }[];
      };
      expect(sentBody.model).toBe('test-model');
      expect(sentBody.messages.at(-1)?.role).toBe('user');
      expect(sentBody.messages.at(-1)?.content).toContain(
        'What is the agenda for Thursday?',
      );
      expect(sentBody.messages.at(-1)?.content).toContain(
        '<fieldwork_workspace>',
      );
      expect(sentBody.messages.at(-1)?.content).toContain(baseUrl);
    },
    serverTestTimeout,
  );

  it(
    'selects the backend per turn and fails without a default',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      let currentHash = await workspaceHash(baseUrl);
      currentHash = (
        (
          await addBackend(
            baseUrl,
            {
              name: 'first-model',
              type: 'openai',
              config: { base_url: stub.url, model: 'first-test-model' },
            },
            currentHash,
          )
        ).body as BackendSettingsSnapshot
      ).workspaceHash;
      const second = await addBackend(
        baseUrl,
        {
          name: 'second-model',
          type: 'openai',
          config: { base_url: stub.url, model: 'second-test-model' },
        },
        currentHash,
      );
      expect(second.status).toBe(201);

      const chatHash = await hash(root, 'chats/2026-09-10-lab-agenda.md');
      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Hello from the second model.',
          backend: 'second-model',
          expectedHash: chatHash,
        },
      );
      const data = body as {
        backend: string;
        exchange: { assistant: { text: string } };
      };

      expect(status).toBe(200);
      expect(data.backend).toBe('second-model');
      expect(data.exchange.assistant.text).toContain('Triffid marker reply');
      const sentBody = JSON.parse(stub.requests[0]?.body ?? '{}') as {
        model: string;
      };
      expect(sentBody.model).toBe('second-test-model');

      const unconfigured = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Hello without a default.',
          expectedHash: await hash(root, 'chats/2026-09-10-lab-agenda.md'),
        },
      );
      expect(unconfigured.status).toBe(502);
      expect(
        (unconfigured.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.unconfigured',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'requires a well-formed expectedHash with 400',
    async () => {
      const { baseUrl } = await startTestServer();
      const invalidHashes: unknown[] = [
        undefined,
        null,
        '',
        'ab'.repeat(31) + 'a',
        'zz'.repeat(32),
        42,
      ];
      for (const expectedHash of invalidHashes) {
        const response = await postJson(
          baseUrl,
          '/api/chats/chat_lab_agenda/messages',
          { message: 'Hello.', expectedHash },
        );
        expect(response.status, String(expectedHash)).toBe(400);
        expect(
          (response.body as { diagnostics: Diagnostic[] }).diagnostics.some(
            (entry) => entry.code === 'edit.hash_required',
          ),
          String(expectedHash),
        ).toBe(true);
      }
    },
    serverTestTimeout,
  );

  it(
    'reports stale hashes as 409 with the current hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const staleHash = await hash(root, 'chats/2026-09-10-lab-agenda.md');
      const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
      await writeFile(
        file,
        `${await readFile(file, 'utf8')}Concurrent note.\n`,
      );
      const current = await hash(root, 'chats/2026-09-10-lab-agenda.md');

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Too late.',
          backend: 'stub-model',
          expectedHash: staleHash,
        },
      );

      expect(status).toBe(409);
      const data = body as {
        currentHash: string | null;
        diagnostics: Diagnostic[];
      };
      expect(data.currentHash).toBe(current);
      expect(
        data.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'returns 502 and leaves the transcript unchanged when the backend fails',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      stub.respond(500, '{"error": "upstream exploded"}');
      await addBackend(
        baseUrl,
        {
          name: 'stub-model',
          type: 'openai',
          config: { base_url: stub.url, model: 'test-model' },
        },
        await workspaceHash(baseUrl),
      );
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await readFile(path.join(root, chatPath));

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Hello.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(status).toBe(502);
      const data = body as { diagnostics: Diagnostic[] };
      expect(
        data.diagnostics.some((entry) => entry.code === 'backend.http_status'),
      ).toBe(true);
      expect(
        data.diagnostics.some((entry) => entry.message.includes('500')),
      ).toBe(true);
      expect(await readFile(path.join(root, chatPath))).toEqual(before);
      expect(stub.requests).toHaveLength(1);
    },
    serverTestTimeout,
  );

  it(
    'rejects a duplicate submission with 409 and appends one exchange',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      await addBackend(
        baseUrl,
        {
          name: 'stub-model',
          type: 'openai',
          config: { base_url: stub.url, model: 'test-model' },
        },
        await workspaceHash(baseUrl),
      );
      const originalHash = await hash(root, 'chats/2026-09-10-lab-agenda.md');
      const payload = {
        message: 'Only exchange about calorimetry.',
        backend: 'stub-model',
        expectedHash: originalHash,
      };

      const first = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        payload,
      );
      expect(first.status).toBe(200);

      const second = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        payload,
      );
      expect(second.status).toBe(409);
      const secondBody = second.body as { currentHash: string | null };
      expect(secondBody.currentHash).toBe(
        (first.body as { contentHash: string }).contentHash,
      );

      const detail = await getJson(baseUrl, '/api/chats/chat_lab_agenda');
      const view = detail.body as ChatDetailViewData;
      expect(view.messages).toHaveLength(4);
      const contents = await read(root, 'chats/2026-09-10-lab-agenda.md');
      expect(
        contents.split('Only exchange about calorimetry.').length - 1,
      ).toBe(1);
    },
    serverTestTimeout,
  );

  it(
    'returns 404 for unknown chats and 422 for empty messages',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      await addBackend(
        baseUrl,
        {
          name: 'stub-model',
          type: 'openai',
          config: { base_url: stub.url, model: 'test-model' },
        },
        await workspaceHash(baseUrl),
      );

      const unknown = await postJson(
        baseUrl,
        '/api/chats/chat_nowhere/messages',
        {
          message: 'Hello.',
          expectedHash: await hash(root, 'chats/2026-09-10-lab-agenda.md'),
        },
      );
      expect(unknown.status).toBe(404);
      expect(
        (unknown.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'chat.missing',
        ),
      ).toBe(true);
      expect(stub.requests).toHaveLength(0);

      const empty = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: '   ',
          expectedHash: await hash(root, 'chats/2026-09-10-lab-agenda.md'),
        },
      );
      expect(empty.status).toBe(422);
      expect(
        (empty.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'operation.target_invalid',
        ),
      ).toBe(true);
      expect(stub.requests).toHaveLength(0);
    },
    serverTestTimeout,
  );
});

describe('chat membership and promotion API', () => {
  it(
    'attaches and detaches a chat from a project',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const attach = await postJson(
        baseUrl,
        `/api/chats/${encodeURIComponent('chat_lab_agenda')}/attach`,
        {
          projectId: 'project_soap_bubbles',
          expectedHash: await hash(root, chatPath),
        },
      );
      const attached = attach.body as ChatDetailViewData & {
        diagnostics: Diagnostic[];
      };
      expect(attach.status).toBe(200);
      expect(attached.projects).toContain('project_soap_bubbles');
      expect(attached.contentHash).toBe(await hash(root, chatPath));
      expect(attached.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
      expect(
        attached.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);
      expect(await read(root, chatPath)).toContain('- project_soap_bubbles');

      const detach = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/detach',
        {
          projectId: 'project_soap_bubbles',
          expectedHash: await hash(root, chatPath),
        },
      );
      const detached = detach.body as ChatDetailViewData;
      expect(detach.status).toBe(200);
      expect(detached.projects).not.toContain('project_soap_bubbles');
      expect(detached.contentHash).toBe(await hash(root, chatPath));
    },
    serverTestTimeout,
  );

  it(
    'returns 404 for unknown chats or projects and 422 for invalid ids',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatHash = await hash(root, 'chats/2026-09-10-lab-agenda.md');

      const unknownChat = await postJson(
        baseUrl,
        '/api/chats/chat_nowhere/attach',
        { projectId: 'project_evon', expectedHash: chatHash },
      );
      expect(unknownChat.status).toBe(404);
      expect(
        (unknownChat.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'chat.missing',
        ),
      ).toBe(true);

      const unknownProject = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 'project_nowhere', expectedHash: chatHash },
      );
      expect(unknownProject.status).toBe(404);
      expect(
        (unknownProject.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'project.missing',
        ),
      ).toBe(true);

      const invalid = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 'Not A Stable Id', expectedHash: chatHash },
      );
      expect(invalid.status).toBe(422);

      const malformed = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 7 },
      );
      expect(malformed.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'promotes a chat into a new project with the updated chat view',
    async () => {
      const { root, baseUrl } = await startTestServer();

      const { status, body } = await postJson(
        baseUrl,
        `/api/chats/${encodeURIComponent('chat_rank_diagnostics')}/promote`,
        {
          id: 'project_promoted',
          title: 'Promoted project',
          directory: 'promoted-area',
          expectedHash: await hash(
            root,
            'chats/2026-09-02-rank-diagnostics.md',
          ),
        },
      );
      const data = body as {
        chat: ChatDetailViewData;
        project: {
          id: string;
          title: string;
          directory: string;
          file: string;
          repositories: { id: string; path: string }[];
        };
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.project.id).toBe('project_promoted');
      expect(data.project.title).toBe('Promoted project');
      expect(data.project.directory).toBe('promoted-area');
      expect(data.project.file).toBe('projects/promoted-area/project.yml');
      expect(data.project.repositories).toEqual([]);
      expect(data.chat.id).toBe('chat_rank_diagnostics');
      expect(data.chat.projects).toContain('project_promoted');
      expect(
        data.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);
      expect(await read(root, 'projects/promoted-area/project.yml')).toContain(
        'id: project_promoted',
      );
      expect(
        await read(root, 'chats/2026-09-02-rank-diagnostics.md'),
      ).toContain('- project_promoted');
    },
    serverTestTimeout,
  );

  it(
    'returns 422 for invalid project ids and 404 for unknown chats on promote',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatHash = await hash(root, 'chats/2026-09-10-lab-agenda.md');

      const invalid = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/promote',
        { id: 'Bad ID', title: 'Notes', expectedHash: chatHash },
      );
      expect(invalid.status).toBe(422);

      const unknown = await postJson(
        baseUrl,
        '/api/chats/chat_nowhere/promote',
        {
          id: 'project_promoted',
          title: 'Promoted project',
          expectedHash: chatHash,
        },
      );
      expect(unknown.status).toBe(404);
      expect(
        (unknown.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'chat.missing',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );
});

describe('backends settings API', () => {
  const commentedSettings = [
    'version: 1',
    'title: Optimizer research sample',
    '# Workspace paths configure the canonical areas.',
    'paths:',
    '  projects: projects',
    '  chats: chats',
    '  topics: topics',
    '  inbox: inbox',
    '  external: external',
    '# The primary provider handles most exchanges.',
    'backends:',
    '  default: research-model',
    '  entries:',
    '    research-model:',
    '      # OpenAI-compatible endpoint settings.',
    '      type: openai',
    '      model: gpt-5.6',
    `      api_key_env: ${secretEnvName}`,
    '      x-custom: keep-me',
    '    # Agent entry comment.',
    '    local-agent:',
    '      type: opencode',
    '      command: node',
    '',
  ].join('\n');

  it(
    'lists an empty backends block with the workspace hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, view } = await listBackends(baseUrl);

      expect(status).toBe(200);
      expect(view.backends).toEqual([]);
      expect(view.default).toBeNull();
      expect(view.workspaceHash).toBe(await hash(root, 'workspace.yml'));
      expect(
        view.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'lists backends with safe fields and no secret values',
    async () => {
      const { root, baseUrl } = await startTestServer();
      process.env[secretEnvName] = secretEnvValue;
      await write(root, 'workspace.yml', commentedSettings);

      const { status, view } = await listBackends(baseUrl);
      const raw = JSON.stringify(view);
      expect(status).toBe(200);
      expect(raw).not.toContain(secretEnvValue);
      expect(view.default).toBe('research-model');
      expect(view.backends.map((entry) => entry.name)).toEqual([
        'local-agent',
        'research-model',
      ]);

      const research = view.backends.find(
        (entry) => entry.name === 'research-model',
      );
      expect(research?.type).toBe('openai');
      expect(research?.model).toBe('gpt-5.6');
      expect(research?.isDefault).toBe(true);
      expect(research?.apiKeyEnv).toBe(secretEnvName);
      expect(research?.baseUrl).toBe('https://api.openai.com/v1');
      expect(research?.command).toBeNull();
      expect(research?.args).toBeNull();
      expect(research?.timeoutMs).toBe(120000);
      expect(research?.status).toBe(`api key env ${secretEnvName} is set`);

      const agent = view.backends.find((entry) => entry.name === 'local-agent');
      expect(agent?.type).toBe('opencode');
      expect(agent?.model).toBeNull();
      expect(agent?.isDefault).toBe(false);
      expect(agent?.command).toBe('node');
      expect(agent?.args).toEqual([]);
      expect(agent?.timeoutMs).toBeNull();
      expect(agent?.baseUrl).toBeNull();
      expect(agent?.apiKeyEnv).toBeNull();
    },
    serverTestTimeout,
  );

  it(
    'adds, updates, removes, and retargets the default while preserving comments',
    async () => {
      const { root, baseUrl } = await startTestServer();
      process.env[secretEnvName] = secretEnvValue;
      await write(root, 'workspace.yml', commentedSettings);

      const add = await addBackend(
        baseUrl,
        {
          name: 'extra-model',
          type: 'openai',
          config: { base_url: 'http://127.0.0.1:9/v1', model: 'extra' },
        },
        await hash(root, 'workspace.yml'),
      );
      expect(add.status).toBe(201);
      const added = add.body as BackendSettingsSnapshot;
      expect(added.backends.map((entry) => entry.name)).toEqual([
        'extra-model',
        'local-agent',
        'research-model',
      ]);
      expect(added.workspaceHash).toBe(await hash(root, 'workspace.yml'));

      const duplicate = await addBackend(
        baseUrl,
        { name: 'extra-model', type: 'openai', config: { model: 'x' } },
        await hash(root, 'workspace.yml'),
      );
      expect(duplicate.status).toBe(422);
      expect(
        (duplicate.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.target_exists',
        ),
      ).toBe(true);

      const badTypeHash = await hash(root, 'workspace.yml');
      const badType = await addBackend(
        baseUrl,
        { name: 'banana-model', type: 'banana', config: {} },
        badTypeHash,
      );
      expect(badType.status).toBe(422);
      expect(await hash(root, 'workspace.yml')).toBe(badTypeHash);

      const badName = await addBackend(
        baseUrl,
        { name: 'Bad\u0000Name', type: 'openai', config: { model: 'x' } },
        badTypeHash,
      );
      expect(badName.status).toBe(422);
      expect(
        (badName.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.name_invalid',
        ),
      ).toBe(true);

      const update = await postJson(baseUrl, '/api/backends/update', {
        name: 'research-model',
        config: { model: 'gpt-6', 'x-added': 'fresh' },
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(update.status).toBe(200);
      const updated = update.body as BackendSettingsSnapshot;
      expect(
        updated.backends.find((entry) => entry.name === 'research-model')
          ?.model,
      ).toBe('gpt-6');
      const updatedFile = await read(root, 'workspace.yml');
      expect(updatedFile).toContain('model: gpt-6');
      expect(updatedFile).toContain('x-custom: keep-me');
      expect(updatedFile).toContain('x-added: fresh');
      expect(updatedFile).toContain(
        '# Workspace paths configure the canonical areas.',
      );
      expect(updatedFile).toContain(
        '# The primary provider handles most exchanges.',
      );
      expect(updatedFile).toContain('# OpenAI-compatible endpoint settings.');
      expect(updatedFile).toContain('# Agent entry comment.');

      const removeDefault = await postJson(baseUrl, '/api/backends/remove', {
        name: 'research-model',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(removeDefault.status).toBe(422);
      expect(
        (removeDefault.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.default_in_use',
        ),
      ).toBe(true);

      const setDefault = await postJson(baseUrl, '/api/backends/default', {
        name: 'local-agent',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(setDefault.status).toBe(200);
      expect((setDefault.body as BackendSettingsSnapshot).default).toBe(
        'local-agent',
      );

      const unknownDefault = await postJson(baseUrl, '/api/backends/default', {
        name: 'ghost-model',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(unknownDefault.status).toBe(404);
      expect(
        (unknownDefault.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.not_found',
        ),
      ).toBe(true);

      const remove = await postJson(baseUrl, '/api/backends/remove', {
        name: 'research-model',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(remove.status).toBe(200);
      expect(
        (remove.body as BackendSettingsSnapshot).backends.map(
          (entry) => entry.name,
        ),
      ).toEqual(['extra-model', 'local-agent']);

      const removeUnknown = await postJson(baseUrl, '/api/backends/remove', {
        name: 'research-model',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(removeUnknown.status).toBe(404);
    },
    serverTestTimeout,
  );

  it(
    'adds, lists, retargets the default, and removes a free-form backend name',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(root, 'workspace.yml', commentedSettings);
      const name = 'GPT 5 mini (local)';

      const add = await addBackend(
        baseUrl,
        { name, type: 'openai', config: { model: 'gpt-5-mini' } },
        await hash(root, 'workspace.yml'),
      );
      expect(add.status).toBe(201);
      expect(
        (add.body as BackendSettingsSnapshot).backends.map(
          (entry) => entry.name,
        ),
      ).toContain(name);
      expect(await read(root, 'workspace.yml')).toContain('GPT 5 mini (local)');

      const listed = await listBackends(baseUrl);
      expect(listed.status).toBe(200);
      expect(listed.view.backends.map((entry) => entry.name)).toContain(name);

      const setDefault = await postJson(baseUrl, '/api/backends/default', {
        name,
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(setDefault.status).toBe(200);
      expect((setDefault.body as BackendSettingsSnapshot).default).toBe(name);

      const removeDefault = await postJson(baseUrl, '/api/backends/remove', {
        name,
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(removeDefault.status).toBe(422);

      const retarget = await postJson(baseUrl, '/api/backends/default', {
        name: 'research-model',
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(retarget.status).toBe(200);
      const removed = await postJson(baseUrl, '/api/backends/remove', {
        name,
        expectedHash: await hash(root, 'workspace.yml'),
      });
      expect(removed.status).toBe(200);
      expect(
        (removed.body as BackendSettingsSnapshot).backends.map(
          (entry) => entry.name,
        ),
      ).not.toContain(name);
    },
    serverTestTimeout,
  );

  it(
    'reports stale hashes as 409 with the current hash on every write endpoint',
    async () => {
      const { root, baseUrl } = await startTestServer();
      await write(root, 'workspace.yml', commentedSettings);
      const stale = await hash(root, 'workspace.yml');
      const file = path.join(root, 'workspace.yml');
      await writeFile(file, `${await readFile(file, 'utf8')}# concurrent\n`);
      const current = await hash(root, 'workspace.yml');

      const routes: [string, unknown][] = [
        [
          '/api/backends/add',
          { name: 'new-model', type: 'openai', config: { model: 'x' } },
        ],
        [
          '/api/backends/update',
          { name: 'research-model', config: { model: 'next' } },
        ],
        ['/api/backends/remove', { name: 'research-model' }],
        ['/api/backends/default', { name: 'local-agent' }],
      ];
      for (const [route, payload] of routes) {
        const response = await postJson(baseUrl, route, {
          ...payload,
          expectedHash: stale,
        });
        expect(response.status, route).toBe(409);
        const data = response.body as {
          currentHash: string | null;
          diagnostics: Diagnostic[];
        };
        expect(data.currentHash, route).toBe(current);
        expect(
          data.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
          route,
        ).toBe(true);
      }
      expect(await hash(root, 'workspace.yml')).toBe(current);
    },
    serverTestTimeout,
  );

  it(
    'requires a well-formed expectedHash on backend writes',
    async () => {
      const { baseUrl } = await startTestServer();
      const response = await postJson(baseUrl, '/api/backends/add', {
        name: 'new-model',
        type: 'openai',
        config: { model: 'x' },
      });
      expect(response.status).toBe(400);
      expect(
        (response.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'edit.hash_required',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );
});

describe('new endpoint request gates', () => {
  it(
    'refuses cross-origin writes on the chat and backend endpoints',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatBefore = await read(root, 'chats/2026-09-10-lab-agenda.md');
      const settingsBefore = await read(root, 'workspace.yml');

      const chatAttack = await postWithHeaders(
        baseUrl,
        '/api/chats',
        {
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        { title: 'Attacker notes' },
      );
      expect(chatAttack.status).toBe(403);
      expect(
        (chatAttack.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'serve.origin_rejected',
        ),
      ).toBe(true);

      const backendAttack = await postWithHeaders(
        baseUrl,
        '/api/backends/add',
        {
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        {
          name: 'evil-model',
          type: 'openai',
          config: { model: 'x' },
          expectedHash: 'ab'.repeat(32),
        },
      );
      expect(backendAttack.status).toBe(403);

      expect(await read(root, 'chats/2026-09-10-lab-agenda.md')).toBe(
        chatBefore,
      );
      expect(await read(root, 'workspace.yml')).toBe(settingsBefore);
    },
    serverTestTimeout,
  );

  it(
    'refuses text/plain writes and leaves GET routes unaffected',
    async () => {
      const { baseUrl } = await startTestServer();

      const plain = await postWithHeaders(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        { 'content-type': 'text/plain' },
        { message: 'Hello.', expectedHash: 'ab'.repeat(32) },
      );
      expect(plain.status).toBe(415);
      expect(
        (plain.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'serve.content_type_required',
        ),
      ).toBe(true);

      const unaffected = await fetch(`${baseUrl}/api/backends`, {
        headers: { origin: 'https://attacker.example' },
      });
      expect(unaffected.status).toBe(200);
    },
    serverTestTimeout,
  );
});

describe('backend test endpoint', () => {
  it(
    'probes openai backends with redacted statuses and secret-free bodies',
    async () => {
      const { baseUrl } = await startTestServer();
      const stub = await startStubServer();
      process.env[secretEnvName] = secretEnvValue;
      let currentHash = await workspaceHash(baseUrl);
      currentHash = (
        (
          await addBackend(
            baseUrl,
            {
              name: 'stub-model',
              type: 'openai',
              config: {
                base_url: stub.url,
                model: 'test-model',
                api_key_env: secretEnvName,
              },
            },
            currentHash,
          )
        ).body as BackendSettingsSnapshot
      ).workspaceHash;
      await addBackend(
        baseUrl,
        {
          name: 'dead-model',
          type: 'openai',
          config: { base_url: 'http://127.0.0.1:1/v1', model: 'dead' },
        },
        currentHash,
      );

      const reachable = await postJson(baseUrl, '/api/backends/test', {
        name: 'stub-model',
      });
      const reachableBody = reachable.body as {
        ok: boolean;
        status: string;
        diagnostics: Diagnostic[];
      };
      expect(reachable.status).toBe(200);
      expect(reachableBody.ok).toBe(true);
      expect(reachableBody.status).toBe('reachable');
      expect(JSON.stringify(reachable.body)).not.toContain(secretEnvValue);
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.url).toBe('/v1/models');
      expect(stub.requests[0]?.method).toBe('GET');
      expect(stub.requests[0]?.headers.authorization).toBe(
        `Bearer ${secretEnvValue}`,
      );

      stub.respond(401, '{"error": "bad key"}');
      const unauthorized = await postJson(baseUrl, '/api/backends/test', {
        name: 'stub-model',
      });
      const unauthorizedBody = unauthorized.body as {
        ok: boolean;
        status: string;
      };
      expect(unauthorized.status).toBe(200);
      expect(unauthorizedBody.ok).toBe(false);
      expect(unauthorizedBody.status).toBe('reachable but unauthorized (401)');
      expect(JSON.stringify(unauthorized.body)).not.toContain(secretEnvValue);

      const unreachable = await postJson(baseUrl, '/api/backends/test', {
        name: 'dead-model',
      });
      const unreachableBody = unreachable.body as {
        ok: boolean;
        status: string;
      };
      expect(unreachable.status).toBe(200);
      expect(unreachableBody.ok).toBe(false);
      expect(unreachableBody.status).toMatch(/^unreachable: /);

      const unknown = await postJson(baseUrl, '/api/backends/test', {
        name: 'ghost-model',
      });
      expect(unknown.status).toBe(404);
      expect(
        (unknown.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.not_found',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'probes command backends through PATH resolution',
    async () => {
      const { baseUrl } = await startTestServer();
      let currentHash = await workspaceHash(baseUrl);
      currentHash = (
        (
          await addBackend(
            baseUrl,
            {
              name: 'cli-agent',
              type: 'opencode',
              config: { command: 'node' },
            },
            currentHash,
          )
        ).body as BackendSettingsSnapshot
      ).workspaceHash;
      await addBackend(
        baseUrl,
        {
          name: 'missing-agent',
          type: 'opencode',
          config: { command: 'fieldwork-definitely-missing-command-xyz' },
        },
        currentHash,
      );

      const present = await postJson(baseUrl, '/api/backends/test', {
        name: 'cli-agent',
      });
      const presentBody = present.body as { ok: boolean; status: string };
      expect(present.status).toBe(200);
      expect(presentBody.ok).toBe(true);
      expect(presentBody.status).toBe("command 'node' resolves on PATH");

      const missing = await postJson(baseUrl, '/api/backends/test', {
        name: 'missing-agent',
      });
      const missingBody = missing.body as { ok: boolean; status: string };
      expect(missing.status).toBe(200);
      expect(missingBody.ok).toBe(false);
      expect(missingBody.status).toBe(
        "command 'fieldwork-definitely-missing-command-xyz' not found on PATH",
      );
    },
    serverTestTimeout,
  );
});
