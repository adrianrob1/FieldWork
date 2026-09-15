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
import type { TaskView } from '../../src/operations/tasks.js';
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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-tasksapi-'));
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

async function startTestServer(root?: string): Promise<{
  root: string;
  baseUrl: string;
}> {
  const workspaceRoot = root ?? (await copySampleWorkspace());
  const handle = await startServer(workspaceRoot, {
    host: '127.0.0.1',
    port: 0,
  });
  runningHandles.push(handle);
  return { root: workspaceRoot, baseUrl: handle.url };
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
      requests.push({
        url: request.url ?? '',
        headers: {},
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

async function useStubBackend(root: string, server: StubServer): Promise<void> {
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
      '      type: openai',
      `      base_url: ${server.url}`,
      '      model: test-model',
      '',
    ].join('\n'),
  );
}

interface TaskListBody {
  tasks: TaskView[];
  groups: {
    active: TaskView[];
    overdue: TaskView[];
    upcoming: TaskView[];
    done: TaskView[];
  };
  diagnostics: Diagnostic[];
}

interface TaskBody {
  task: TaskView;
  diagnostics: Diagnostic[];
}

interface FailureBody {
  error: string;
  diagnostics: Diagnostic[];
  currentHash?: string | null;
}

async function taskDetail(
  baseUrl: string,
  taskId: string,
): Promise<{ status: number; task: TaskView | null; body: unknown }> {
  const { status, body } = await getJson(baseUrl, `/api/tasks/${taskId}`);
  if (status !== 200) {
    return { status, task: null, body };
  }
  const view = body as TaskBody;
  return { status, task: view.task, body };
}

async function createDraft(
  baseUrl: string,
  input: {
    message?: string;
    projects?: string[];
    backend?: string;
    attachments?: { id?: string; path?: string }[];
  },
): Promise<DraftView> {
  const { status, body } = await postJson(baseUrl, '/api/drafts', input);
  const view = body as { draft: DraftView; diagnostics: Diagnostic[] };
  if (status !== 201 || view.draft === undefined) {
    throw new Error(`Draft creation failed: ${JSON.stringify(body)}`);
  }
  return view.draft;
}

describe('task list and detail API', () => {
  it('lists tasks with active, overdue, upcoming, and done groups', async () => {
    const { root, baseUrl } = await startTestServer();
    const { status, body } = await getJson(baseUrl, '/api/tasks');
    const view = body as TaskListBody;

    expect(status).toBe(200);
    expect(view.tasks.map((task) => task.id)).toEqual([
      'task_baseline_notes',
      'task_writers_room',
      'task_lab_refresh',
      'task_scaling_review',
    ]);
    expect(view.groups.active.map((task) => task.id)).toEqual([
      'task_baseline_notes',
      'task_writers_room',
      'task_lab_refresh',
    ]);
    expect(view.groups.overdue.map((task) => task.id)).toEqual([
      'task_baseline_notes',
    ]);
    expect(view.groups.upcoming.map((task) => task.id)).toEqual([
      'task_writers_room',
    ]);
    expect(view.groups.done.map((task) => task.id)).toEqual([
      'task_scaling_review',
    ]);
    const overdue = view.groups.overdue[0];
    expect(overdue?.overdue).toBe(true);
    const baseline = await taskDetail(baseUrl, 'task_baseline_notes');
    expect(baseline.task?.contentHash).toBe(
      await hash(root, 'tasks/baseline-notes.md'),
    );
  });

  it('returns one task with its canonical path and body', async () => {
    const { baseUrl } = await startTestServer();
    const { status, task } = await taskDetail(baseUrl, 'task_lab_refresh');

    expect(status).toBe(200);
    expect(task?.id).toBe('task_lab_refresh');
    expect(task?.title).toBe('Refresh the lab whiteboard');
    expect(task?.status).toBe('active');
    expect(task?.path).toBe('tasks/lab-refresh.md');
    expect(task?.description).toBe(
      'Wipe the whiteboard and copy the still-open items onto a fresh sheet.',
    );
    expect(task?.projects).toEqual([]);
  });

  it('reports 404 with task.missing for an unknown task', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await getJson(baseUrl, '/api/tasks/task_unknown');
    const failure = body as FailureBody;

    expect(status).toBe(404);
    expect(failure.diagnostics[0]?.code).toBe('task.missing');
  });
});

describe('task creation API', () => {
  it('creates a task from quick-add text with a derived id and file', async () => {
    const { root, baseUrl } = await startTestServer();
    const { status, body } = await postJson(baseUrl, '/api/tasks', {
      text: 'Ship the wave report\nSummarize the remaining waves.',
      projects: ['project_evon'],
      deadline: '2026-10-15',
    });
    const view = body as TaskBody;

    expect(status).toBe(201);
    expect(view.task.id).toBe('task_ship_the_wave_report');
    expect(view.task.title).toBe('Ship the wave report');
    expect(view.task.description).toBe('Summarize the remaining waves.');
    expect(view.task.status).toBe('active');
    expect(view.task.projects).toEqual(['project_evon']);
    expect(view.task.deadline).toBe('2026-10-15');
    expect(view.task.path).toBe(`tasks/${todayDate()}-ship-the-wave-report.md`);
    expect(view.diagnostics.every((entry) => entry.severity !== 'error')).toBe(
      true,
    );

    const contents = await read(
      root,
      `tasks/${todayDate()}-ship-the-wave-report.md`,
    );
    expect(contents).toContain('id: task_ship_the_wave_report');
    expect(contents).toContain('title: Ship the wave report');
    expect(contents).toContain('status: active');
    expect(contents).toContain('deadline: 2026-10-15');
    expect(contents).toContain('Summarize the remaining waves.');
  });

  it('answers 404 project.missing for an unknown project', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(baseUrl, '/api/tasks', {
      text: 'Orphan task',
      projects: ['project_nope'],
    });
    const failure = body as FailureBody;

    expect(status).toBe(404);
    expect(failure.diagnostics[0]?.code).toBe('project.missing');
  });

  it('answers 422 for an invalid deadline', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(baseUrl, '/api/tasks', {
      text: 'Dated task',
      deadline: 'not-a-date',
    });
    const failure = body as FailureBody;

    expect(status).toBe(422);
    expect(failure.diagnostics[0]?.code).toBe('task.invalid_deadline');
  });

  it('answers 400 when the text field is missing or empty', async () => {
    const { baseUrl } = await startTestServer();
    const missing = await postJson(baseUrl, '/api/tasks', {});
    expect(missing.status).toBe(400);
    const empty = await postJson(baseUrl, '/api/tasks', { text: '   ' });
    expect(empty.status).toBe(400);
  });
});

describe('add & open chat API', () => {
  it('creates the task and a draft with the task staged', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(
      baseUrl,
      '/api/tasks/add-open-chat',
      {
        text: 'Plan the review sync',
        projects: ['project_evon'],
      },
    );
    const view = body as {
      task: TaskView;
      draft: DraftView | null;
      diagnostics: Diagnostic[];
    };

    expect(status).toBe(201);
    expect(view.task.id).toBe('task_plan_the_review_sync');
    expect(view.draft).not.toBeNull();
    expect(view.draft?.draft.attachments).toEqual([
      { id: 'task_plan_the_review_sync' },
    ]);
    expect(view.draft?.draft.message).toBe('');
    expect(view.draft?.draft.projects).toEqual([]);
    expect(view.draft?.route).toBe(
      `/chats/new?draft=${view.draft?.draft.id ?? ''}`,
    );
    expect(view.draft?.draft.id).toMatch(/^draft_[a-z0-9]{12}$/);

    const listed = await getJson(baseUrl, '/api/drafts');
    const listView = listed.body as { drafts: DraftView[] };
    expect(listView.drafts.map((draft) => draft.draft.id)).toContain(
      view.draft?.draft.id,
    );
  });

  it('stages a new task into an existing draft', async () => {
    const { baseUrl } = await startTestServer();
    const draft = await createDraft(baseUrl, {
      message: 'Existing draft message',
    });
    const { status, body } = await postJson(
      baseUrl,
      '/api/tasks/add-open-chat',
      { text: 'Second sync task', draftId: draft.draft.id },
    );
    const view = body as {
      task: TaskView;
      draft: DraftView | null;
      diagnostics: Diagnostic[];
    };

    expect(status).toBe(201);
    expect(view.draft?.draft.id).toBe(draft.draft.id);
    expect(view.draft?.draft.message).toBe('Existing draft message');
    expect(view.draft?.draft.attachments).toEqual([{ id: view.task.id }]);
  });

  it('keeps the created task when staging fails', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(
      baseUrl,
      '/api/tasks/add-open-chat',
      { text: 'Task without a draft', draftId: 'draft_000000000000' },
    );
    const view = body as {
      task: TaskView;
      draft: DraftView | null;
      diagnostics: Diagnostic[];
    };

    expect(status).toBe(201);
    expect(view.task.id).toBe('task_task_without_a_draft');
    expect(view.draft).toBeNull();
    expect(
      view.diagnostics.some((entry) => entry.code === 'draft.missing'),
    ).toBe(true);
  });
});

describe('open chat API on an existing task', () => {
  it('creates a draft with the sample task staged', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(
      baseUrl,
      '/api/tasks/task_lab_refresh/open-chat',
      {},
    );
    const view = body as { draft: DraftView; diagnostics: Diagnostic[] };

    expect(status).toBe(200);
    expect(view.draft.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(view.draft.route).toBe(`/chats/new?draft=${view.draft.draft.id}`);
  });

  it('stages into an explicit draft and preserves its message', async () => {
    const { baseUrl } = await startTestServer();
    const draft = await createDraft(baseUrl, {
      message: 'Keep this text',
      projects: ['project_soap_bubbles'],
    });
    const { status, body } = await postJson(
      baseUrl,
      '/api/tasks/task_lab_refresh/open-chat',
      { draftId: draft.draft.id },
    );
    const view = body as { draft: DraftView; diagnostics: Diagnostic[] };

    expect(status).toBe(200);
    expect(view.draft.draft.id).toBe(draft.draft.id);
    expect(view.draft.draft.message).toBe('Keep this text');
    expect(view.draft.draft.projects).toEqual(['project_soap_bubbles']);
    expect(view.draft.draft.attachments).toEqual([{ id: 'task_lab_refresh' }]);
  });

  it('answers 404 for an unknown task or draft', async () => {
    const { baseUrl } = await startTestServer();
    const task = await postJson(
      baseUrl,
      '/api/tasks/task_unknown/open-chat',
      {},
    );
    expect(task.status).toBe(404);
    expect((task.body as FailureBody).diagnostics[0]?.code).toBe(
      'task.missing',
    );

    const draft = await postJson(
      baseUrl,
      '/api/tasks/task_lab_refresh/open-chat',
      { draftId: 'draft_000000000000' },
    );
    expect(draft.status).toBe(404);
    expect((draft.body as FailureBody).diagnostics[0]?.code).toBe(
      'draft.missing',
    );
  });
});

describe('open chat API on an existing chat', () => {
  it('creates a draft with the sample chat staged', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await postJson(
      baseUrl,
      '/api/chats/chat_lab_agenda/open-chat',
      {},
    );
    const view = body as { draft: DraftView; diagnostics: Diagnostic[] };

    expect(status).toBe(200);
    expect(view.draft.draft.attachments).toEqual([{ id: 'chat_lab_agenda' }]);
    expect(view.draft.route).toBe(`/chats/new?draft=${view.draft.draft.id}`);
  });

  it('stages into an explicit draft and preserves its message', async () => {
    const { baseUrl } = await startTestServer();
    const draft = await createDraft(baseUrl, {
      message: 'Keep this text',
      projects: ['project_soap_bubbles'],
    });
    const { status, body } = await postJson(
      baseUrl,
      '/api/chats/chat_lab_agenda/open-chat',
      { draftId: draft.draft.id },
    );
    const view = body as { draft: DraftView; diagnostics: Diagnostic[] };

    expect(status).toBe(200);
    expect(view.draft.draft.id).toBe(draft.draft.id);
    expect(view.draft.draft.message).toBe('Keep this text');
    expect(view.draft.draft.projects).toEqual(['project_soap_bubbles']);
    expect(view.draft.draft.attachments).toEqual([{ id: 'chat_lab_agenda' }]);
  });

  it('answers 404 for an unknown chat or draft', async () => {
    const { baseUrl } = await startTestServer();
    const chat = await postJson(
      baseUrl,
      '/api/chats/chat_unknown/open-chat',
      {},
    );
    expect(chat.status).toBe(404);
    expect((chat.body as FailureBody).diagnostics[0]?.code).toBe(
      'chat.missing',
    );

    const draft = await postJson(
      baseUrl,
      '/api/chats/chat_lab_agenda/open-chat',
      { draftId: 'draft_000000000000' },
    );
    expect(draft.status).toBe(404);
    expect((draft.body as FailureBody).diagnostics[0]?.code).toBe(
      'draft.missing',
    );
  });
});

describe('task mutation API', () => {
  it('updates a task with a fresh hash and rejects stale or missing hashes', async () => {
    const { baseUrl } = await startTestServer();
    const created = await postJson(baseUrl, '/api/tasks', {
      text: 'Original task',
    });
    const taskId = (created.body as TaskBody).task.id;

    const missing = await postJson(baseUrl, `/api/tasks/${taskId}/update`, {
      title: 'Renamed task',
    });
    expect(missing.status).toBe(400);
    expect((missing.body as FailureBody).diagnostics[0]?.code).toBe(
      'edit.hash_required',
    );

    const stale = await postJson(baseUrl, `/api/tasks/${taskId}/update`, {
      title: 'Renamed task',
      expectedHash: '0'.repeat(64),
    });
    const staleBody = stale.body as FailureBody;
    const fresh = await taskDetail(baseUrl, taskId);
    expect(stale.status).toBe(409);
    expect(staleBody.diagnostics[0]?.code).toBe('edit.stale_hash');
    expect(staleBody.currentHash).toBe(fresh.task?.contentHash);

    const updated = await postJson(baseUrl, `/api/tasks/${taskId}/update`, {
      title: 'Renamed task',
      body: 'New body text.',
      deadline: '2026-11-01',
      expectedHash: fresh.task?.contentHash ?? '',
    });
    const updateView = updated.body as TaskBody;
    expect(updated.status).toBe(200);
    expect(updateView.task.title).toBe('Renamed task');
    expect(updateView.task.description).toBe('New body text.');
    expect(updateView.task.deadline).toBe('2026-11-01');
    expect(updateView.task.contentHash).not.toBe(fresh.task?.contentHash);
  });

  it('marks a task done and reopens it with hash preconditions', async () => {
    const { baseUrl } = await startTestServer();
    const created = await postJson(baseUrl, '/api/tasks', {
      text: 'Lifecycle task',
    });
    const taskId = (created.body as TaskBody).task.id;

    const missing = await postJson(baseUrl, `/api/tasks/${taskId}/done`, {});
    expect(missing.status).toBe(400);

    const current = await taskDetail(baseUrl, taskId);
    const stale = await postJson(baseUrl, `/api/tasks/${taskId}/done`, {
      expectedHash: '0'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect((stale.body as FailureBody).currentHash).toBe(
      current.task?.contentHash,
    );

    const done = await postJson(baseUrl, `/api/tasks/${taskId}/done`, {
      expectedHash: current.task?.contentHash ?? '',
    });
    const doneView = done.body as TaskBody;
    expect(done.status).toBe(200);
    expect(doneView.task.status).toBe('done');
    expect(typeof doneView.task.completed).toBe('string');

    const afterDone = await taskDetail(baseUrl, taskId);
    const reopened = await postJson(baseUrl, `/api/tasks/${taskId}/reopen`, {
      expectedHash: afterDone.task?.contentHash ?? '',
    });
    const reopenView = reopened.body as TaskBody;
    expect(reopened.status).toBe(200);
    expect(reopenView.task.status).toBe('active');
    expect(reopenView.task.completed).toBeUndefined();
  });

  it('snoozes a task and rejects invalid snooze arguments', async () => {
    const { baseUrl } = await startTestServer();
    const created = await postJson(baseUrl, '/api/tasks', {
      text: 'Snoozable task',
    });
    const taskId = (created.body as TaskBody).task.id;
    const current = await taskDetail(baseUrl, taskId);

    const invalid = await postJson(baseUrl, `/api/tasks/${taskId}/snooze`, {
      duration: 'soon',
      expectedHash: current.task?.contentHash ?? '',
    });
    expect(invalid.status).toBe(422);
    expect((invalid.body as FailureBody).diagnostics[0]?.code).toBe(
      'task.invalid_snooze',
    );

    const both = await postJson(baseUrl, `/api/tasks/${taskId}/snooze`, {
      duration: '30m',
      deadline: '2026-12-01',
      expectedHash: current.task?.contentHash ?? '',
    });
    expect(both.status).toBe(422);

    const neither = await postJson(baseUrl, `/api/tasks/${taskId}/snooze`, {
      expectedHash: current.task?.contentHash ?? '',
    });
    expect(neither.status).toBe(422);

    const snoozed = await postJson(baseUrl, `/api/tasks/${taskId}/snooze`, {
      duration: '1d',
      expectedHash: current.task?.contentHash ?? '',
    });
    const snoozeView = snoozed.body as TaskBody;
    const expected = new Date();
    expected.setMinutes(expected.getMinutes() + 1440);
    expect(snoozed.status).toBe(200);
    expect(snoozeView.task.deadline).toBe(todayDate(expected));

    const afterSnooze = await taskDetail(baseUrl, taskId);
    const done = await postJson(baseUrl, `/api/tasks/${taskId}/done`, {
      expectedHash: afterSnooze.task?.contentHash ?? '',
    });
    expect(done.status).toBe(200);
    const afterDone = await taskDetail(baseUrl, taskId);
    const doneSnooze = await postJson(baseUrl, `/api/tasks/${taskId}/snooze`, {
      duration: '1d',
      expectedHash: afterDone.task?.contentHash ?? '',
    });
    expect(doneSnooze.status).toBe(422);
    expect((doneSnooze.body as FailureBody).diagnostics[0]?.code).toBe(
      'task.invalid_status',
    );
  });
});

describe('drafts CRUD API', () => {
  it('creates, lists, reads, updates, and discards drafts', async () => {
    const { baseUrl } = await startTestServer();
    const created = await postJson(baseUrl, '/api/drafts', {
      message: 'Draft one',
      projects: ['project_evon'],
    });
    const createView = created.body as {
      draft: DraftView;
      diagnostics: Diagnostic[];
    };

    expect(created.status).toBe(201);
    expect(createView.draft.draft.id).toMatch(/^draft_[a-z0-9]{12}$/);
    expect(createView.draft.draft.message).toBe('Draft one');
    expect(createView.draft.draft.projects).toEqual(['project_evon']);
    expect(createView.draft.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(createView.draft.route).toBe(
      `/chats/new?draft=${createView.draft.draft.id}`,
    );

    const listed = await getJson(baseUrl, '/api/drafts');
    const listView = listed.body as { drafts: DraftView[] };
    expect(listed.status).toBe(200);
    expect(listView.drafts.map((draft) => draft.draft.id)).toContain(
      createView.draft.draft.id,
    );

    const detail = await getJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}`,
    );
    const detailView = detail.body as { draft: DraftView };
    expect(detail.status).toBe(200);
    expect(detailView.draft.draft.message).toBe('Draft one');

    const missingHash = await postJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}/update`,
      { patch: { message: 'Draft one edited' } },
    );
    expect(missingHash.status).toBe(400);
    expect((missingHash.body as FailureBody).diagnostics[0]?.code).toBe(
      'edit.hash_required',
    );

    const stale = await postJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}/update`,
      { expectedHash: '0'.repeat(64), patch: { message: 'Draft one edited' } },
    );
    const staleBody = stale.body as FailureBody;
    expect(stale.status).toBe(409);
    expect(staleBody.diagnostics[0]?.code).toBe('draft.stale_hash');
    expect(staleBody.currentHash).toBe(createView.draft.contentHash);

    const updated = await postJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}/update`,
      {
        expectedHash: createView.draft.contentHash,
        patch: { message: 'Draft one edited', backend: 'stub-model' },
      },
    );
    const updateView = updated.body as { draft: DraftView };
    expect(updated.status).toBe(200);
    expect(updateView.draft.draft.message).toBe('Draft one edited');
    expect(updateView.draft.draft.backend).toBe('stub-model');
    expect(updateView.draft.contentHash).not.toBe(createView.draft.contentHash);

    const discarded = await postJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}/discard`,
      {},
    );
    expect(discarded.status).toBe(200);
    expect((discarded.body as { deleted: boolean }).deleted).toBe(true);

    const afterDiscard = await getJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}`,
    );
    expect(afterDiscard.status).toBe(404);
    expect((afterDiscard.body as FailureBody).diagnostics[0]?.code).toBe(
      'draft.missing',
    );

    const discardAgain = await postJson(
      baseUrl,
      `/api/drafts/${createView.draft.draft.id}/discard`,
      {},
    );
    expect(discardAgain.status).toBe(404);
  });

  it('answers 404 draft.missing for an unknown draft', async () => {
    const { baseUrl } = await startTestServer();
    const detail = await getJson(baseUrl, '/api/drafts/draft_000000000000');
    expect(detail.status).toBe(404);
    expect((detail.body as FailureBody).diagnostics[0]?.code).toBe(
      'draft.missing',
    );
  });
});

describe('draft submission over HTTP', () => {
  it(
    'submits a staged task draft into a canonical chat with a backend reply',
    async () => {
      const root = await copySampleWorkspace();
      const server = await startStubServer();
      await useStubBackend(root, server);
      const { baseUrl } = await startTestServer(root);

      const staged = await postJson(
        baseUrl,
        '/api/tasks/task_lab_refresh/open-chat',
        {},
      );
      const stagedView = (staged.body as { draft: DraftView }).draft;
      const updated = await postJson(
        baseUrl,
        `/api/drafts/${stagedView.draft.id}/update`,
        {
          expectedHash: stagedView.contentHash,
          patch: { message: 'Please summarize the curvature notes' },
        },
      );
      const updatedView = (updated.body as { draft: DraftView }).draft;

      const submitted = await postJson(
        baseUrl,
        `/api/drafts/${stagedView.draft.id}/submit`,
        { expectedHash: updatedView.contentHash },
      );
      const submitView = submitted.body as {
        chat: {
          chatId: string;
          title: string;
          file: string;
          contentHash: string;
        };
        exchange: {
          user: { text: string; metadata: { attachments?: { id: string }[] } };
          assistant: { text: string };
        };
        draftConsumed: boolean;
        diagnostics: Diagnostic[];
      };

      expect(submitted.status).toBe(200);
      expect(submitView.chat.chatId).toBe(
        'please_summarize_the_curvature_notes',
      );
      expect(submitView.chat.title).toBe(
        'Please summarize the curvature notes',
      );
      expect(submitView.chat.file).toBe(
        `chats/${todayDate()}-please-summarize-the-curvature-notes.md`,
      );
      expect(submitView.chat.contentHash).toBe(
        await hash(
          root,
          `chats/${todayDate()}-please-summarize-the-curvature-notes.md`,
        ),
      );
      expect(submitView.exchange.user.text).toBe(
        'Please summarize the curvature notes',
      );
      expect(submitView.exchange.user.metadata.attachments?.[0]?.id).toBe(
        'task_lab_refresh',
      );
      expect(submitView.exchange.user.metadata.attachments?.[0]?.kind).toBe(
        'task',
      );
      expect(submitView.exchange.assistant.text).toBe(
        'Triffid marker reply about posterior diagnostics.',
      );
      expect(submitView.draftConsumed).toBe(true);

      const chat = await getJson(
        baseUrl,
        '/api/chats/please_summarize_the_curvature_notes',
      );
      expect(chat.status).toBe(200);

      const draftAfter = await getJson(
        baseUrl,
        `/api/drafts/${stagedView.draft.id}`,
      );
      expect(draftAfter.status).toBe(404);

      const contents = await read(
        root,
        `chats/${todayDate()}-please-summarize-the-curvature-notes.md`,
      );
      expect(contents).toContain('Please summarize the curvature notes');
      expect(contents).toContain(
        'Triffid marker reply about posterior diagnostics.',
      );
      expect(contents).toContain('id: task_lab_refresh');
    },
    serverTestTimeout,
  );

  it(
    'preserves the draft and answers 502 when the backend is down',
    async () => {
      const root = await copySampleWorkspace();
      const server = await startStubServer();
      await useStubBackend(root, server);
      const { baseUrl } = await startTestServer(root);
      const draft = await createDraft(baseUrl, {
        message: 'Backend outage draft',
      });
      server.respond(500, JSON.stringify({ error: 'stub down' }));

      const submitted = await postJson(
        baseUrl,
        `/api/drafts/${draft.draft.id}/submit`,
        { expectedHash: draft.contentHash },
      );
      const failure = submitted.body as FailureBody;

      expect(submitted.status).toBe(502);
      expect(failure.diagnostics[0]?.code).toBe('backend.http_status');

      const intact = await getJson(baseUrl, `/api/drafts/${draft.draft.id}`);
      expect(intact.status).toBe(200);
      const chats = await getJson(baseUrl, '/api/chats');
      const ids = ((chats.body as { chats: { id: string }[] }).chats ?? []).map(
        (chat) => chat.id,
      );
      expect(ids).not.toContain('backend_outage_draft');
    },
    serverTestTimeout,
  );

  it('rejects a stale draft hash without consuming the draft', async () => {
    const { baseUrl } = await startTestServer();
    const draft = await createDraft(baseUrl, {
      message: 'Stale hash draft',
    });

    const submitted = await postJson(
      baseUrl,
      `/api/drafts/${draft.draft.id}/submit`,
      { expectedHash: '0'.repeat(64) },
    );
    const failure = submitted.body as FailureBody;

    expect(submitted.status).toBe(409);
    expect(failure.diagnostics[0]?.code).toBe('draft.stale_hash');
    expect(failure.currentHash).toBe(draft.contentHash);

    const intact = await getJson(baseUrl, `/api/drafts/${draft.draft.id}`);
    expect(intact.status).toBe(200);
  });

  it('answers 400 when the submit hash is missing', async () => {
    const { baseUrl } = await startTestServer();
    const draft = await createDraft(baseUrl, { message: 'No hash draft' });
    const submitted = await postJson(
      baseUrl,
      `/api/drafts/${draft.draft.id}/submit`,
      {},
    );
    expect(submitted.status).toBe(400);
    expect((submitted.body as FailureBody).diagnostics[0]?.code).toBe(
      'edit.hash_required',
    );
  });
});
