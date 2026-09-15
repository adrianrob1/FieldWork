import { createServer, type Server } from 'node:http';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDraft,
  draftFilePath,
  markDraftConsumed,
  updateDraft,
} from '../../src/files/draftStore.js';
import { parseMarkdownSource } from '../../src/files/frontmatter.js';
import { parseTranscript } from '../../src/files/transcript.js';
import { hashOf } from '../../src/operations/edit.js';
import {
  draftRoute,
  getDraft,
  listDrafts,
  stageInDraft,
  stageTaskInDraft,
  submitDraft,
  type DraftView,
} from '../../src/operations/drafts.js';
import { todayDate } from '../../src/operations/start.js';
import { lexicalSearch } from '../../src/search/lexical.js';

vi.mock('../../src/files/draftStore.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/files/draftStore.js')>();
  return { ...actual };
});

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const stubServers: Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-drafts-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
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

async function write(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

function stubBackendSettings(server: StubServer): string {
  return [
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
    '      type: openai',
    `      base_url: ${server.url}`,
    '      model: test-model',
    '',
  ].join('\n');
}

interface DraftHandle {
  id: string;
  contentHash: string;
  file: string;
}

async function makeDraft(
  root: string,
  input: {
    message?: string;
    projects?: string[];
    backend?: string;
    attachments?: { id?: string; path?: string }[];
  },
): Promise<DraftHandle> {
  const created = await createDraft(root, input);
  if (created.draft === null) {
    throw new Error(`Draft creation failed: ${JSON.stringify(created)}`);
  }
  return {
    id: created.draft.id,
    contentHash: created.contentHash ?? '',
    file: draftFilePath(root, created.draft.id),
  };
}

function viewOrThrow(result: {
  success: boolean;
  data: DraftView | null;
}): DraftView {
  if (!result.success || result.data === null) {
    throw new Error(`Expected a draft view, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function chatFileNames(root: string): Promise<string[]> {
  return (await readdir(path.join(root, 'chats'))).sort();
}

const taskAttachmentHeader =
  '<attachment kind="task" title="Refresh the lab whiteboard">';
const taskAttachmentBlock = [
  taskAttachmentHeader,
  'Wipe the whiteboard and copy the still-open items onto a fresh sheet.',
  '</attachment>',
].join('\n');

describe('task staging in drafts', () => {
  it('creates a new draft with the task staged', async () => {
    const root = await copySampleWorkspace();

    const staged = await stageTaskInDraft(root, {
      taskId: 'task_lab_refresh',
    });

    const view = viewOrThrow(staged);
    expect(staged.success).toBe(true);
    expect(staged.changed).toBe(true);
    expect(view.draft.id).toMatch(/^draft_[a-z0-9]{12}$/);
    expect(view.draft.message).toBe('');
    expect(view.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(view.route).toBe(draftRoute(view.draft.id));
    expect(view.route).toBe(`/chats/new?draft=${view.draft.id}`);
    expect(view.contentHash).toBe(
      hashOf(await readFile(draftFilePath(root, view.draft.id))),
    );
    expect(await fileExists(draftFilePath(root, view.draft.id))).toBe(true);
  });

  it('dedupes a task already staged in the draft', async () => {
    const root = await copySampleWorkspace();
    const first = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });
    const firstView = viewOrThrow(first);
    const before = await readFile(draftFilePath(root, firstView.draft.id));

    const second = await stageTaskInDraft(root, {
      taskId: 'task_lab_refresh',
      draftId: firstView.draft.id,
    });

    const secondView = viewOrThrow(second);
    expect(second.changed).toBe(false);
    expect(secondView.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(await readFile(draftFilePath(root, firstView.draft.id))).toEqual(
      before,
    );
  });

  it('preserves message, projects, and backend when staging into an explicit draft', async () => {
    const root = await copySampleWorkspace();
    const handle = await makeDraft(root, {
      message: 'Existing message',
      projects: ['project_evon'],
      backend: 'stub-model',
      attachments: [{ id: 'task_scaling_review' }],
    });

    const staged = await stageTaskInDraft(root, {
      taskId: 'task_lab_refresh',
      draftId: handle.id,
    });

    const view = viewOrThrow(staged);
    expect(staged.changed).toBe(true);
    expect(view.draft.message).toBe('Existing message');
    expect(view.draft.projects).toEqual(['project_evon']);
    expect(view.draft.backend).toBe('stub-model');
    expect(view.draft.attachments).toEqual([
      { id: 'task_scaling_review' },
      { id: 'task_lab_refresh' },
    ]);
    expect(view.contentHash).not.toBe(handle.contentHash);
  });

  it('reports task.missing for an unknown task', async () => {
    const root = await copySampleWorkspace();

    const staged = await stageTaskInDraft(root, { taskId: 'task_unknown' });

    expect(staged.success).toBe(false);
    expect(staged.diagnostics.map((entry) => entry.code)).toEqual([
      'task.missing',
    ]);
    const draftsDirectory = path.join(root, '.workspace', 'drafts');
    expect(await fileExists(draftsDirectory)).toBe(false);
  });
});

describe('draft reuse on staging', () => {
  it('reuses the reusable draft instead of minting (stage twice, one draft)', async () => {
    const root = await copySampleWorkspace();

    const first = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });
    const firstView = viewOrThrow(first);

    const second = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });
    const secondView = viewOrThrow(second);

    expect(secondView.draft.id).toBe(firstView.draft.id);
    expect(secondView.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(second.changed).toBe(false);
  });

  it('stages into an existing empty draft rather than creating one', async () => {
    const root = await copySampleWorkspace();
    const empty = await makeDraft(root, {});

    const staged = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });

    const view = viewOrThrow(staged);
    expect(view.draft.id).toBe(empty.id);
    expect(view.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(await fileExists(empty.file)).toBe(true);
  });

  it('skips drafts with message text and mints a new one', async () => {
    const root = await copySampleWorkspace();
    const busy = await makeDraft(root, { message: 'Already drafting.' });
    const before = await readFile(busy.file);

    const staged = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });

    const view = viewOrThrow(staged);
    expect(view.draft.id).not.toBe(busy.id);
    expect(view.draft.message).toBe('');
    expect(view.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(await readFile(busy.file)).toEqual(before);
  });

  it('skips a draft that only holds a different attachment', async () => {
    const root = await copySampleWorkspace();
    const other = await makeDraft(root, {
      attachments: [{ id: 'task_scaling_review' }],
    });

    const staged = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });

    const view = viewOrThrow(staged);
    expect(view.draft.id).not.toBe(other.id);
    expect(view.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
  });

  it('treats projects and backend picks alone as reusable', async () => {
    const root = await copySampleWorkspace();
    const picked = await makeDraft(root, {
      projects: ['project_evon'],
      backend: 'stub-model',
    });

    const staged = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });

    const view = viewOrThrow(staged);
    expect(view.draft.id).toBe(picked.id);
    expect(view.draft.projects).toEqual(['project_evon']);
    expect(view.draft.backend).toBe('stub-model');
    expect(view.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
  });

  it('reuses the most recently updated reusable draft', async () => {
    const root = await copySampleWorkspace();
    const older = await makeDraft(root, {});
    const newer = await makeDraft(root, {});
    // Touch the older draft so its `updated` is newest.
    await updateDraft(root, {
      id: older.id,
      expectedHash: older.contentHash,
      patch: { projects: ['project_evon'] },
    });

    const staged = await stageTaskInDraft(root, { taskId: 'task_lab_refresh' });

    const view = viewOrThrow(staged);
    expect(view.draft.id).toBe(older.id);
    expect(view.draft.id).not.toBe(newer.id);
  });
});

describe('generic staging in drafts', () => {
  it('creates a new draft with a chat staged', async () => {
    const root = await copySampleWorkspace();

    const staged = await stageInDraft(root, {
      attachable: { kind: 'chat', id: 'chat_lab_agenda' },
    });

    const view = viewOrThrow(staged);
    expect(staged.success).toBe(true);
    expect(staged.changed).toBe(true);
    expect(view.draft.message).toBe('');
    expect(view.draft.attachments).toEqual([{ id: 'chat_lab_agenda' }]);
    expect(view.route).toBe(draftRoute(view.draft.id));
    expect(await fileExists(draftFilePath(root, view.draft.id))).toBe(true);
  });

  it('appends a chat to an existing draft', async () => {
    const root = await copySampleWorkspace();
    const handle = await makeDraft(root, {
      message: 'Existing message',
      attachments: [{ id: 'task_lab_refresh' }],
    });

    const staged = await stageInDraft(root, {
      attachable: { kind: 'chat', id: 'chat_lab_agenda' },
      draftId: handle.id,
    });

    const view = viewOrThrow(staged);
    expect(staged.changed).toBe(true);
    expect(view.draft.message).toBe('Existing message');
    expect(view.draft.attachments).toEqual([
      { id: 'task_lab_refresh' },
      { id: 'chat_lab_agenda' },
    ]);
  });

  it('reports chat.missing for an unknown chat', async () => {
    const root = await copySampleWorkspace();

    const staged = await stageInDraft(root, {
      attachable: { kind: 'chat', id: 'chat_unknown' },
    });

    expect(staged.success).toBe(false);
    expect(staged.diagnostics.map((entry) => entry.code)).toEqual([
      'chat.missing',
    ]);
  });

  it('rejects a chat id that is not a chat', async () => {
    const root = await copySampleWorkspace();

    const staged = await stageInDraft(root, {
      attachable: { kind: 'chat', id: 'task_lab_refresh' },
    });

    expect(staged.success).toBe(false);
    expect(staged.diagnostics.map((entry) => entry.code)).toEqual([
      'chat.missing',
    ]);
  });
});

describe('draft views', () => {
  it('returns draft views with content hashes and routes', async () => {
    const root = await copySampleWorkspace();
    const handle = await makeDraft(root, { message: 'View me' });

    const got = await getDraft(root, { id: handle.id });
    const view = viewOrThrow(got);
    expect(view.draft.message).toBe('View me');
    expect(view.route).toBe(draftRoute(handle.id));
    expect(view.contentHash).toBe(handle.contentHash);

    const listed = await listDrafts(root);
    expect(listed.success).toBe(true);
    expect(listed.data?.map((entry) => entry.draft.id)).toEqual([handle.id]);
    expect(listed.data?.[0]?.route).toBe(draftRoute(handle.id));
  });

  it('reports draft.missing for consumed drafts and lazily deletes them', async () => {
    const root = await copySampleWorkspace();
    const handle = await makeDraft(root, { message: 'Almost submitted' });

    const marked = await markDraftConsumed(root, handle.id);
    expect(marked.draft?.consumed).toBe(true);

    const got = await getDraft(root, { id: handle.id });
    expect(got.success).toBe(false);
    expect(got.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
    expect(await fileExists(handle.file)).toBe(false);
  });
});

describe('draft submission', () => {
  it('creates the canonical chat with derived identity and consumes the draft', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const message = 'Plan the whiteboard refresh\n\nAlso share the notes.';
    const handle = await makeDraft(root, {
      message,
      projects: ['project_evon'],
      attachments: [{ id: 'task_lab_refresh' }],
    });
    const today = todayDate();

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(true);
    expect(submitted.changed).toBe(true);
    expect(submitted.data?.draftConsumed).toBe(true);
    expect(submitted.data?.chat.chatId).toBe('plan_the_whiteboard_refresh');
    expect(submitted.data?.chat.title).toBe('Plan the whiteboard refresh');
    const chatFile = path.join(
      root,
      'chats',
      `${today}-plan-the-whiteboard-refresh.md`,
    );
    expect(submitted.data?.chat.file).toBe(chatFile);
    expect(submitted.data?.chat.contentHash).toBe(
      hashOf(await readFile(chatFile)),
    );
    expect(await fileExists(handle.file)).toBe(false);

    const taskSource = await readFile(
      path.join(root, 'tasks/lab-refresh.md'),
      'utf8',
    );
    const taskBody =
      parseMarkdownSource('lab-refresh.md', taskSource).body ?? '';
    expect(taskBody.trim()).toBe(
      'Wipe the whiteboard and copy the still-open items onto a fresh sheet.',
    );

    const source = await readFile(chatFile, 'utf8');
    expect(source).toContain('id: plan_the_whiteboard_refresh');
    expect(source).toContain('title: Plan the whiteboard refresh');
    expect(source).toContain(`created: ${today}`);
    expect(source).toContain(`updated: ${today}`);
    expect(source).toContain('- project_evon');
    expect(source).not.toContain(taskAttachmentHeader);

    const stored = parseTranscript(source, chatFile);
    expect(stored.diagnostics).toEqual([]);
    expect(stored.messages).toHaveLength(2);
    const user = stored.messages[0];
    const assistant = stored.messages[1];
    expect(user?.role).toBe('user');
    expect(user?.text).toBe(message);
    expect(user?.metadata?.at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(user?.metadata?.attachments).toEqual([
      {
        id: 'task_lab_refresh',
        path: 'tasks/lab-refresh.md',
        label: 'Refresh the lab whiteboard',
        mime: 'text/markdown',
        kind: 'task',
        title: 'Refresh the lab whiteboard',
        size: Buffer.byteLength(taskBody, 'utf8'),
      },
    ]);
    const storedAttachment = user?.metadata?.attachments[0];
    expect(storedAttachment?.label.includes('/')).toBe(false);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.text).toBe(
      'Triffid marker reply about posterior diagnostics.',
    );
    expect(assistant?.metadata?.provider).toBe('openai-compatible');
    expect(assistant?.metadata?.model).toBe('stub-model-v2');
    expect(assistant?.metadata?.backend).toBe('stub-model');
    expect(assistant?.metadata?.at).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(assistant?.metadata?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 7,
      total_tokens: 19,
    });

    expect(server.requests).toHaveLength(1);
    const request = server.requests[0];
    expect(request?.url).toBe('/v1/chat/completions');
    const body = JSON.parse(request?.body ?? '{}') as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('test-model');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.role).toBe('user');
    expect(body.messages[0]?.content).toContain('<fieldwork_workspace>');
    expect(body.messages[0]?.content).toContain(message);
    expect(body.messages[0]?.content).toContain(taskAttachmentBlock);

    const found = await lexicalSearch(root, { query: 'triffid' });
    expect(
      found.data.results.some(
        (entry) =>
          entry.path === `chats/${today}-plan-the-whiteboard-refresh.md` &&
          entry.objectId === 'plan_the_whiteboard_refresh',
      ),
    ).toBe(true);

    const exchanged = submitted.data?.exchange;
    expect(exchanged?.user.text).toBe(message);
    expect(exchanged?.user.metadata.attachments).toHaveLength(1);
    expect(exchanged?.assistant.text).toBe(
      'Triffid marker reply about posterior diagnostics.',
    );
    expect(exchanged?.assistant.metadata.backend).toBe('stub-model');
  });

  it('caps the derived title at eighty characters', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, {
      message: `${'T'.repeat(90)}\nsecond line`,
    });

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(true);
    expect(submitted.data?.chat.title).toBe('T'.repeat(80));
    expect(submitted.data?.chat.title.length).toBe(80);
    expect(await fileExists(handle.file)).toBe(false);
  });

  it('dedupes the chat id and file name for a repeated title', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const message = 'Plan the whiteboard refresh\n\nAlso share the notes.';
    const first = await makeDraft(root, { message });
    const second = await makeDraft(root, { message });
    const today = todayDate();

    const firstSubmit = await submitDraft(root, {
      draftId: first.id,
      expectedHash: first.contentHash,
    });
    const secondSubmit = await submitDraft(root, {
      draftId: second.id,
      expectedHash: second.contentHash,
    });

    expect(firstSubmit.success).toBe(true);
    expect(firstSubmit.data?.chat.chatId).toBe('plan_the_whiteboard_refresh');
    expect(secondSubmit.success).toBe(true);
    expect(secondSubmit.data?.chat.chatId).toBe(
      'plan_the_whiteboard_refresh_2',
    );
    expect(secondSubmit.data?.chat.file).toBe(
      path.join(root, 'chats', `${today}-plan-the-whiteboard-refresh-2.md`),
    );
  });

  it('rejects a stale draft hash without writing', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, { message: 'Hello there.' });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: '0'.repeat(64),
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.stale_hash',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(0);
  });

  it('rejects unknown projects without writing', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, {
      message: 'Hello there.',
      projects: ['project_missing'],
    });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'project.missing',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(0);
  });

  it('rejects an unknown backend without writing', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, {
      message: 'Hello there.',
      backend: 'ghost-model',
    });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.unconfigured',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(0);
  });

  it('rejects unresolvable attachments without writing', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, {
      message: 'Hello there.',
      attachments: [{ id: 'task_missing' }],
    });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(0);
  });

  it('preserves the draft when the backend fails', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    server.respond(500, '{"error": "upstream exploded"}');
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, {
      message: 'Hello there.',
      attachments: [{ id: 'task_lab_refresh' }],
    });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.http_status',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(1);
  });

  it('keeps the chat and warns when draft consumption fails', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, { message: 'Hello there.' });
    const draftsModule = await import('../../src/files/draftStore.js');
    const spy = vi
      .spyOn(draftsModule, 'deleteDraft')
      .mockRejectedValue(new Error('unlink refused'));
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(true);
    expect(submitted.data?.draftConsumed).toBe(false);
    const warning = submitted.diagnostics.find(
      (entry) => entry.code === 'draft.consumption_failed',
    );
    expect(warning?.severity).toBe('warning');
    expect(submitted.data?.chat.chatId).toBe('hello_there');
    expect((await chatFileNames(root)).length).toBe(chatsBefore.length + 1);
    expect(await fileExists(handle.file)).toBe(true);
    const draftSource = await readFile(handle.file, 'utf8');
    expect(draftSource).toContain('consumed: true');
    expect(spy).toHaveBeenCalledTimes(1);

    const got = await getDraft(root, { id: handle.id });
    expect(got.success).toBe(false);
    expect(got.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
    expect(await fileExists(handle.file)).toBe(false);

    const listed = await listDrafts(root);
    expect(listed.data?.map((entry) => entry.draft.id)).not.toContain(
      handle.id,
    );
  });

  it('rejects an empty message', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, { message: '   \n\n  ' });
    const before = await readFile(handle.file);
    const chatsBefore = await chatFileNames(root);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });

    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.empty_message',
    ]);
    expect(await readFile(handle.file)).toEqual(before);
    expect(await chatFileNames(root)).toEqual(chatsBefore);
    expect(server.requests).toHaveLength(0);
  });

  it('rejects a submission for a consumed draft', async () => {
    const root = await copySampleWorkspace();
    const server = await startStubServer();
    await write(root, 'workspace.yml', stubBackendSettings(server));
    const handle = await makeDraft(root, { message: 'Hello there.' });

    await markDraftConsumed(root, handle.id);

    const submitted = await submitDraft(root, {
      draftId: handle.id,
      expectedHash: handle.contentHash,
    });
    expect(submitted.success).toBe(false);
    expect(submitted.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
    expect(await fileExists(handle.file)).toBe(false);
    expect(server.requests).toHaveLength(0);
  });
});
