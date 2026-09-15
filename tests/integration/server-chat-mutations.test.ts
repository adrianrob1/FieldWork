import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { hashOf } from '../../src/operations/edit.js';
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
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-chatmut-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function hash(root: string, relativePath: string): Promise<string> {
  return hashOf(await readFile(path.join(root, ...relativePath.split('/'))));
}

async function appendNote(
  root: string,
  relativePath: string,
  note: string,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await writeFile(file, `${await readFile(file, 'utf8')}${note}`);
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

interface CapturedRequest {
  url: string;
  body: string;
}

interface StubServer {
  url: string;
  requests: CapturedRequest[];
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
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(cannedCompletion);
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
  };
}

async function workspaceHash(baseUrl: string): Promise<string> {
  const { body } = await getJson(baseUrl, '/api/backends');
  const view = body as BackendSettingsSnapshot;
  if (view.workspaceHash === null) {
    throw new Error('The backends view did not report a workspace hash.');
  }
  return view.workspaceHash;
}

async function addStubBackend(
  baseUrl: string,
  stub: StubServer,
): Promise<void> {
  const response = await postJson(baseUrl, '/api/backends/add', {
    name: 'stub-model',
    type: 'openai',
    config: { base_url: stub.url, model: 'test-model' },
    expectedHash: await workspaceHash(baseUrl),
  });
  expect(response.status).toBe(201);
}

function diagnosticsOf(body: unknown): Diagnostic[] {
  return (body as { diagnostics: Diagnostic[] }).diagnostics;
}

describe('chat send attachments API', () => {
  it(
    'sends augmented text, stores chip metadata, and returns the exchange only',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      await addStubBackend(baseUrl, stub);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Summarize the scaling notes.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
          attachments: [{ id: 'resource_soap_scaling' }],
        },
      );
      const data = body as {
        contentHash: string | null;
        exchange: {
          user: {
            role: string;
            text: string;
            metadata: {
              attachments: {
                id?: string;
                path?: string;
                label: string;
                kind: string;
                title: string;
              }[];
            } | null;
          };
          assistant: { role: string; text: string; metadata: unknown };
        };
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.contentHash).toBe(await hash(root, chatPath));
      expect(data.exchange.user.role).toBe('user');
      expect(data.exchange.user.text).toBe('Summarize the scaling notes.');
      const stored = data.exchange.user.metadata?.attachments[0];
      expect(stored?.id).toBe('resource_soap_scaling');
      expect(stored?.path).toBe('projects/soap-bubbles/context/scaling.md');
      expect(stored?.label).toBe('Scaling notes');
      expect(stored?.label.includes('/')).toBe(false);
      expect(stored?.label.includes('\\')).toBe(false);
      expect(stored?.kind).toBe('resource');
      expect(stored?.title).toBe('Scaling notes');
      expect(data.exchange.assistant.role).toBe('assistant');
      expect(data.exchange.assistant.text).toContain('Triffid marker reply');
      expect('messages' in data).toBe(false);
      expect('appendedCount' in data).toBe(false);
      expect('reply' in data).toBe(false);
      expect(
        data.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const contents = await read(root, chatPath);
      expect(contents).toContain('label: Scaling notes');
      expect(contents).toContain(
        'path: projects/soap-bubbles/context/scaling.md',
      );
      expect(contents).toContain('Summarize the scaling notes.');

      expect(stub.requests).toHaveLength(1);
      const sentBody = JSON.parse(stub.requests[0]?.body ?? '{}') as {
        messages: { role: string; content: string }[];
      };
      const sent = sentBody.messages.at(-1);
      expect(sent?.role).toBe('user');
      expect(sent?.content).toContain('<fieldwork_workspace>');
      expect(sent?.content).toContain(baseUrl);
      expect(sent?.content).toContain(
        '<attachment kind="resource" title="Scaling notes">',
      );
    },
    serverTestTimeout,
  );

  it(
    'rejects malformed attachment references with 400 and attachment.invalid',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      await addStubBackend(baseUrl, stub);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const chatHash = await hash(root, chatPath);
      const before = await read(root, chatPath);

      const cases: unknown[] = [
        'nope',
        [{}],
        [
          {
            id: 'resource_soap_scaling',
            path: 'projects/soap-bubbles/context/scaling.md',
          },
        ],
        [{ id: 5 }],
      ];
      for (const attachments of cases) {
        const response = await postJson(
          baseUrl,
          '/api/chats/chat_lab_agenda/messages',
          {
            message: 'Hello.',
            backend: 'stub-model',
            expectedHash: chatHash,
            attachments,
          },
        );
        expect(response.status, String(JSON.stringify(attachments))).toBe(400);
        expect(
          diagnosticsOf(response.body).some(
            (entry) => entry.code === 'attachment.invalid',
          ),
          String(JSON.stringify(attachments)),
        ).toBe(true);
      }

      expect(await read(root, chatPath)).toBe(before);
      expect(stub.requests).toHaveLength(0);
    },
    serverTestTimeout,
  );

  it(
    'returns 422 for unresolvable attachments and leaves the transcript unchanged',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
      await addStubBackend(baseUrl, stub);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await hash(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Hello.',
          backend: 'stub-model',
          expectedHash: before,
          attachments: [{ id: 'resource_ghost_nowhere' }],
        },
      );

      expect(status).toBe(422);
      expect(
        diagnosticsOf(body).some(
          (entry) => entry.code === 'attachment.missing',
        ),
      ).toBe(true);
      expect(await hash(root, chatPath)).toBe(before);
      expect(stub.requests).toHaveLength(0);
    },
    serverTestTimeout,
  );
});

describe('chat attach hash contract', () => {
  it(
    'requires a well-formed expectedHash with 400',
    async () => {
      const { baseUrl } = await startTestServer();
      const missing = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 'project_soap_bubbles' },
      );
      expect(missing.status).toBe(400);
      expect(
        diagnosticsOf(missing.body).some(
          (entry) => entry.code === 'edit.hash_required',
        ),
      ).toBe(true);

      const malformed = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 'project_soap_bubbles', expectedHash: 'not-a-hash' },
      );
      expect(malformed.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'reports stale hashes as 409 with the current hash and writes nothing',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const stale = await hash(root, chatPath);
      await appendNote(root, chatPath, 'Concurrent note.\n');
      const current = await hash(root, chatPath);
      const contents = await read(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        { projectId: 'project_soap_bubbles', expectedHash: stale },
      );

      expect(status).toBe(409);
      const data = body as { currentHash: string | null };
      expect(data.currentHash).toBe(current);
      expect(
        diagnosticsOf(body).some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
      expect(await read(root, chatPath)).toBe(contents);
      expect(await read(root, chatPath)).not.toContain(
        '- project_soap_bubbles',
      );
    },
    serverTestTimeout,
  );

  it(
    'attaches with a fresh hash and returns the chat view',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        {
          projectId: 'project_soap_bubbles',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(status).toBe(200);
      const attached = body as ChatDetailViewData & {
        diagnostics: Diagnostic[];
      };
      expect(attached.projects).toContain('project_soap_bubbles');
      expect(attached.contentHash).toBe(await hash(root, chatPath));
      expect(await read(root, chatPath)).toContain('- project_soap_bubbles');
    },
    serverTestTimeout,
  );
});

describe('chat detach hash contract', () => {
  it(
    'requires expectedHash, refuses stale hashes, and detaches when fresh',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const attachHash = await hash(root, chatPath);
      const attach = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/attach',
        {
          projectId: 'project_soap_bubbles',
          expectedHash: attachHash,
        },
      );
      expect(attach.status).toBe(200);

      const missing = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/detach',
        { projectId: 'project_soap_bubbles' },
      );
      expect(missing.status).toBe(400);
      expect(
        diagnosticsOf(missing.body).some(
          (entry) => entry.code === 'edit.hash_required',
        ),
      ).toBe(true);

      const stale = await hash(root, chatPath);
      await appendNote(root, chatPath, 'Concurrent note.\n');
      const current = await hash(root, chatPath);
      const contents = await read(root, chatPath);
      const staleResponse = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/detach',
        { projectId: 'project_soap_bubbles', expectedHash: stale },
      );
      expect(staleResponse.status).toBe(409);
      const staleBody = staleResponse.body as { currentHash: string | null };
      expect(staleBody.currentHash).toBe(current);
      expect(
        diagnosticsOf(staleResponse.body).some(
          (entry) => entry.code === 'edit.stale_hash',
        ),
      ).toBe(true);
      expect(await read(root, chatPath)).toBe(contents);
      expect(await read(root, chatPath)).toContain('- project_soap_bubbles');

      const fresh = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/detach',
        { projectId: 'project_soap_bubbles', expectedHash: current },
      );
      expect(fresh.status).toBe(200);
      const detached = fresh.body as ChatDetailViewData;
      expect(detached.projects).not.toContain('project_soap_bubbles');
      expect(detached.contentHash).toBe(await hash(root, chatPath));
      expect(await read(root, chatPath)).not.toContain(
        '- project_soap_bubbles',
      );
    },
    serverTestTimeout,
  );
});

describe('chat promote hash contract', () => {
  it(
    'requires a well-formed expectedHash with 400 and creates nothing',
    async () => {
      const { root, baseUrl } = await startTestServer();

      const missing = await postJson(
        baseUrl,
        '/api/chats/chat_rank_diagnostics/promote',
        { id: 'project_mutation_promoted', title: 'Mutation promoted' },
      );
      expect(missing.status).toBe(400);
      expect(
        diagnosticsOf(missing.body).some(
          (entry) => entry.code === 'edit.hash_required',
        ),
      ).toBe(true);
      await expect(
        read(root, 'projects/mutation-promoted/project.yml'),
      ).rejects.toThrow();
    },
    serverTestTimeout,
  );

  it(
    'reports stale hashes as 409 with the current hash and creates no project',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';
      const stale = await hash(root, chatPath);
      await appendNote(root, chatPath, 'Concurrent note.\n');
      const current = await hash(root, chatPath);
      const contents = await read(root, chatPath);

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_rank_diagnostics/promote',
        {
          id: 'project_mutation_promoted',
          title: 'Mutation promoted',
          directory: 'mutation-promoted',
          expectedHash: stale,
        },
      );

      expect(status).toBe(409);
      const data = body as { currentHash: string | null };
      expect(data.currentHash).toBe(current);
      expect(
        diagnosticsOf(body).some((entry) => entry.code === 'edit.stale_hash'),
      ).toBe(true);
      expect(await read(root, chatPath)).toBe(contents);
      await expect(
        read(root, 'projects/mutation-promoted/project.yml'),
      ).rejects.toThrow();
    },
    serverTestTimeout,
  );

  it(
    'promotes with a fresh hash and returns the project registration',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const chatPath = 'chats/2026-09-02-rank-diagnostics.md';

      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_rank_diagnostics/promote',
        {
          id: 'project_mutation_promoted',
          title: 'Mutation promoted',
          directory: 'mutation-promoted',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(status).toBe(200);
      const data = body as {
        chat: ChatDetailViewData;
        project: { id: string; title: string; directory: string };
      };
      expect(data.project.id).toBe('project_mutation_promoted');
      expect(data.project.directory).toBe('mutation-promoted');
      expect(data.chat.projects).toContain('project_mutation_promoted');
      expect(await read(root, chatPath)).toContain(
        '- project_mutation_promoted',
      );
      expect(
        await read(root, 'projects/mutation-promoted/project.yml'),
      ).toContain('id: project_mutation_promoted');
    },
    serverTestTimeout,
  );
});
