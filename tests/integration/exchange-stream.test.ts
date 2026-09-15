import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { hashOf } from '../../src/operations/edit.js';
import type { DraftView } from '../../src/operations/drafts.js';
import { todayDate } from '../../src/operations/start.js';
import { parseTranscript } from '../../src/files/transcript.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-stream-'));
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

async function startTestServer(root: string): Promise<{
  root: string;
  baseUrl: string;
}> {
  const handle = await startServer(root, { host: '127.0.0.1', port: 0 });
  runningHandles.push(handle);
  return { root, baseUrl: handle.url };
}

async function postJson(
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, headers: response.headers, body };
}

interface StreamEvent {
  event: Record<string, unknown>;
  at: number;
}

async function postNdjson(
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<{
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  events: StreamEvent[];
}> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify(payload),
  });
  const started = Date.now();
  const events: StreamEvent[] = [];
  if (response.body !== null) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) {
          events.push({
            event: JSON.parse(line) as Record<string, unknown>,
            at: Date.now() - started,
          });
        }
        index = buffer.indexOf('\n');
      }
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'),
    events,
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface StubServer {
  url: string;
  requests: CapturedRequest[];
}

interface StubOptions {
  canned: string;
  streamParts?: string[] | undefined;
  // reasoning_content chunks emitted before the content phase.
  streamThoughtParts?: string[] | undefined;
  failAfterFirstDelta?: boolean | undefined;
  failStatus?: number | undefined;
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

async function startStubServer(options: StubOptions): Promise<StubServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      requests.push({ url: request.url ?? '', headers, body });
      const parsed = JSON.parse(body) as { stream?: boolean };
      if (parsed.stream === true && options.failStatus !== undefined) {
        response.writeHead(options.failStatus, {
          'content-type': 'application/json',
        });
        response.end(JSON.stringify({ error: 'stub unavailable' }));
        return;
      }
      if (parsed.stream !== true || options.streamParts === undefined) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(options.canned);
        return;
      }
      const parts = options.streamParts;
      const thoughts = options.streamThoughtParts ?? [];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      let index = 0;
      let thoughtIndex = 0;
      const tick = (): void => {
        if (thoughtIndex < thoughts.length) {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { reasoning_content: thoughts[thoughtIndex] },
                },
              ],
            })}\n\n`,
          );
          thoughtIndex += 1;
          setTimeout(tick, 40);
          return;
        }
        if (index < parts.length) {
          response.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: parts[index] } }],
            })}\n\n`,
          );
          index += 1;
          if (options.failAfterFirstDelta === true && index === 1) {
            setTimeout(() => response.destroy(), 20);
            return;
          }
          setTimeout(tick, 40);
          return;
        }
        response.write(
          `data: ${JSON.stringify({
            model: 'stub-model-v2',
            usage: { total_tokens: 19 },
          })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
      };
      tick();
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
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function writeOpencodeStub(root: string): Promise<string> {
  const script = path.join(root, 'opencode-stub.cjs');
  await writeFile(
    script,
    [
      "const parts = ['Opencode ', 'streamed ', 'reply.'];",
      'let index = 0;',
      'const emit = () => {',
      '  if (index < parts.length) {',
      "    process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_stub', part: { type: 'text', text: parts[index] } }) + '\\n');",
      '    index += 1;',
      '    setTimeout(emit, 60);',
      '    return;',
      '  }',
      "  process.stdout.write(JSON.stringify({ type: 'step_finish', sessionID: 'ses_stub', part: { type: 'step-finish', tokens: { total: 5 } } }) + '\\n');",
      '  setTimeout(() => process.exit(0), 10);',
      '};',
      'emit();',
      '',
    ].join('\n'),
  );
  return script;
}

async function writeAcpStub(
  root: string,
  thoughts: string[] = [],
  models: { modelId: string; name: string }[] = [],
): Promise<string> {
  const script = path.join(root, 'acp-stub.cjs');
  await writeFile(
    script,
    [
      "const readline = require('node:readline');",
      'const rl = readline.createInterface({ input: process.stdin });',
      'const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      `const models = ${JSON.stringify(models)};`,
      "rl.on('line', (line) => {",
      '  let message;',
      '  try { message = JSON.parse(line); } catch { return; }',
      "  if (message.method === 'initialize') { send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }); return; }",
      "  if (message.method === 'session/set_model') { send({ jsonrpc: '2.0', id: message.id, result: {} }); return; }",
      "  if (message.method === 'session/new') { send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'ses_stub', models: { availableModels: models } } }); return; }",
      "  if (message.method === 'session/prompt') {",
      `    const thoughts = ${JSON.stringify(thoughts)};`,
      "    const parts = ['Agent ', 'streamed ', 'reply.'];",
      '    let index = 0;',
      '    let thoughtIndex = 0;',
      '    const tick = () => {',
      '      if (thoughtIndex < thoughts.length) {',
      "        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_stub', update: { sessionUpdate: 'agent_thought_chunk', messageId: 't1', content: { type: 'text', text: thoughts[thoughtIndex] } } } });",
      '        thoughtIndex += 1;',
      '        setTimeout(tick, 60);',
      '        return;',
      '      }',
      '      if (index < parts.length) {',
      "        send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_stub', update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: parts[index] } } } });",
      '        index += 1;',
      '        setTimeout(tick, 60);',
      '        return;',
      '      }',
      "      send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });",
      '      setTimeout(() => process.exit(0), 10);',
      '    };',
      '    tick();',
      '    return;',
      '  }',
      "  if (message.id !== undefined) { send({ jsonrpc: '2.0', id: message.id, result: null }); }",
      '});',
      '',
    ].join('\n'),
  );
  return script;
}

async function useBackend(root: string, lines: string[]): Promise<void> {
  await write(
    root,
    'workspace.yml',
    [
      'version: 1',
      'title: Optimizer research sample',
      'paths:',
      '  projects: projects',
      '  chats: chats',
      '  topics: topics',
      '  inbox: inbox',
      '  external: external',
      'backends:',
      '  default: stub-model',
      '  entries:',
      '    stub-model:',
      ...lines.map((line) => `      ${line}`),
      '',
    ].join('\n'),
  );
}

function deltaTexts(events: StreamEvent[]): string[] {
  return events
    .filter((entry) => entry.event.type === 'delta')
    .map((entry) => String(entry.event.text));
}

function deltaKinds(events: StreamEvent[]): string[] {
  return events
    .filter((entry) => entry.event.type === 'delta')
    .map((entry) => (entry.event.kind === 'thought' ? 'thought' : 'message'));
}

function deltaTextsOfKind(
  events: StreamEvent[],
  kind: 'message' | 'thought',
): string[] {
  return events
    .filter((entry) => entry.event.type === 'delta')
    .filter((entry) =>
      kind === 'thought'
        ? entry.event.kind === 'thought'
        : entry.event.kind !== 'thought',
    )
    .map((entry) => String(entry.event.text));
}

describe('chat message NDJSON streaming', () => {
  it(
    'streams openai deltas in order and ends with the committed result',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        streamParts: ['Streaming ', 'openai ', 'answer.'],
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await hash(root, chatPath);

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Stream please.',
          backend: 'stub-model',
          expectedHash: before,
        },
      );

      expect(result.status).toBe(200);
      expect(result.contentType).toContain('application/x-ndjson');
      expect(result.cacheControl).toBe('no-store');

      const deltas = deltaTexts(result.events);
      expect(deltas).toEqual(['Streaming ', 'openai ', 'answer.']);
      const last = result.events.at(-1)?.event;
      expect(last?.type).toBe('done');
      const done = last?.result as {
        contentHash: string | null;
        exchange: { assistant: { text: string } };
        diagnostics: Diagnostic[];
      };
      expect(done.contentHash).toBe(await hash(root, chatPath));
      expect(done.exchange.assistant.text).toBe(deltas.join(''));
      expect(Array.isArray(done.diagnostics)).toBe(true);

      const parsed = JSON.parse(stub.requests[0]?.body ?? '{}') as {
        stream?: boolean;
      };
      expect(parsed.stream).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'streams opencode events before completion and ends with done',
    async () => {
      const root = await copySampleWorkspace();
      const script = await writeOpencodeStub(root);
      await useBackend(root, [
        'type: opencode',
        'command: node',
        `args: [${JSON.stringify(script.replace(/\\/g, '/'))}]`,
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Stream please.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      const deltas = deltaTexts(result.events);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join('')).toContain('Opencode');
      expect(deltas.join('')).toContain('streamed');
      expect(deltas.join('')).toContain('reply.');
      expect(result.events.at(-1)?.event.type).toBe('done');
      const doneAt = result.events.at(-1)?.at ?? 0;
      const firstDeltaAt = result.events[0]?.at ?? 0;
      expect(doneAt).toBeGreaterThan(firstDeltaAt);

      const done = result.events.at(-1)?.event.result as {
        exchange: { assistant: { text: string } };
      };
      expect(done.exchange.assistant.text).toBe(deltas.join(''));
    },
    serverTestTimeout,
  );

  it(
    'streams agent (ACP) chunks before completion and ends with done',
    async () => {
      const root = await copySampleWorkspace();
      const script = await writeAcpStub(root);
      await useBackend(root, [
        'type: agent',
        'command: node',
        `args: [${JSON.stringify(script.replace(/\\/g, '/'))}]`,
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Stream please.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      const deltas = deltaTexts(result.events);
      expect(deltas.join('')).toBe('Agent streamed reply.');
      expect(result.events.at(-1)?.event.type).toBe('done');
      const done = result.events.at(-1)?.event.result as {
        exchange: { assistant: { text: string } };
      };
      expect(done.exchange.assistant.text).toBe(deltas.join(''));
    },
    serverTestTimeout,
  );

  it(
    'streams thought then message kinds and records the trimmed thought on the exchange',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        streamThoughtParts: ['\n\n', 'Weighing ', 'options. '],
        streamParts: ['Final ', 'answer.'],
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Think then answer.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      // The whitespace-only lead-in never reaches the stream.
      expect(deltaTextsOfKind(result.events, 'thought').join('')).toBe(
        'Weighing options. ',
      );
      expect(deltaTextsOfKind(result.events, 'message').join('')).toBe(
        'Final answer.',
      );
      const done = result.events.at(-1)?.event.result as {
        exchange: { assistant: { text: string } };
      };
      expect(done.exchange.assistant.text).toBe('Final answer.');
      expect(done.exchange.assistant.text).not.toContain('Weighing');
      const parsed = parseTranscript(await read(root, chatPath), chatPath);
      const assistant = parsed.messages
        .filter((message) => message.role === 'assistant')
        .at(-1);
      expect(assistant?.metadata?.thought).toBe('Weighing options.');
      expect(assistant?.text).not.toContain('Weighing');
    },
    serverTestTimeout,
  );

  it(
    'streams ACP thought chunks before the message and records them trimmed',
    async () => {
      const root = await copySampleWorkspace();
      const script = await writeAcpStub(root, [
        '\n\n',
        'Considering ',
        'carefully. ',
      ]);
      await useBackend(root, [
        'type: agent',
        'command: node',
        `args: [${JSON.stringify(script.replace(/\\/g, '/'))}]`,
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Think then reply.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      expect(deltaKinds(result.events)[0]).toBe('thought');
      // The whitespace-only lead-in chunk is dropped before the first visible
      // reasoning, so the trace starts without blank lines.
      expect(deltaTextsOfKind(result.events, 'thought').join('')).toBe(
        'Considering carefully. ',
      );
      expect(deltaTextsOfKind(result.events, 'message').join('')).toBe(
        'Agent streamed reply.',
      );
      const done = result.events.at(-1)?.event.result as {
        exchange: { assistant: { text: string } };
      };
      expect(done.exchange.assistant.text).toBe('Agent streamed reply.');
      const parsed = parseTranscript(await read(root, chatPath), chatPath);
      const assistant = parsed.messages
        .filter((message) => message.role === 'assistant')
        .at(-1);
      expect(assistant?.metadata?.thought).toBe('Considering carefully.');
      expect(assistant?.text).not.toContain('Considering');
    },
    serverTestTimeout,
  );

  it(
    'lists harness models for the settings picker',
    async () => {
      const root = await copySampleWorkspace();
      const script = await writeAcpStub(
        root,
        [],
        [
          { modelId: 'gpt-6-astra[low]', name: '6 Astra (low)' },
          { modelId: 'gpt-6-astra[high]', name: '6 Astra (high)' },
        ],
      );
      const { baseUrl } = await startTestServer(root);

      const response = await postJson(baseUrl, '/api/backends/models', {
        command: 'node',
        args: [script.replace(/\\/g, '/')],
      });

      expect(response.status).toBe(200);
      const body = response.body as {
        models: {
          id: string;
          name: string | null;
          description: string | null;
        }[];
      };
      expect(body.models).toEqual([
        { id: 'gpt-6-astra[low]', name: '6 Astra (low)', description: null },
        { id: 'gpt-6-astra[high]', name: '6 Astra (high)', description: null },
      ]);
    },
    serverTestTimeout,
  );

  it(
    'answers 422 with a diagnostic when the harness cannot start',
    async () => {
      const root = await copySampleWorkspace();
      const { baseUrl } = await startTestServer(root);

      const response = await postJson(baseUrl, '/api/backends/models', {
        command: 'fieldwork-no-such-harness',
      });

      expect(response.status).toBe(422);
      const body = response.body as {
        diagnostics: { code: string; message: string }[];
      };
      expect(body.diagnostics[0]?.code).toBe('backend.request_failed');
    },
    serverTestTimeout,
  );

  it(
    'rejects a models request without a command',
    async () => {
      const root = await copySampleWorkspace();
      const { baseUrl } = await startTestServer(root);

      const response = await postJson(baseUrl, '/api/backends/models', {
        command: '',
      });

      expect(response.status).toBe(400);
    },
    serverTestTimeout,
  );

  it(
    'emits a terminal error event and writes nothing when the stream breaks',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        streamParts: ['Partial ', 'answer.'],
        failAfterFirstDelta: true,
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await read(root, chatPath);

      const result = await postNdjson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Break midway.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      const first = result.events[0]?.event;
      expect(first?.type).toBe('delta');
      const last = result.events.at(-1)?.event;
      expect(last?.type).toBe('error');
      expect(last?.status).toBe(502);
      expect(typeof last?.errorText).toBe('string');
      expect(
        (last?.diagnostics as Diagnostic[]).some((entry) =>
          entry.code.startsWith('backend.'),
        ),
      ).toBe(true);

      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'keeps a stale expectedHash as a plain JSON 409',
    async () => {
      const root = await copySampleWorkspace();
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const stale = await hash(root, chatPath);
      const file = path.join(root, chatPath);
      await writeFile(file, `${await readFile(file, 'utf8')}Concurrent.\n`);
      const current = await hash(root, chatPath);

      const response = await fetch(
        `${baseUrl}/api/chats/chat_lab_agenda/messages`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/x-ndjson',
          },
          body: JSON.stringify({ message: 'Too late.', expectedHash: stale }),
        },
      );
      const body = (await response.json()) as {
        currentHash: string | null;
        diagnostics: Diagnostic[];
      };

      expect(response.status).toBe(409);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(response.headers.get('content-type')).not.toContain('ndjson');
      expect(body.currentHash).toBe(current);
    },
    serverTestTimeout,
  );

  it(
    'keeps the default JSON behavior without an Accept header',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({ canned: cannedCompletion });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';

      const result = await postJson(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Plain please.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(result.status).toBe(200);
      expect(result.headers.get('content-type')).toContain('application/json');
      expect(result.headers.get('content-type')).not.toContain('ndjson');
      const body = result.body as {
        contentHash: string | null;
        exchange: { assistant: { text: string } };
      };
      expect(body.exchange.assistant.text).toBe(
        'Triffid marker reply about posterior diagnostics.',
      );
      const parsed = JSON.parse(stub.requests[0]?.body ?? '{}') as {
        stream?: boolean;
      };
      expect('stream' in parsed).toBe(false);
    },
    serverTestTimeout,
  );
});

describe('draft submit NDJSON streaming', () => {
  it(
    'emits created, then deltas, then the committed result',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        streamParts: ['Draft ', 'streamed ', 'reply.'],
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);

      const created = await postJson(baseUrl, '/api/drafts', {
        message: 'Please stream the draft',
      });
      const draft = (created.body as { draft: DraftView }).draft;

      const result = await postNdjson(
        baseUrl,
        `/api/drafts/${draft.draft.id}/submit`,
        { expectedHash: draft.contentHash },
      );

      expect(result.status).toBe(200);
      expect(result.events[0]?.event.type).toBe('created');
      const createdEvent = result.events[0]?.event.chat as {
        chatId: string;
        title: string;
        file: string;
        contentHash: string | null;
      };
      expect(createdEvent.chatId).toBe('please_stream_the_draft');
      expect(createdEvent.contentHash).toBeNull();

      const deltas = deltaTexts(result.events);
      expect(deltas).toEqual(['Draft ', 'streamed ', 'reply.']);

      const last = result.events.at(-1)?.event;
      expect(last?.type).toBe('done');
      const done = last?.result as {
        chat: { chatId: string; contentHash: string | null };
        exchange: { assistant: { text: string } };
        draftConsumed: boolean;
        diagnostics: Diagnostic[];
      };
      expect(done.chat.chatId).toBe('please_stream_the_draft');
      expect(done.chat.contentHash).not.toBeNull();
      expect(done.chat.contentHash).toBe(
        await hash(root, `chats/${todayDate()}-please-stream-the-draft.md`),
      );
      expect(done.exchange.assistant.text).toBe(deltas.join(''));
      expect(done.draftConsumed).toBe(true);

      const draftAfter = await fetch(`${baseUrl}/api/drafts/${draft.draft.id}`);
      expect(draftAfter.status).toBe(404);
    },
    serverTestTimeout,
  );

  it(
    'preserves the draft and reports an error event when the backend fails',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        failStatus: 502,
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const created = await postJson(baseUrl, '/api/drafts', {
        message: 'Backend outage draft',
      });
      const draft = (created.body as { draft: DraftView }).draft;

      const result = await postNdjson(
        baseUrl,
        `/api/drafts/${draft.draft.id}/submit`,
        { expectedHash: draft.contentHash },
      );

      expect(result.status).toBe(200);
      expect(
        result.events.some((entry) => entry.event.type === 'created'),
      ).toBe(true);
      const last = result.events.at(-1)?.event;
      expect(last?.type).toBe('error');
      expect(last?.status).toBe(502);

      const intact = await fetch(`${baseUrl}/api/drafts/${draft.draft.id}`);
      expect(intact.status).toBe(200);
    },
    serverTestTimeout,
  );
});

interface AbortOutcome {
  events: StreamEvent[];
  aborted: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Send an NDJSON request, read until the first delta, then abort the client
// connection so the server sees a mid-stream disconnect.
async function postNdjsonAbortAfterFirstDelta(
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<AbortOutcome> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  });
  const events: StreamEvent[] = [];
  if (response.body === null) return { events, aborted: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    outer: for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim().length > 0) {
          events.push({
            event: JSON.parse(line) as Record<string, unknown>,
            at: 0,
          });
          const last = events[events.length - 1]?.event;
          if (last?.type === 'delta') {
            controller.abort();
            break outer;
          }
        }
        index = buffer.indexOf('\n');
      }
    }
  } catch {
    // The abort tears the read down; the events so far are what we assert on.
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { events, aborted: true };
}

async function writeCancelableOpencodeStub(root: string): Promise<{
  script: string;
  pidFile: string;
}> {
  const script = path.join(root, 'opencode-cancel-stub.cjs');
  const pidFile = path.join(root, 'opencode-cancel.pid');
  await writeFile(
    script,
    [
      "const fs = require('node:fs');",
      'const pidFile = process.argv[2];',
      'fs.writeFileSync(pidFile, String(process.pid));',
      'let index = 0;',
      'const tick = () => {',
      '  fs.appendFileSync(pidFile + ".ticks", "tick\\n");',
      "  process.stdout.write(JSON.stringify({ type: 'text', sessionID: 'ses_stub', part: { type: 'text', text: 'chunk ' + index + ' ' } }) + '\\n');",
      '  index += 1;',
      '  setTimeout(tick, 40);',
      '};',
      'tick();',
      '',
    ].join('\n'),
  );
  return { script, pidFile };
}

describe('stream cancellation on client disconnect', () => {
  it(
    'kills the opencode child and writes nothing when the client disconnects',
    async () => {
      const root = await copySampleWorkspace();
      const { script, pidFile } = await writeCancelableOpencodeStub(root);
      await useBackend(root, [
        'type: opencode',
        'command: node',
        `args: [${JSON.stringify(script.replace(/\\/g, '/'))}, ${JSON.stringify(pidFile.replace(/\\/g, '/'))}]`,
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await read(root, chatPath);

      const outcome = await postNdjsonAbortAfterFirstDelta(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Stream then stop.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(outcome.aborted).toBe(true);
      expect(outcome.events[0]?.event.type).toBe('delta');

      // The stub writes its pid at startup; after the client disconnect the
      // server must terminate it.
      let pid = 0;
      for (let attempt = 0; attempt < 50 && pid === 0; attempt += 1) {
        try {
          pid = Number(await readFile(pidFile, 'utf8'));
        } catch {
          pid = 0;
        }
        if (pid === 0) await delay(40);
      }
      expect(pid).toBeGreaterThan(0);

      const deadline = Date.now() + 5000;
      while (isProcessAlive(pid) && Date.now() < deadline) {
        await delay(50);
      }
      expect(isProcessAlive(pid)).toBe(false);

      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );

  it(
    'aborts the openai stream and writes nothing when the client disconnects',
    async () => {
      const root = await copySampleWorkspace();
      const stub = await startStubServer({
        canned: cannedCompletion,
        streamParts: ['Slow ', 'answer ', 'that ', 'keeps ', 'going.'],
      });
      await useBackend(root, [
        'type: openai',
        `base_url: ${stub.url}`,
        'model: test-model',
      ]);
      const { baseUrl } = await startTestServer(root);
      const chatPath = 'chats/2026-09-10-lab-agenda.md';
      const before = await read(root, chatPath);

      const outcome = await postNdjsonAbortAfterFirstDelta(
        baseUrl,
        '/api/chats/chat_lab_agenda/messages',
        {
          message: 'Stream then stop.',
          backend: 'stub-model',
          expectedHash: await hash(root, chatPath),
        },
      );

      expect(outcome.aborted).toBe(true);
      expect(outcome.events[0]?.event.type).toBe('delta');

      await delay(250);
      expect(await read(root, chatPath)).toBe(before);
    },
    serverTestTimeout,
  );
});
