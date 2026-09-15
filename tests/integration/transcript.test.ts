import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../src/cli.js';
import {
  parseTranscript,
  serializeChatMessage,
  serializeTranscript,
} from '../../src/files/transcript.js';
import { rebuildIndex } from '../../src/index/build.js';
import { searchIndex } from '../../src/index/search.js';
import { hashOf } from '../../src/operations/edit.js';
import { appendChatMessage } from '../../src/operations/message.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-transcript-'));
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

function bodySlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(closing + 5);
}

const transcriptChat = [
  '---',
  'id: chat_transcript_demo',
  'title: Transcript demo',
  'created: 2026-09-09',
  'x-review-state: flagged',
  '---',
  '',
  'Intro line.',
  '',
  '## user',
  '',
  'Existing question.',
  '',
].join('\n');

const appendedMessage = {
  role: 'assistant' as const,
  text: 'Fresh answer.',
  metadata: { provider: 'openai', at: '2026-09-10T10:00:00Z' },
};

describe('appendChatMessage', () => {
  it('appends a message, bumps updated, and preserves frontmatter and body', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/transcript-demo.md', transcriptChat);
    const file = path.join(root, 'chats/transcript-demo.md');
    const before = await readFile(file, 'utf8');

    const result = await appendChatMessage(root, {
      chatId: 'chat_transcript_demo',
      message: appendedMessage,
      at: '2026-09-10T10:00:00Z',
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.files).toEqual([file]);
    expect(result.data).toEqual({
      chatId: 'chat_transcript_demo',
      file,
      role: 'assistant',
      messageCount: 2,
    });

    const after = await readFile(file, 'utf8');
    expect(after).toContain('x-review-state: flagged');
    expect(after).toContain('updated: 2026-09-10T10:00:00Z');
    expect(bodySlice(after)).toBe(
      `${bodySlice(before)}\n${serializeChatMessage(appendedMessage)}`,
    );

    const parsed = parseTranscript(bodySlice(after), file);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.preamble).toBe('\nIntro line.\n\n');
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]).toMatchObject({
      role: 'user',
      text: 'Existing question.',
    });
    expect(parsed.messages[1]).toMatchObject({
      role: 'assistant',
      text: 'Fresh answer.',
      metadata: { provider: 'openai', at: '2026-09-10T10:00:00Z' },
    });
  });

  it('refreshes index rows so search finds the appended text', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: { role: 'user', text: 'Triffid marker for the indexer.' },
      at: '2026-09-10T11:00:00Z',
    });
    expect(result.success).toBe(true);

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

  it('refuses a concurrent edit recorded after the initial read', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const tampered = `${await readFile(file, 'utf8')}concurrent line\n`;

    const result = await appendChatMessage(
      root,
      {
        chatId: 'chat_lab_agenda',
        message: { role: 'user', text: 'Too late.' },
        at: '2026-09-10T12:00:00Z',
      },
      {
        beforeConflictCheck: async (target) => {
          await writeFile(target, tampered);
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.changed).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    expect(await readFile(file, 'utf8')).toBe(tampered);
  });

  it('rejects invalid message metadata before writing', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const before = await fileHash(file);

    const result = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'assistant',
        text: 'Broken.',
        metadata: { at: 'yesterday' },
      },
      at: '2026-09-10T12:00:00Z',
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'transcript.metadata',
    ]);
    expect(await fileHash(file)).toBe(before);
  });

  it('appends message text containing a level-2 heading and rejects unknown chats', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const heading = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: { role: 'user', text: '## sneaky heading\n\nText.' },
      at: '2026-09-10T12:00:00Z',
    });
    expect(heading.success).toBe(true);

    const parsed = parseTranscript(
      bodySlice(await readFile(file, 'utf8')),
      file,
    );
    expect(parsed.diagnostics).toEqual([]);
    const appended = parsed.messages.at(-1);
    expect(appended?.role).toBe('user');
    expect(appended?.text).toBe('## sneaky heading\n\nText.');
    expect(serializeChatMessage(appended ?? { role: 'user', text: '' })).toBe(
      `## user\n\n## sneaky heading\n\nText.\n\n`,
    );

    const missing = await appendChatMessage(root, {
      chatId: 'chat_unknown',
      message: { role: 'user', text: 'Hello.' },
      at: '2026-09-10T12:00:00Z',
    });
    expect(missing.success).toBe(false);
    expect(missing.diagnostics.map((entry) => entry.code)).toEqual([
      'chat.missing',
    ]);
  });

  it('appends message text that begins with a yaml metadata fence and parses it back unchanged', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');

    const plain = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'assistant',
        text: '```yaml\nsneaky: true\n```\n\nBody.',
      },
      at: '2026-09-10T12:00:00Z',
    });
    expect(plain.success).toBe(true);

    const afterBlankLines = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'assistant',
        text: '  \n```yaml\nsneaky: true\n```',
        metadata: { provider: 'openai', at: '2026-09-10T12:00:00Z' },
      },
      at: '2026-09-10T12:00:00Z',
    });
    expect(afterBlankLines.success).toBe(true);

    const crlf = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'assistant',
        text: '```yaml\r\nsneaky: true\r\n```',
      },
      at: '2026-09-10T12:00:00Z',
    });
    expect(crlf.success).toBe(true);

    const parsed = parseTranscript(
      bodySlice(await readFile(file, 'utf8')),
      file,
    );
    expect(parsed.diagnostics).toEqual([]);
    const appended = parsed.messages.slice(-3);
    expect(appended.map((message) => message.text)).toEqual([
      '```yaml\nsneaky: true\n```\n\nBody.',
      '```yaml\nsneaky: true\n```',
      '```yaml\r\nsneaky: true\r\n```',
    ]);
    expect(appended.map((message) => message.metadata)).toEqual([
      {},
      { provider: 'openai', at: '2026-09-10T12:00:00Z' },
      {},
    ]);
    expect(serializeTranscript('', appended.slice(0, 1))).toContain(
      '```yaml\n{}\n```',
    );
  });

  it('appends a yaml fence that is not at the start and parses it back unchanged', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-10-lab-agenda.md');
    const text = 'Intro.\n\n```yaml\nfine: true\n```\n\nOutro.';

    const result = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: {
        role: 'assistant',
        text,
        metadata: { provider: 'openai', at: '2026-09-10T12:00:00Z' },
      },
      at: '2026-09-10T12:00:00Z',
    });
    expect(result.success).toBe(true);

    const parsed = parseTranscript(
      bodySlice(await readFile(file, 'utf8')),
      file,
    );
    expect(parsed.diagnostics).toEqual([]);
    const appended = parsed.messages.at(-1);
    expect(appended?.text).toBe(text);
    expect(appended?.metadata).toMatchObject({
      provider: 'openai',
      at: '2026-09-10T12:00:00Z',
    });
  });
});

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

describe('chat show command', () => {
  it('renders the transcript in human mode with provenance lines', async () => {
    const root = await copySampleWorkspace();

    const { code, out } = await runProgram([
      'chat',
      'show',
      'chat_lab_agenda',
      '--workspace',
      root,
    ]);

    expect(code).toBe(0);
    expect(out).toContain('title: Lab meeting agenda');
    expect(out).toContain('projects: (none)');
    expect(out).toContain('updated: (never)');
    expect(out).toContain('## user');
    expect(out).toContain(
      'provider: openai, model: gpt-5.6, at: 2026-09-10T09:30:00Z',
    );
    expect(out).toContain('Please draft the agenda');
    expect(out).toContain('1. Review the attached scaling notes.');
    expect(() => {
      JSON.parse(out);
    }).toThrow();
  });

  it('emits chat metadata, preamble, and messages as JSON', async () => {
    const root = await copySampleWorkspace();

    const { code, out } = await runProgram([
      'chat',
      'show',
      'chat_lab_agenda',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      command: string;
      success: boolean;
      data: {
        id: string;
        title: string;
        projects: string[];
        preamble: string;
        messages: {
          role: string;
          text: string;
          metadata: { provider: string; model: string } | null;
        }[];
      };
      diagnostics: { code: string }[];
    };
    expect(envelope.command).toBe('chat show');
    expect(envelope.success).toBe(true);
    expect(envelope.diagnostics).toEqual([]);
    expect(envelope.data.id).toBe('chat_lab_agenda');
    expect(envelope.data.projects).toEqual([]);
    expect(envelope.data.preamble).toBe(
      '\nPlanning thread for the weekly lab meeting.\n\n',
    );
    expect(envelope.data.messages).toHaveLength(2);
    expect(envelope.data.messages[0]).toMatchObject({
      role: 'user',
      metadata: null,
    });
    expect(envelope.data.messages[1]?.metadata).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6',
    });
  });

  it('reports chat.missing with exit 1 for an unknown chat', async () => {
    const root = await copySampleWorkspace();

    const json = await runProgram([
      'chat',
      'show',
      'chat_unknown',
      '--workspace',
      root,
      '--json',
    ]);
    expect(json.code).toBe(1);
    const envelope = JSON.parse(json.out) as {
      success: boolean;
      data: null;
      diagnostics: { code: string; severity: string }[];
    };
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('chat.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');

    const human = await runProgram([
      'chat',
      'show',
      'chat_unknown',
      '--workspace',
      root,
    ]);
    expect(human.code).toBe(1);
    expect(human.out).toBe('');
    expect(human.err).toContain('[chat.missing]');
  });

  it('shows an appended message after appendChatMessage updated the file', async () => {
    const root = await copySampleWorkspace();
    const appended = await appendChatMessage(root, {
      chatId: 'chat_lab_agenda',
      message: { role: 'tool', text: 'Calendar checked.' },
      at: '2026-09-10T13:00:00Z',
    });
    expect(appended.success).toBe(true);

    const { code, out } = await runProgram([
      'chat',
      'show',
      'chat_lab_agenda',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      data: {
        updated: string;
        messages: { role: string; text: string }[];
      };
    };
    expect(envelope.data.updated).toBe('2026-09-10T13:00:00Z');
    expect(envelope.data.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });
});
