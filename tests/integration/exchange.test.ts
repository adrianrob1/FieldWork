import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli.js';
import {
  parseTranscript,
  serializeChatMessage,
} from '../../src/files/transcript.js';
import { rebuildIndex } from '../../src/index/build.js';
import { searchIndex } from '../../src/index/search.js';
import { hashOf } from '../../src/operations/edit.js';
import { continueChat } from '../../src/operations/exchange.js';
import { appendChatMessage } from '../../src/operations/message.js';
import { todayDate } from '../../src/operations/start.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const stubServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => removeTempDirectory(directory)),
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

async function removeTempDirectory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-exchange-'));
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

async function fileHash(file: string): Promise<string> {
  return hashOf(await readFile(file));
}

interface CapturedRequest {
  url: string;
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

function completionWith(content: string): string {
  return JSON.stringify({
    id: 'chatcmpl-stub-shape',
    object: 'chat.completion',
    model: 'stub-model-shape',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
  });
}

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

const slowCompletion = JSON.stringify({
  id: 'chatcmpl-stub-slow',
  object: 'chat.completion',
  model: 'stub-model-slow',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Zephyr stale reply that must never land in the transcript.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
});

const fastCompletion = JSON.stringify({
  id: 'chatcmpl-stub-fast',
  object: 'chat.completion',
  model: 'stub-model-fast',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Nimbus fresh reply that lands before the slow one.',
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
});

interface SequencedStub {
  url: string;
  requests: CapturedRequest[];
  firstRequest: Promise<void>;
}

async function startSequencedStub(delayMs: number): Promise<SequencedStub> {
  const requests: CapturedRequest[] = [];
  let resolveFirst: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
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
        headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const body = requests.length === 1 ? slowCompletion : fastCompletion;
      const finish = (): void => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(body);
      };
      if (requests.length === 1) {
        resolveFirst?.();
        setTimeout(finish, delayMs);
        return;
      }
      finish();
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
    firstRequest,
  };
}

function workspaceSettings(backendsBlock: string): string {
  return [
    'version: 1',
    'title: Optimizer research sample',
    'paths:',
    '  projects: projects',
    '  chats: chats',
    '  topics: topics',
    '  inbox: inbox',
    '  external: external',
    backendsBlock,
    '',
  ].join('\n');
}

interface CapturedIo {
  out: string[];
  err: string[];
  restore(): void;
}

function captureProcessIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  return {
    out,
    err,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

async function runProgram(
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = captureProcessIo();
  const run = createProgram();
  try {
    await run.program.parseAsync(argv, { from: 'user' });
  } finally {
    io.restore();
  }
  return { code: run.exitCode(), out: io.out.join(''), err: io.err.join('') };
}

describe('chat send through an OpenAI-compatible backend', () => {
  it('appends the user and assistant messages with provenance', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    await rebuildIndex(root);
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await readFile(file, 'utf8');
    expect(before).not.toContain('updated:');

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'What is the agenda for Thursday?',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('Triffid marker reply about posterior diagnostics.');

    const after = await readFile(file, 'utf8');
    expect(after).toContain('updated: ');
    expect(after).toContain('## user\n\nWhat is the agenda for Thursday?');
    expect(after).toContain('## assistant');
    expect(after).toContain('provider: openai-compatible');
    expect(after).toContain('model: stub-model-v2');
    expect(after).toContain('backend: stub-model');
    expect(after).toContain(
      'usage:\n  prompt_tokens: 12\n  completion_tokens: 7\n  total_tokens: 19',
    );
    expect(after).toContain(
      'Triffid marker reply about posterior diagnostics.',
    );

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.url).toBe('/v1/chat/completions');
    expect(request?.headers.authorization).toBeUndefined();
    const body = JSON.parse(request?.body ?? '{}') as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('test-model');
    expect(body.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(body.messages[0]?.content).toContain(
      "Please draft the agenda for Thursday's lab meeting.",
    );
    expect(body.messages[2]?.role).toBe('user');
    expect(body.messages[2]?.content).toContain(
      'What is the agenda for Thursday?',
    );
    expect(body.messages[2]?.content).toContain('<fieldwork_workspace>');
    expect(body.messages[2]?.content).toContain('fieldwork serve');
    expect(after).not.toContain('<fieldwork_workspace>');

    const found = await searchIndex(root, 'triffid');
    expect(found.diagnostics).toEqual([]);
    expect(
      found.hits.some(
        (hit) =>
          hit.path === 'chats/2026-09-10-lab-agenda.md' &&
          hit.objectId === 'chat_lab_agenda',
      ),
    ).toBe(true);
  });

  it('emits the JSON envelope with the operation result', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Hello again.',
      '--backend',
      'stub-model',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      command: string;
      success: boolean;
      data: {
        chatId: string;
        backend: string;
        appendedCount: number;
        reply: string;
      };
      diagnostics: { code: string }[];
    };
    expect(envelope.command).toBe('chat send');
    expect(envelope.success).toBe(true);
    expect(envelope.diagnostics).toEqual([]);
    expect(envelope.data.chatId).toBe('chat_lab_agenda');
    expect(envelope.data.backend).toBe('stub-model');
    expect(envelope.data.appendedCount).toBe(2);
    expect(envelope.data.reply).toContain('Triffid marker reply');
  });

  it('exits 1 with backend.unconfigured when no backends exist', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(file);

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Hello.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    const envelope = JSON.parse(out) as {
      success: boolean;
      diagnostics: { code: string; severity: string }[];
    };
    expect(envelope.success).toBe(false);
    expect(envelope.diagnostics[0]?.code).toBe('backend.unconfigured');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
    expect(await fileHash(file)).toBe(before);
  });

  it('exits 1 for an unknown chat without calling the backend', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_unknown',
      '--message',
      'Hello.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    const envelope = JSON.parse(out) as {
      diagnostics: { code: string }[];
    };
    expect(envelope.diagnostics[0]?.code).toBe('chat.missing');
    expect(server.requests).toHaveLength(0);
  });

  it('leaves the chat file unchanged when the backend fails', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    server.respond(500, '{"error": "upstream exploded"}');
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(file);

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Hello.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    const envelope = JSON.parse(out) as {
      success: boolean;
      diagnostics: { code: string; message: string }[];
    };
    expect(envelope.success).toBe(false);
    expect(envelope.diagnostics[0]?.code).toBe('backend.http_status');
    expect(envelope.diagnostics[0]?.message).toContain('500');
    expect(await fileHash(file)).toBe(before);
  });

  it('exits 1 and appends nothing when the backend returns an empty response', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    server.respond(200, '{}');
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(file);

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Hello.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    const envelope = JSON.parse(out) as {
      success: boolean;
      diagnostics: { code: string; message: string }[];
    };
    expect(envelope.success).toBe(false);
    expect(envelope.diagnostics[0]?.code).toBe('backend.empty_response');
    expect(envelope.diagnostics[0]?.message).toContain('stub-model');
    expect(await fileHash(file)).toBe(before);
  });

  it('commits a reply with level-2 headings and round-trips the text exactly', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    const reply =
      '## Summary\n\nAll checks passed.\n\n## Details\n\nBoth probes finished.';
    server.respond(200, completionWith(reply));
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const { code } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Report the outcome.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    const parsed = parseTranscript(await readFile(file, 'utf8'), file);
    expect(parsed.diagnostics).toEqual([]);
    const assistant = parsed.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toBe(reply);
    const reserialized = serializeChatMessage(
      assistant ?? { role: 'assistant', text: '' },
    );
    expect(parseTranscript(reserialized, file).messages[0]?.text).toBe(reply);
  });

  it('commits a reply that begins with a yaml fence and preserves the text', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    const reply = '```yaml\na: 1\n```\n\n## Summary\n\nDone.';
    server.respond(200, completionWith(reply));
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const { code } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Send the fenced reply.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    const parsed = parseTranscript(await readFile(file, 'utf8'), file);
    expect(parsed.diagnostics).toEqual([]);
    const assistant = parsed.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toBe(reply);
    expect(assistant?.metadata).toMatchObject({
      provider: 'openai-compatible',
      backend: 'stub-model',
    });
    const reserialized = serializeChatMessage(
      assistant ?? { role: 'assistant', text: '' },
    );
    expect(parseTranscript(reserialized, file).messages[0]?.text).toBe(reply);
  });
});

describe('overlapping chat sends', () => {
  it('ties the transcript and conflict hash to the same file read', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const concurrent = `${await readFile(file, 'utf8')}\n## user\n\nIntervening note from another writer.\n`;

    const result = await continueChat(
      root,
      {
        chatId: 'chat_lab_agenda',
        message: 'Question prepared from the initial transcript.',
      },
      {
        afterWorkspaceParse: async (parsedFile) => {
          expect(parsedFile).toBe(file);
          await writeFile(file, concurrent);
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    expect(await readFile(file, 'utf8')).toBe(concurrent);
    expect(server.requests).toHaveLength(1);
    const request = JSON.parse(server.requests[0]?.body ?? '{}') as {
      messages: { content: string }[];
    };
    expect(
      request.messages.some(({ content }) =>
        content.includes('Intervening note from another writer.'),
      ),
    ).toBe(false);
  });

  it('rejects the stale exchange when a second send appends first', async () => {
    const root = await copySampleWorkspace();
    const server = await startSequencedStub(750);
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const slow = continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Slow stale question about phase retrieval?',
    });
    await server.firstRequest;
    const fast = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Fast fresh question about calorimetry?',
    });

    expect(fast.success).toBe(true);
    const afterFast = await readFile(file);

    const slowResult = await slow;

    expect(slowResult.success).toBe(false);
    expect(slowResult.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    expect(slowResult.diagnostics[0]?.message).toContain(
      'changed during the exchange',
    );
    const afterSlow = await readFile(file);
    expect(afterSlow.equals(afterFast)).toBe(true);
    const text = afterSlow.toString('utf8');
    expect(text).toContain('Fast fresh question about calorimetry?');
    expect(text).toContain(
      'Nimbus fresh reply that lands before the slow one.',
    );
    expect(text).not.toContain('Slow stale question');
    expect(text).not.toContain('Zephyr stale reply');
    expect(server.requests).toHaveLength(2);
    const firstBody = JSON.parse(server.requests[0]?.body ?? '{}') as {
      messages: { content: string }[];
    };
    const secondBody = JSON.parse(server.requests[1]?.body ?? '{}') as {
      messages: { content: string }[];
    };
    expect(firstBody.messages.at(-1)?.content).toContain(
      'Slow stale question about phase retrieval?',
    );
    expect(secondBody.messages.at(-1)?.content).toContain(
      'Fast fresh question about calorimetry?',
    );
    expect(secondBody.messages.at(-1)?.content).toContain(
      '<fieldwork_workspace>',
    );
    expect(text).not.toContain('<fieldwork_workspace>');
  });

  it('rejects the stale exchange after an intervening direct append', async () => {
    const root = await copySampleWorkspace();
    const server = await startSequencedStub(750);
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: stub-model',
          '  entries:',
          '    stub-model:',
          '      type: openai',
          `      base_url: ${server.url}`,
          '      model: test-model',
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const slow = continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Slow stale question about magnetometry?',
    });
    await server.firstRequest;
    const appended = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'user',
        text: 'Intervening user note about magnetometry.',
      },
    });

    expect(appended.success).toBe(true);
    const afterAppend = await readFile(file);

    const slowResult = await slow;

    expect(slowResult.success).toBe(false);
    expect(slowResult.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    const afterSlow = await readFile(file);
    expect(afterSlow.equals(afterAppend)).toBe(true);
    const text = afterSlow.toString('utf8');
    expect(text).toContain('Intervening user note about magnetometry.');
    expect(text).not.toContain('Slow stale question');
    expect(text).not.toContain('Zephyr stale reply');
    expect(server.requests).toHaveLength(1);
  });
});

const fakeAgentScript = [
  "import { writeFileSync } from 'node:fs';",
  'const argv = process.argv.slice(2);',
  "writeFileSync(new URL('./argv.json', import.meta.url), JSON.stringify(argv));",
  'const events = [',
  "  { type: 'step_start', sessionID: 'ses_fake_1', part: { type: 'step-start' } },",
  "  { type: 'text', sessionID: 'ses_fake_1', part: { type: 'text', text: 'Quark marker reply from the fake agent.' } },",
  "  { type: 'step_finish', sessionID: 'ses_fake_1', part: { type: 'step-finish', tokens: { total: 42, input: 20, output: 22 }, cost: 0 } },",
  '];',
  "for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');",
  '',
].join('\n');

describe('chat send through an opencode backend', () => {
  it('runs the configured command and records the session', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-agent-'));
    temporaryDirectories.push(agentDir);
    await writeFile(path.join(agentDir, 'fake-agent.mjs'), fakeAgentScript);
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: local-agent',
          '  entries:',
          '    local-agent:',
          '      type: opencode',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir)}']`,
        ].join('\n'),
      ),
    );
    await rebuildIndex(root);
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const { code } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Run the experiment plan.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    const after = await readFile(file, 'utf8');
    expect(after).toContain('## user\n\nRun the experiment plan.');
    expect(after).toContain('backend: local-agent');
    expect(after).toContain('session: ses_fake_1');
    expect(after).toContain('Quark marker reply from the fake agent.');

    const argv = JSON.parse(
      await readFile(path.join(agentDir, 'argv.json'), 'utf8'),
    ) as string[];
    expect(argv.slice(0, 3)).toEqual(['run', '--format', 'json']);
    expect(argv[3]).toContain(
      "user: Please draft the agenda for Thursday's lab meeting.",
    );
    expect(argv[3]).toContain('Run the experiment plan.');
    expect(argv[3]).toContain('<fieldwork_workspace>');

    const found = await searchIndex(root, 'quark');
    expect(found.hits.some((hit) => hit.objectId === 'chat_lab_agenda')).toBe(
      true,
    );
  });

  it('continues the recorded session on the next send', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-agent-'));
    temporaryDirectories.push(agentDir);
    await writeFile(path.join(agentDir, 'fake-agent.mjs'), fakeAgentScript);
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  entries:',
          '    local-agent:',
          '      type: opencode',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir)}']`,
        ].join('\n'),
      ),
    );

    const first = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'First send.',
      '--backend',
      'local-agent',
      '--workspace',
      root,
    ]);
    expect(first.code).toBe(0);

    const second = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Second send.',
      '--backend',
      'local-agent',
      '--workspace',
      root,
    ]);
    expect(second.code).toBe(0);

    const argv = JSON.parse(
      await readFile(path.join(agentDir, 'argv.json'), 'utf8'),
    ) as string[];
    expect(argv.slice(0, 5)).toEqual([
      'run',
      '--format',
      'json',
      '-s',
      'ses_fake_1',
    ]);
    expect(argv[5]).toContain('Second send.');
    expect(argv[5]).toContain('<fieldwork_workspace>');
  });
});

function agentScriptPath(agentDir: string, script = 'fake-agent.mjs'): string {
  return path.join(agentDir, script).split(path.sep).join('/');
}

function acpStubScript(
  sessionId: string,
  requestsFileName: string,
  reply: string,
  toolCallBeforeReply = false,
): string {
  const planUpdate =
    "      { sessionUpdate: 'plan', entries: [{ content: 'Draft the agenda', priority: 'high', status: 'completed' }] },";
  const chunkUpdate = `      { sessionUpdate: 'agent_message_chunk', messageId: 'msg_agent_1', content: { type: 'text', text: ${JSON.stringify(reply)} } },`;
  const toolCallUpdate =
    "      { sessionUpdate: 'tool_call', toolCallId: 'call_stub_read', title: 'Read the agenda', kind: 'read', status: 'pending' },";
  const toolResultUpdate =
    "      { sessionUpdate: 'tool_call_update', toolCallId: 'call_stub_read', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'agenda contents' } }] },";
  const usageUpdate =
    "      { sessionUpdate: 'usage_update', used: 12, size: 2000 },";
  const updateLines = toolCallBeforeReply
    ? [toolCallUpdate, toolResultUpdate, planUpdate, chunkUpdate, usageUpdate]
    : [planUpdate, chunkUpdate, toolCallUpdate, toolResultUpdate, usageUpdate];
  return [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    `const requestsFile = fileURLToPath(new URL('./${requestsFileName}', import.meta.url));`,
    'let requests = [];',
    'try {',
    "  requests = JSON.parse(readFileSync(requestsFile, 'utf8'));",
    '} catch {',
    '  requests = [];',
    '}',
    `const sessionId = '${sessionId}';`,
    "let buffer = '';",
    'function send(message) {',
    "  process.stdout.write(JSON.stringify(message) + '\\n');",
    '}',
    'function handle(line) {',
    "  if (line.trim() === '') return;",
    '  let message;',
    '  try {',
    '    message = JSON.parse(line);',
    '  } catch {',
    '    return;',
    '  }',
    "  if (typeof message.method !== 'string' || message.id === undefined) return;",
    '  requests.push({ method: message.method, params: message.params });',
    '  writeFileSync(requestsFile, JSON.stringify(requests));',
    "  if (message.method === 'initialize') {",
    "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });",
    "  } else if (message.method === 'session/new') {",
    "    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });",
    "  } else if (message.method === 'session/load') {",
    '    if (message.params.sessionId === sessionId) {',
    "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', messageId: 'msg_replay', content: { type: 'text', text: 'Replayed reply that must not leak.' } } } });",
    "      send({ jsonrpc: '2.0', id: message.id, result: null });",
    '    } else {',
    "      send({ jsonrpc: '2.0', id: message.id, error: { code: -32001, message: 'session not found' } });",
    '    }',
    "  } else if (message.method === 'session/prompt') {",
    '    const updates = [',
    ...updateLines,
    '    ];',
    '    for (const update of updates) {',
    "      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });",
    '    }',
    "    send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });",
    '  } else {',
    "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });",
    '  }',
    '}',
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    '  buffer += chunk;',
    "  let newline = buffer.indexOf('\\n');",
    '  while (newline !== -1) {',
    '    const line = buffer.slice(0, newline);',
    '    buffer = buffer.slice(newline + 1);',
    '    handle(line);',
    "    newline = buffer.indexOf('\\n');",
    '  }',
    '});',
    '',
  ].join('\n');
}

const acpFailingStubScript = [
  "let buffer = '';",
  'function send(message) {',
  "  process.stdout.write(JSON.stringify(message) + '\\n');",
  '}',
  'function handle(line) {',
  "  if (line.trim() === '') return;",
  '  let message;',
  '  try {',
  '    message = JSON.parse(line);',
  '  } catch {',
  '    return;',
  '  }',
  "  if (typeof message.method !== 'string' || message.id === undefined) return;",
  "  if (message.method === 'initialize') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });",
  "  } else if (message.method === 'session/new') {",
  "    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'ses_acp_fail' } });",
  "  } else if (message.method === 'session/prompt') {",
  "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'harness exploded' } });",
  '  } else {',
  "    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'method not found' } });",
  '  }',
  '}',
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => {",
  '  buffer += chunk;',
  "  let newline = buffer.indexOf('\\n');",
  '  while (newline !== -1) {',
  '    const line = buffer.slice(0, newline);',
  '    buffer = buffer.slice(newline + 1);',
  '    handle(line);',
  "    newline = buffer.indexOf('\\n');",
  '  }',
  '});',
  '',
].join('\n');

describe('chat send through an agent backend', () => {
  it('runs the ACP harness and records the session and tool calls', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    await writeFile(
      path.join(agentDir, 'acp-stub.mjs'),
      acpStubScript(
        'ses_acp_stub',
        'acp-requests.json',
        'Boson marker reply from the ACP stub.',
      ),
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: acp-agent',
          '  entries:',
          '    acp-agent:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'acp-stub.mjs')}']`,
        ].join('\n'),
      ),
    );
    await rebuildIndex(root);
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Draft the agenda through the ACP harness.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('Boson marker reply from the ACP stub.');
    const after = await readFile(file, 'utf8');
    expect(after).toContain(
      '## user\n\nDraft the agenda through the ACP harness.',
    );
    expect(after).toContain('## assistant');
    expect(after).toContain('provider: acp');
    expect(after).toContain('backend: acp-agent');
    expect(after).toContain('session: ses_acp_stub');
    expect(after).toContain('- id: call_stub_read');
    expect(after).toContain('name: Read the agenda');
    expect(after).toContain('result: agenda contents');
    expect(after).toContain('Boson marker reply from the ACP stub.');
    expect(after).not.toContain('Replayed reply that must not leak.');

    const requests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests.json'), 'utf8'),
    ) as { method: string; params: unknown }[];
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);
    const initialize = requests[0]?.params as {
      protocolVersion: number;
      clientCapabilities: {
        fs: { readTextFile: boolean; writeTextFile: boolean };
      };
    };
    expect(initialize.protocolVersion).toBe(1);
    expect(initialize.clientCapabilities.fs).toEqual({
      readTextFile: false,
      writeTextFile: false,
    });

    const found = await searchIndex(root, 'boson');
    expect(found.hits.some((hit) => hit.objectId === 'chat_lab_agenda')).toBe(
      true,
    );
  });

  it('commits an agent turn with a tool call before a yaml-fence and summary reply', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    const reply = '```yaml\na: 1\n```\n\n## Summary\n\nDone.';
    await writeFile(
      path.join(agentDir, 'acp-stub.mjs'),
      acpStubScript('ses_acp_stub', 'acp-requests.json', reply, true),
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: acp-agent',
          '  entries:',
          '    acp-agent:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'acp-stub.mjs')}']`,
        ].join('\n'),
      ),
    );
    await rebuildIndex(root);
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const { code } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Run the harness with a fenced reply.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    const parsed = parseTranscript(await readFile(file, 'utf8'), file);
    expect(parsed.diagnostics).toEqual([]);
    const assistant = parsed.messages.at(-1);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toBe(reply);
    expect(assistant?.metadata?.tool_calls).toEqual([
      {
        id: 'call_stub_read',
        name: 'Read the agenda',
        arguments: {},
        result: 'agenda contents',
      },
    ]);
    expect(assistant?.metadata).toMatchObject({
      provider: 'acp',
      backend: 'acp-agent',
      session: 'ses_acp_stub',
    });
    const reserialized = serializeChatMessage(
      assistant ?? { role: 'assistant', text: '' },
    );
    expect(parseTranscript(reserialized, file).messages[0]?.text).toBe(reply);
  });

  it('continues the recorded ACP session on the next send', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    await writeFile(
      path.join(agentDir, 'acp-stub.mjs'),
      acpStubScript(
        'ses_acp_stub',
        'acp-requests.json',
        'Boson marker reply from the ACP stub.',
      ),
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  entries:',
          '    acp-agent:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'acp-stub.mjs')}']`,
        ].join('\n'),
      ),
    );

    const first = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'First ACP send.',
      '--backend',
      'acp-agent',
      '--workspace',
      root,
    ]);
    expect(first.code).toBe(0);

    const firstRequests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests.json'), 'utf8'),
    ) as { method: string; params: unknown }[];
    expect(firstRequests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);

    const second = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Second ACP send.',
      '--backend',
      'acp-agent',
      '--workspace',
      root,
    ]);
    expect(second.code).toBe(0);

    const requests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests.json'), 'utf8'),
    ) as {
      method: string;
      params: { sessionId?: string; prompt?: { type: string; text: string }[] };
    }[];
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    expect(requests[4]?.params.sessionId).toBe('ses_acp_stub');
    const resumedPrompt = requests[5]?.params.prompt ?? [];
    expect(resumedPrompt).toHaveLength(1);
    expect(resumedPrompt[0]?.type).toBe('text');
    expect(resumedPrompt[0]?.text).toContain('Second ACP send.');
    expect(resumedPrompt[0]?.text).toContain('<fieldwork_workspace>');
  });

  it('leaves the chat file unchanged when the harness fails on session/prompt', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    await writeFile(
      path.join(agentDir, 'acp-stub-failing.mjs'),
      acpFailingStubScript,
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: acp-agent',
          '  entries:',
          '    acp-agent:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'acp-stub-failing.mjs')}']`,
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(file);

    const { code, out } = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Hello.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    const envelope = JSON.parse(out) as {
      success: boolean;
      diagnostics: { code: string; message: string }[];
    };
    expect(envelope.success).toBe(false);
    expect(envelope.diagnostics[0]?.code).toBe('backend.request_failed');
    expect(envelope.diagnostics[0]?.message).toContain('harness exploded');
    expect(await fileHash(file)).toBe(before);
  });
});

describe('chat send across two agent backends', () => {
  it('resumes only the session recorded by the same configured backend', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    await writeFile(
      path.join(agentDir, 'opencode-acp-stub.mjs'),
      acpStubScript(
        'ses_opencode_acp',
        'acp-requests-opencode.json',
        'Gloun marker reply from the opencode-acp stub.',
      ),
    );
    await writeFile(
      path.join(agentDir, 'codex-acp-stub.mjs'),
      acpStubScript(
        'ses_codex_acp',
        'acp-requests-codex.json',
        'Halcyon marker reply from the codex-acp stub.',
      ),
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: opencode-acp',
          '  entries:',
          '    opencode-acp:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'opencode-acp-stub.mjs')}']`,
          '    codex-acp:',
          '      type: agent',
          '      command: node',
          `      args: ['${agentScriptPath(agentDir, 'codex-acp-stub.mjs')}']`,
        ].join('\n'),
      ),
    );
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const turns: [string, string][] = [
      ['opencode-acp', 'First OpenCode send.'],
      ['codex-acp', 'First Codex send.'],
      ['opencode-acp', 'Second OpenCode send.'],
    ];
    for (const [backend, message] of turns) {
      const turn = await runProgram([
        'chat',
        'send',
        'chat_lab_agenda',
        '--message',
        message,
        '--backend',
        backend,
        '--workspace',
        root,
        '--json',
      ]);
      expect(turn.code).toBe(0);
      expect(turn.err).toBe('');
    }

    const opencodeRequests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests-opencode.json'), 'utf8'),
    ) as { method: string; params: { sessionId?: string } }[];
    const codexRequests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests-codex.json'), 'utf8'),
    ) as { method: string; params: { sessionId?: string } }[];
    expect(opencodeRequests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    expect(opencodeRequests[4]?.params.sessionId).toBe('ses_opencode_acp');
    expect(codexRequests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);

    const parsed = parseTranscript(await readFile(file, 'utf8'), file);
    expect(parsed.diagnostics).toEqual([]);
    expect(
      parsed.messages
        .filter((message) => message.role === 'assistant')
        .map((message) => [
          message.metadata?.backend,
          message.metadata?.session,
          message.metadata?.provider,
        ]),
    ).toEqual([
      [undefined, undefined, 'openai'],
      ['opencode-acp', 'ses_opencode_acp', 'acp'],
      ['codex-acp', 'ses_codex_acp', 'acp'],
      ['opencode-acp', 'ses_opencode_acp', 'acp'],
    ]);
  });
});

describe('chat send with a selected agent model', () => {
  it('sends session/set_model and continues when the harness lacks the extension', async () => {
    const root = await copySampleWorkspace();
    const agentDir = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-acp-'));
    temporaryDirectories.push(agentDir);
    await writeFile(
      path.join(agentDir, 'model-stub.mjs'),
      acpStubScript(
        'ses_model_1',
        'acp-requests-model.json',
        'Marker reply from the model stub.',
      ),
    );
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: model-agent',
          '  entries:',
          '    model-agent:',
          '      type: agent',
          '      command: node',
          '      model: gpt-6-astra[high]',
          `      args: ['${agentScriptPath(agentDir, 'model-stub.mjs')}']`,
        ].join('\n'),
      ),
    );

    const turn = await runProgram([
      'chat',
      'send',
      'chat_lab_agenda',
      '--message',
      'Model send.',
      '--workspace',
      root,
      '--json',
    ]);

    expect(turn.code).toBe(0);
    expect(turn.err).toBe('');
    const requests = JSON.parse(
      await readFile(path.join(agentDir, 'acp-requests-model.json'), 'utf8'),
    ) as { method: string; params: Record<string, unknown> }[];
    expect(requests.map((request) => request.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_model',
      'session/prompt',
    ]);
    expect(requests[2]?.params).toEqual({
      sessionId: 'ses_model_1',
      modelId: 'gpt-6-astra[high]',
    });
    const parsed = parseTranscript(
      await readFile(path.join(root, 'chats/2026-09-10-lab-agenda.md'), 'utf8'),
      'chats/2026-09-10-lab-agenda.md',
    );
    const assistant = parsed.messages
      .filter((message) => message.role === 'assistant')
      .at(-1);
    // The stub answers set_model with method not found, so the turn must have
    // continued with the harness's own model choice.
    expect(assistant?.text).toBe('Marker reply from the model stub.');
  });
});

describe('chat start', () => {
  it('creates the dated chat file with frontmatter and a seeded message', async () => {
    const root = await copySampleWorkspace();
    const today = todayDate();

    const { code, out } = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_gradient_notes',
      '--title',
      'Gradient notes',
      '--topic',
      'optimization',
      '--project',
      'project_evon',
      '--message',
      'First question about gradients.',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain(`Started chat 'chat_gradient_notes'`);
    const file = path.join(root, 'chats', `${today}-gradient-notes.md`);
    const contents = await readFile(file, 'utf8');
    expect(contents).toContain('id: chat_gradient_notes');
    expect(contents).toContain('title: Gradient notes');
    expect(contents).toContain(`created: ${today}`);
    expect(contents).toContain('topics:');
    expect(contents).toContain('- optimization');
    expect(contents).toContain('- project_evon');
    expect(contents).toContain('## user\n\nFirst question about gradients.');
    expect(() => {
      JSON.parse(out);
    }).toThrow();
  });

  it('emits the JSON envelope for a started chat', async () => {
    const root = await copySampleWorkspace();
    const today = todayDate();

    const { code, out } = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_plain',
      '--title',
      'Plain chat',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      command: string;
      success: boolean;
      data: { chatId: string; title: string; file: string };
      diagnostics: { code: string }[];
    };
    expect(envelope.command).toBe('chat start');
    expect(envelope.success).toBe(true);
    expect(envelope.data.chatId).toBe('chat_plain');
    expect(envelope.data.file).toBe(
      path.join(root, 'chats', `${today}-plain-chat.md`),
    );
  });

  it('refuses duplicate IDs and existing file names', async () => {
    const root = await copySampleWorkspace();
    const today = todayDate();

    const first = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_dup',
      '--title',
      'Duplicate test',
      '--workspace',
      root,
    ]);
    expect(first.code).toBe(0);

    const duplicateId = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_dup',
      '--title',
      'Different title',
      '--workspace',
      root,
      '--json',
    ]);
    expect(duplicateId.code).toBe(1);
    expect(
      (JSON.parse(duplicateId.out) as { diagnostics: { code: string }[] })
        .diagnostics[0]?.code,
    ).toBe('id.duplicate');

    const duplicateFile = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_dup_file',
      '--title',
      'Duplicate test',
      '--workspace',
      root,
      '--json',
    ]);
    expect(duplicateFile.code).toBe(1);
    expect(
      (JSON.parse(duplicateFile.out) as { diagnostics: { code: string }[] })
        .diagnostics[0]?.code,
    ).toBe('operation.target_exists');
    await expect(
      readFile(path.join(root, 'chats', `${today}-different-title.md`)),
    ).rejects.toThrow();
  });

  it('refuses a broken project reference before writing', async () => {
    const root = await copySampleWorkspace();
    const today = todayDate();

    const { code, out } = await runProgram([
      'chat',
      'start',
      '--id',
      'chat_broken_ref',
      '--title',
      'Broken reference',
      '--project',
      'project_missing',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(1);
    expect(
      (JSON.parse(out) as { diagnostics: { code: string }[] }).diagnostics[0]
        ?.code,
    ).toBe('reference.missing');
    await expect(
      readFile(path.join(root, 'chats', `${today}-broken-reference.md`)),
    ).rejects.toThrow();
  });
});

describe('backend list', () => {
  it('lists configured backends with statuses', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: research-model',
          '  entries:',
          '    research-model:',
          '      type: openai',
          '      model: gpt-5.6',
          '      api_key_env: FIELDWORK_TEST_MISSING_KEY',
          '    local-agent:',
          '      type: opencode',
          '      model: anthropic/claude-sonnet-4-5',
          '      command: node',
        ].join('\n'),
      ),
    );

    const { code, out } = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('research-model');
    expect(out).toContain('openai');
    expect(out).toContain('model: gpt-5.6');
    expect(out).toContain('default');
    expect(out).toContain('api key env FIELDWORK_TEST_MISSING_KEY is not set');
    expect(out).toContain('local-agent');
    expect(out).toContain("command 'node' resolves on PATH");

    const json = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
      '--json',
    ]);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.out) as {
      data: {
        backends: {
          name: string;
          type: string;
          model: string | null;
          default: boolean;
          status: string;
        }[];
      };
    };
    expect(envelope.data.backends).toHaveLength(2);
    expect(envelope.data.backends[0]?.name).toBe('local-agent');
    expect(envelope.data.backends[1]?.default).toBe(true);
    expect(envelope.data.backends[1]?.status).toContain('is not set');
  });

  it('reports an unknown default backend with exit 1', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  default: ghost',
          '  entries:',
          '    research-model:',
          '      type: openai',
          '      model: gpt-5.6',
        ].join('\n'),
      ),
    );

    const { code, out, err } = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
    ]);

    expect(code).toBe(1);
    expect(out).toContain('research-model');
    expect(err).toContain('[backend.unconfigured]');
  });

  it('reports an empty configuration with exit 0', async () => {
    const root = await copySampleWorkspace();

    const { code, out } = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('No backends are configured');
  });

  it('lists agent backends with a PATH readiness status', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'workspace.yml',
      workspaceSettings(
        [
          'backends:',
          '  entries:',
          '    acp-agent:',
          '      type: agent',
          '      command: node',
          "      args: ['acp']",
          '      model: anthropic/claude-sonnet-4-5',
          '    missing-acp:',
          '      type: agent',
          '      command: fieldwork-missing-acp-harness',
        ].join('\n'),
      ),
    );

    const { code, out } = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('acp-agent');
    expect(out).toContain('agent');
    expect(out).toContain('model: anthropic/claude-sonnet-4-5');
    expect(out).toContain("command 'node' resolves on PATH");
    expect(out).toContain('missing-acp');
    expect(out).toContain(
      "command 'fieldwork-missing-acp-harness' not found on PATH",
    );

    const json = await runProgram([
      'backend',
      'list',
      '--workspace',
      root,
      '--json',
    ]);
    expect(json.code).toBe(0);
    const envelope = JSON.parse(json.out) as {
      data: {
        backends: {
          name: string;
          type: string;
          model: string | null;
          default: boolean;
          status: string;
        }[];
      };
    };
    expect(envelope.data.backends).toHaveLength(2);
    expect(envelope.data.backends[0]?.name).toBe('acp-agent');
    expect(envelope.data.backends[0]?.type).toBe('agent');
    expect(envelope.data.backends[0]?.model).toBe(
      'anthropic/claude-sonnet-4-5',
    );
    expect(envelope.data.backends[0]?.status).toContain('resolves on PATH');
    expect(envelope.data.backends[1]?.model).toBeNull();
    expect(envelope.data.backends[1]?.status).toContain('not found on PATH');
  });
});
