import { createServer, type Server } from 'node:http';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { indexPath } from '../../src/index/paths.js';
import type {
  BackendSettingsEntry,
  BackendSettingsSnapshot,
} from '../../src/operations/backendSettings.js';
import { hashOf } from '../../src/operations/edit.js';
import { startServer, type ServerHandle } from '../../src/server/server.js';

type BackendListEntry = BackendSettingsEntry & { credentialReady: boolean };

interface BackendListView extends Omit<BackendSettingsSnapshot, 'backends'> {
  backends: BackendListEntry[];
  diagnostics: Diagnostic[];
}

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
const credentialValue = 'fieldwork-test-secret-value';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-credentials-'));
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
  view: BackendListView;
}> {
  const { status, body } = await getJson(baseUrl, '/api/backends');
  return {
    status,
    view: body as BackendListView,
  };
}

async function workspaceHash(baseUrl: string): Promise<string> {
  const { view } = await listBackends(baseUrl);
  if (view.workspaceHash === null) {
    throw new Error('The backends view did not report a workspace hash.');
  }
  return view.workspaceHash;
}

async function setCredential(
  baseUrl: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  return postJson(baseUrl, '/api/backends/credential', payload);
}

describe('backend credential endpoint', () => {
  it(
    'stores a session credential and reports credentialReady per backend',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
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
          name: 'other-model',
          type: 'openai',
          config: { base_url: stub.url, model: 'other-model' },
        },
        currentHash,
      );

      const before = await listBackends(baseUrl);
      expect(
        before.view.backends.map((entry) => entry.credentialReady),
      ).toEqual([false, false]);

      const stored = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: credentialValue,
      });
      const storedBody = stored.body as {
        ok: boolean;
        stored: boolean;
        sessionOnly: boolean;
        diagnostics: Diagnostic[];
      };
      expect(stored.status).toBe(200);
      expect(storedBody).toEqual({
        ok: true,
        stored: true,
        sessionOnly: true,
        diagnostics: [],
      });
      expect(JSON.stringify(stored.body)).not.toContain(credentialValue);

      const { view } = await listBackends(baseUrl);
      expect(
        view.backends.find((entry) => entry.name === 'stub-model')
          ?.credentialReady,
      ).toBe(true);
      expect(
        view.backends.find((entry) => entry.name === 'other-model')
          ?.credentialReady,
      ).toBe(false);
      expect(JSON.stringify(view)).not.toContain(credentialValue);
      expect(JSON.stringify(view)).not.toContain(secretEnvValue);
      expect(await read(root, 'workspace.yml')).not.toContain(credentialValue);
    },
    serverTestTimeout,
  );

  it(
    'rejects unknown backends, empty keys, and malformed payloads',
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

      const unknown = await setCredential(baseUrl, {
        name: 'ghost-model',
        apiKey: credentialValue,
      });
      expect(unknown.status).toBe(404);
      expect(
        (unknown.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.not_found',
        ),
      ).toBe(true);

      const empty = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: '',
      });
      expect(empty.status).toBe(422);
      expect(
        (empty.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.credential_empty',
        ),
      ).toBe(true);

      const blank = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: '   ',
      });
      expect(blank.status).toBe(422);
      expect(
        (blank.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'backend.credential_empty',
        ),
      ).toBe(true);

      const notAString = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: 42,
      });
      expect(notAString.status).toBe(400);

      const nullKey = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: null,
      });
      expect(nullKey.status).toBe(400);

      const missingName = await setCredential(baseUrl, {
        apiKey: credentialValue,
      });
      expect(missingName.status).toBe(400);

      const { view } = await listBackends(baseUrl);
      expect(view.backends.map((entry) => entry.credentialReady)).toEqual([
        false,
      ]);
      expect(await read(root, 'workspace.yml')).not.toContain(credentialValue);
    },
    serverTestTimeout,
  );

  it(
    'applies the same-origin and JSON content-type gates',
    async () => {
      const { baseUrl } = await startTestServer();
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

      const crossOrigin = await postWithHeaders(
        baseUrl,
        '/api/backends/credential',
        {
          origin: 'https://attacker.example',
          'content-type': 'application/json',
        },
        { name: 'stub-model', apiKey: credentialValue },
      );
      expect(crossOrigin.status).toBe(403);
      expect(
        (crossOrigin.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'serve.origin_rejected',
        ),
      ).toBe(true);

      const plain = await postWithHeaders(
        baseUrl,
        '/api/backends/credential',
        { 'content-type': 'text/plain' },
        { name: 'stub-model', apiKey: credentialValue },
      );
      expect(plain.status).toBe(415);
      expect(
        (plain.body as { diagnostics: Diagnostic[] }).diagnostics.some(
          (entry) => entry.code === 'serve.content_type_required',
        ),
      ).toBe(true);

      const { view } = await listBackends(baseUrl);
      expect(view.backends.map((entry) => entry.credentialReady)).toEqual([
        false,
      ]);
    },
    serverTestTimeout,
  );
});

describe('session credential use in chat sends', () => {
  it(
    'sends the session credential instead of the env var and never persists it',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
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
        await workspaceHash(baseUrl),
      );
      process.env[secretEnvName] = secretEnvValue;
      const stored = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: credentialValue,
      });
      expect(stored.status).toBe(200);

      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await hash(root, chatPath);
      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'What is the agenda for Thursday?',
          backend: 'stub-model',
          expectedHash: before,
        },
      );
      const data = body as {
        chatId: string;
        backend: string;
        exchange: {
          user: { role: string; text: string; metadata: unknown };
          assistant: { role: string; text: string; metadata: unknown };
        };
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(data.backend).toBe('stub-model');
      expect(data.exchange.assistant.text).toContain('Triffid marker reply');
      expect(
        data.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.url).toBe('/v1/chat/completions');
      expect(stub.requests[0]?.headers.authorization).toBe(
        `Bearer ${credentialValue}`,
      );

      expect(JSON.stringify(body)).not.toContain(credentialValue);
      expect(JSON.stringify(body)).not.toContain(secretEnvValue);
      expect(await read(root, chatPath)).not.toContain(credentialValue);
      expect(await read(root, 'workspace.yml')).not.toContain(credentialValue);
    },
    serverTestTimeout,
  );

  it(
    'fails the send with backend.api_key_missing when neither session credential nor env var is set',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const stub = await startStubServer();
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
        await workspaceHash(baseUrl),
      );

      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await hash(root, chatPath);
      const { status, body } = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Hello without any credential.',
          backend: 'stub-model',
          expectedHash: before,
        },
      );
      const data = body as { diagnostics: Diagnostic[] };

      expect(status).toBe(502);
      expect(
        data.diagnostics.some(
          (entry) => entry.code === 'backend.api_key_missing',
        ),
      ).toBe(true);
      expect(JSON.stringify(body)).not.toContain(credentialValue);
      expect(stub.requests).toHaveLength(0);
      expect(await hash(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'keeps the credential out of the workspace index database after a send',
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
      const stored = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: credentialValue,
      });
      expect(stored.status).toBe(200);

      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const sent = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Index sweep marker exchange.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );
      expect(sent.status).toBe(200);

      const databaseBytes = await readFile(indexPath(root));
      expect(databaseBytes.length).toBeGreaterThan(0);
      expect(databaseBytes.toString('latin1')).not.toContain(credentialValue);
    },
    serverTestTimeout,
  );
});

describe('session credential use in backend tests', () => {
  it(
    'probes with the session credential and still redacts unauthorized responses',
    async () => {
      const { baseUrl } = await startTestServer();
      const stub = await startStubServer();
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
        await workspaceHash(baseUrl),
      );
      process.env[secretEnvName] = secretEnvValue;
      const stored = await setCredential(baseUrl, {
        name: 'stub-model',
        apiKey: credentialValue,
      });
      expect(stored.status).toBe(200);

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
      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0]?.url).toBe('/v1/models');
      expect(stub.requests[0]?.method).toBe('GET');
      expect(stub.requests[0]?.headers.authorization).toBe(
        `Bearer ${credentialValue}`,
      );
      expect(JSON.stringify(reachable.body)).not.toContain(credentialValue);
      expect(JSON.stringify(reachable.body)).not.toContain(secretEnvValue);

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
      expect(JSON.stringify(unauthorized.body)).not.toContain(credentialValue);
      expect(JSON.stringify(unauthorized.body)).not.toContain(secretEnvValue);
    },
    serverTestTimeout,
  );
});
