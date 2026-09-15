import { createServer, type Server } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseMarkdownSource } from '../../src/files/frontmatter.js';
import { parseTranscript } from '../../src/files/transcript.js';
import { hashOf } from '../../src/operations/edit.js';
import { continueChat } from '../../src/operations/exchange.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-attachments-'));
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
      requests.push({
        url: request.url ?? '',
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

function stubBackendSettings(server: StubServer): string {
  return workspaceSettings(
    [
      'backends:',
      '  default: stub-model',
      '  entries:',
      '    stub-model:',
      '      type: openai',
      `      base_url: ${server.url}`,
      '      model: test-model',
    ].join('\n'),
  );
}

function lastStubMessage(server: StubServer): {
  role: string;
  content: string;
} {
  const body = JSON.parse(server.requests[0]?.body ?? '{}') as {
    messages: { role: string; content: string }[];
  };
  return body.messages.at(-1) ?? { role: '', content: '' };
}

describe('chat send with attachments', () => {
  it('sends augmented text to the backend and stores chip metadata without paths', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const chatFile = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const result = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Summarize the scaling notes.',
      backend: 'stub-model',
      attachments: [{ id: 'resource_soap_scaling' }],
    });

    expect(result.success).toBe(true);
    expect(result.data?.reply).toContain('Triffid marker reply');

    const scalingSource = await readFile(
      path.join(root, 'projects/soap-bubbles/context/scaling.md'),
      'utf8',
    );
    const scalingBody =
      parseMarkdownSource('scaling.md', scalingSource).body ?? '';
    const sent = lastStubMessage(server);
    expect(sent.role).toBe('user');
    expect(sent.content).toContain('<fieldwork_workspace>');
    expect(sent.content).toContain(
      '<attachment kind="resource" title="Scaling notes">',
    );
    expect(sent.content).toContain(scalingBody.trim());
    expect(sent.content).toContain('</attachment>');
    expect(sent.content).toContain('Summarize the scaling notes.');
    expect(sent.content).toContain('printed by `fieldwork serve`');
    expect(server.requests).toHaveLength(1);

    const stored = parseTranscript(await readFile(chatFile, 'utf8'), chatFile);
    expect(stored.diagnostics).toEqual([]);
    const user = stored.messages.at(-2);
    const assistant = stored.messages.at(-1);
    expect(user?.role).toBe('user');
    expect(user?.text).toBe('Summarize the scaling notes.');
    expect(user?.metadata?.attachments).toEqual([
      {
        id: 'resource_soap_scaling',
        path: 'projects/soap-bubbles/context/scaling.md',
        label: 'Scaling notes',
        mime: 'text/markdown',
        kind: 'resource',
        title: 'Scaling notes',
        size: Buffer.byteLength(scalingBody, 'utf8'),
      },
    ]);
    const storedAttachment = user?.metadata?.attachments[0];
    expect(storedAttachment?.label.includes('/')).toBe(false);
    expect(storedAttachment?.label.includes('\\')).toBe(false);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toBe(
      'Triffid marker reply about posterior diagnostics.',
    );
    expect(assistant?.metadata?.backend).toBe('stub-model');
  });

  it('dedupes id and path references to the same target', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));

    const result = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Check the notes.',
      backend: 'stub-model',
      attachments: [
        { id: 'resource_soap_scaling' },
        { path: 'projects/soap-bubbles/context/scaling.md' },
      ],
    });

    expect(result.success).toBe(true);
    const sent = lastStubMessage(server);
    expect(sent.content.match(/<attachment /g)).toHaveLength(1);
    expect(sent.content).toContain('kind="resource" title="Scaling notes"');

    const chatFile = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const stored = parseTranscript(await readFile(chatFile, 'utf8'), chatFile);
    expect(stored.diagnostics).toEqual([]);
    const user = stored.messages.at(-2);
    expect(user?.metadata?.attachments).toHaveLength(1);
  });

  it('writes nothing when an attachment cannot be resolved', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const chatFile = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(chatFile);

    const result = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Hello.',
      backend: 'stub-model',
      attachments: [{ id: 'resource_missing' }],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
    expect(await fileHash(chatFile)).toBe(before);
    expect(server.requests).toHaveLength(0);
  });

  it('keeps the stale hash conflict ahead of attachment resolution', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const chatFile = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(chatFile);

    const result = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Hello.',
      backend: 'stub-model',
      expectedHash: '0'.repeat(64),
      attachments: [{ id: 'resource_missing' }],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'edit.stale_hash',
    ]);
    expect(await fileHash(chatFile)).toBe(before);
    expect(server.requests).toHaveLength(0);
  });

  it('stores no attachments when the backend fails', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    server.respond(500, '{"error": "upstream exploded"}');
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const chatFile = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(chatFile);

    const result = await continueChat(root, {
      chatId: 'chat_lab_agenda',
      message: 'Hello.',
      backend: 'stub-model',
      attachments: [{ id: 'resource_soap_scaling' }],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.http_status',
    ]);
    expect(await fileHash(chatFile)).toBe(before);
    expect(server.requests).toHaveLength(1);
  });
});
