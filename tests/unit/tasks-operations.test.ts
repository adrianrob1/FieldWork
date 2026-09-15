import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseWorkspace } from '../../src/files/workspace.js';
import { findFileById } from '../../src/operations/lookup.js';
import type { OperationResult } from '../../src/operations/result.js';
import { todayDate } from '../../src/operations/start.js';
import {
  completeTask,
  createTask,
  listTasks,
  reopenTask,
  resolveTaskAttachment,
  snoozeTask,
  updateTask,
} from '../../src/operations/tasks.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
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

async function write(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-task-ops-'));
  temporaryDirectories.push(root);
  await write(root, 'workspace.yml', 'version: 1\n');
  await Promise.all(
    ['projects', 'chats', 'topics', 'tasks', 'inbox', 'external'].map((name) =>
      mkdir(path.join(root, name), { recursive: true }),
    ),
  );
  await write(
    root,
    'projects/demo/project.yml',
    'id: project_demo\ntitle: Demo\n',
  );
  return root;
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return todayDate(date);
}

function taskMarkdown(
  overrides: Record<string, string | null> = {},
  projects: string[] = [],
  body = 'A probe body for the task.',
): string {
  const fields: Record<string, string | null> = {
    id: 'task_probe',
    title: 'Probe task',
    status: 'active',
    created: '2026-09-01',
    updated: '2026-09-02',
    ...overrides,
  };
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null) lines.push(`${key}: ${value}`);
  }
  if (projects.length > 0) {
    lines.push('projects:');
    for (const project of projects) lines.push(`  - ${project}`);
  }
  lines.push('---', '', body, '');
  return lines.join('\n');
}

async function writeTask(
  root: string,
  name: string,
  overrides: Record<string, string | null> = {},
  projects: string[] = [],
): Promise<void> {
  await write(root, `tasks/${name}.md`, taskMarkdown(overrides, projects));
}

async function taskHash(root: string, taskId: string): Promise<string> {
  const parsed = await parseWorkspace(root);
  const file = findFileById(parsed.files, 'task', taskId);
  if (file === null || file.contentHash === null) {
    throw new Error(`task not found: ${taskId}`);
  }
  return file.contentHash;
}

function requireData<T>(result: OperationResult<T>): T {
  expect(result.success).toBe(true);
  if (result.data === null) throw new Error('operation returned no data');
  return result.data;
}

function errorsOf(diagnostics: { severity: string }[]): { severity: string }[] {
  return diagnostics.filter((entry) => entry.severity === 'error');
}

describe('createTask quick-add', () => {
  it('splits the first line into the title and the rest into the description', async () => {
    const root = await createWorkspace();

    const created = await createTask(root, {
      text: 'Ship the opal checklist\n\nCheck the facet count\nbefore Friday.',
    });

    const view = requireData(created);
    expect(created.changed).toBe(true);
    expect(view.title).toBe('Ship the opal checklist');
    expect(view.description).toBe('Check the facet count\nbefore Friday.');
    expect(view.id).toBe('task_ship_the_opal_checklist');
    expect(view.status).toBe('active');
    expect(view.projects).toEqual([]);
    expect(view.deadline).toBeUndefined();
    expect(view.created).toBe(todayDate());
    expect(view.updated).toBe(todayDate());
    expect(view.path).toBe(`tasks/${todayDate()}-ship-the-opal-checklist.md`);
    expect(view.overdue).toBe(false);
    expect(view.upcoming).toBe(false);
    expect(view.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
    expect(parsed.files.filter((file) => file.kind === 'task')).toHaveLength(1);
  });

  it('keeps a single line as a title-only task', async () => {
    const root = await createWorkspace();

    const created = await createTask(root, { text: 'One line task' });

    const view = requireData(created);
    expect(view.title).toBe('One line task');
    expect(view.description).toBe('');
    const file = path.join(root, ...view.path.split('/'));
    const contents = await readFile(file, 'utf8');
    expect(contents.endsWith('---\n')).toBe(true);
  });

  it('rejects whitespace-only quick-add text', async () => {
    const root = await createWorkspace();

    const created = await createTask(root, { text: '   \n\n  ' });

    expect(created.success).toBe(false);
    expect(created.changed).toBe(false);
    expect(created.files).toEqual([]);
    expect(created.diagnostics[0]?.code).toBe('task.invalid_title');
    const parsed = await parseWorkspace(root);
    expect(parsed.files.filter((file) => file.kind === 'task')).toEqual([]);
  });

  it('derives ids and file names with numeric suffixes on repeats', async () => {
    const root = await createWorkspace();

    const first = await createTask(root, { text: 'Holder task' });
    const second = await createTask(root, { text: 'Holder task' });
    const third = await createTask(root, { text: 'Holder task' });

    expect(requireData(first).id).toBe('task_holder_task');
    expect(requireData(first).path).toBe(`tasks/${todayDate()}-holder-task.md`);
    expect(requireData(second).id).toBe('task_holder_task_2');
    expect(requireData(second).path).toBe(
      `tasks/${todayDate()}-holder-task-2.md`,
    );
    expect(requireData(third).id).toBe('task_holder_task_3');
    expect(requireData(third).path).toBe(
      `tasks/${todayDate()}-holder-task-3.md`,
    );
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('dedupes ids against every declared object id', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'inbox/zebra.md',
      [
        '---',
        'id: task_zebra',
        'title: Zebra notes',
        'kind: note',
        '---',
        '',
        'Zebra body.',
        '',
      ].join('\n'),
    );

    const created = await createTask(root, { text: 'Zebra' });

    const view = requireData(created);
    expect(view.id).toBe('task_zebra_2');
    expect(view.path).toBe(`tasks/${todayDate()}-zebra.md`);
  });

  it('creates a task with projects and a deadline', async () => {
    const root = await createWorkspace();
    const deadline = dateOffset(2);

    const created = await createTask(root, {
      text: 'Review the opal cut',
      projects: ['project_demo'],
      deadline,
    });

    const view = requireData(created);
    expect(view.projects).toEqual(['project_demo']);
    expect(view.deadline).toBe(deadline);
    expect(view.upcoming).toBe(true);
    expect(view.overdue).toBe(false);
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('rejects a missing project reference', async () => {
    const root = await createWorkspace();

    const created = await createTask(root, {
      text: 'Orphan task',
      projects: ['project_nowhere'],
    });

    expect(created.success).toBe(false);
    expect(created.changed).toBe(false);
    expect(created.diagnostics[0]?.code).toBe('project.missing');
    expect(created.diagnostics[0]?.message).toContain('project_nowhere');
  });

  it('rejects an invalid deadline', async () => {
    const root = await createWorkspace();

    const created = await createTask(root, {
      text: 'Dated task',
      deadline: 'tomorrow',
    });

    expect(created.success).toBe(false);
    expect(created.diagnostics[0]?.code).toBe('task.invalid_deadline');
  });
});

describe('updateTask', () => {
  it('updates title, body, projects, and deadline while preserving other fields', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', {
      deadline: dateOffset(5),
      updated: '2020-01-01',
    });
    const deadline = dateOffset(1);

    const updated = await updateTask(root, {
      taskId: 'task_probe',
      title: 'Renamed probe',
      body: 'A replaced body.',
      projects: ['project_demo'],
      deadline,
      expectedHash: await taskHash(root, 'task_probe'),
    });

    const view = requireData(updated);
    expect(updated.changed).toBe(true);
    expect(updated.files).toHaveLength(1);
    expect(view.title).toBe('Renamed probe');
    expect(view.description).toBe('A replaced body.');
    expect(view.projects).toEqual(['project_demo']);
    expect(view.deadline).toBe(deadline);
    expect(view.created).toBe('2026-09-01');
    expect(view.updated).toBe(todayDate());
    expect(view.status).toBe('active');
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('leaves unspecified fields untouched and is a no-op without fields', async () => {
    const root = await createWorkspace();
    await writeTask(
      root,
      'probe',
      { deadline: dateOffset(3), updated: '2020-01-01' },
      ['project_demo'],
    );

    const titleOnly = await updateTask(root, {
      taskId: 'task_probe',
      title: 'Only the title',
      expectedHash: await taskHash(root, 'task_probe'),
    });

    const view = requireData(titleOnly);
    expect(view.description).toBe('A probe body for the task.');
    expect(view.deadline).toBe(dateOffset(3));
    expect(view.projects).toEqual(['project_demo']);
    expect(view.created).toBe('2026-09-01');

    const sameTitle = await updateTask(root, {
      taskId: 'task_probe',
      title: 'Only the title',
      expectedHash: view.contentHash,
    });

    expect(sameTitle.success).toBe(true);
    expect(sameTitle.changed).toBe(false);
    expect(requireData(sameTitle).contentHash).toBe(view.contentHash);

    const untouched = await updateTask(root, {
      taskId: 'task_probe',
      expectedHash: view.contentHash,
    });

    expect(untouched.success).toBe(true);
    expect(untouched.changed).toBe(false);
    expect(untouched.files).toEqual([]);
    expect(requireData(untouched).contentHash).toBe(view.contentHash);
  });

  it('rejects an empty title, a bad deadline, a missing project, and a missing task', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe');
    const expectedHash = await taskHash(root, 'task_probe');

    const emptyTitle = await updateTask(root, {
      taskId: 'task_probe',
      title: '   ',
      expectedHash,
    });
    expect(emptyTitle.success).toBe(false);
    expect(emptyTitle.diagnostics[0]?.code).toBe('task.invalid_title');

    const badDeadline = await updateTask(root, {
      taskId: 'task_probe',
      deadline: 'next week',
      expectedHash,
    });
    expect(badDeadline.success).toBe(false);
    expect(badDeadline.diagnostics[0]?.code).toBe('task.invalid_deadline');

    const missingProject = await updateTask(root, {
      taskId: 'task_probe',
      projects: ['project_ghost'],
      expectedHash,
    });
    expect(missingProject.success).toBe(false);
    expect(missingProject.diagnostics[0]?.code).toBe('project.missing');

    const missingTask = await updateTask(root, {
      taskId: 'task_nowhere',
      title: 'Nope',
      expectedHash,
    });
    expect(missingTask.success).toBe(false);
    expect(missingTask.diagnostics[0]?.code).toBe('task.missing');
    const parsed = await parseWorkspace(root);
    expect(
      parsed.files.find((file) => file.kind === 'task')?.metadata?.title,
    ).toBe('Probe task');
  });
});

describe('completeTask and reopenTask', () => {
  it('marks a task done with a completed date and bumps updated', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', { updated: '2020-01-01' });

    const done = await completeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
    });

    const view = requireData(done);
    expect(done.changed).toBe(true);
    expect(view.status).toBe('done');
    expect(view.completed).toBe(todayDate());
    expect(view.updated).toBe(todayDate());
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('is an idempotent no-op for a task that is already done', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe');

    const first = await completeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
    });
    const firstView = requireData(first);

    const second = await completeTask(root, {
      taskId: 'task_probe',
      expectedHash: firstView.contentHash,
    });

    expect(second.success).toBe(true);
    expect(second.changed).toBe(false);
    expect(requireData(second).completed).toBe(firstView.completed);
  });

  it('reopens a done task, clears completed, and stays schema valid', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', {
      status: 'done',
      completed: '2026-09-02',
      updated: '2026-09-02',
    });

    const reopened = await reopenTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
    });

    const view = requireData(reopened);
    expect(view.status).toBe('active');
    expect(view.completed).toBeUndefined();
    expect(view.updated).toBe(todayDate());
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('is an idempotent no-op for a task that is already active', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe');

    const reopened = await reopenTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
    });

    expect(reopened.success).toBe(true);
    expect(reopened.changed).toBe(false);
  });

  it('round-trips complete and reopen without schema errors', async () => {
    const root = await createWorkspace();
    const created = await createTask(root, { text: 'Round trip task' });
    const createdView = requireData(created);

    const done = await completeTask(root, {
      taskId: createdView.id,
      expectedHash: createdView.contentHash,
    });
    const doneView = requireData(done);
    expect(doneView.status).toBe('done');
    expect(doneView.completed).toBe(todayDate());

    const reopened = await reopenTask(root, {
      taskId: doneView.id,
      expectedHash: doneView.contentHash,
    });
    const reopenedView = requireData(reopened);
    expect(reopenedView.status).toBe('active');
    expect(reopenedView.completed).toBeUndefined();

    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });
});

describe('snoozeTask', () => {
  it('snoozes by a duration from today', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', { updated: '2020-01-01' });

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      duration: '2d',
      at: new Date(2026, 8, 12, 10, 30),
    });

    const view = requireData(snoozed);
    expect(snoozed.changed).toBe(true);
    expect(view.deadline).toBe('2026-09-14');
    expect(view.updated).toBe('2026-09-12');
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('snoozes from the current deadline when it is later than today', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', {
      deadline: '2026-10-01',
      updated: '2020-01-01',
    });

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      duration: '2d',
      at: new Date(2026, 8, 12),
    });

    expect(requireData(snoozed).deadline).toBe('2026-10-03');
  });

  it('snoozes an overdue task to today or later', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', {
      deadline: '2020-01-01',
      updated: '2020-01-01',
    });

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      duration: '30m',
      at: new Date(2026, 8, 12, 23, 45),
    });

    expect(requireData(snoozed).deadline).toBe('2026-09-12');
  });

  it('accepts combined durations', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', { updated: '2020-01-01' });

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      duration: '1d30m',
      at: new Date(2026, 8, 12),
    });

    expect(requireData(snoozed).deadline).toBe('2026-09-13');
  });

  it('accepts an exact deadline that passes the date schema', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', { updated: '2020-01-01' });
    const expectedHash = await taskHash(root, 'task_probe');

    const stamped = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash,
      deadline: '2026-10-01T17:00:00Z',
    });
    expect(requireData(stamped).deadline).toBe('2026-10-01T17:00:00Z');

    const reopened = await reopenTask(root, {
      taskId: 'task_probe',
      expectedHash: requireData(stamped).contentHash,
    });
    const plain = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: requireData(reopened).contentHash,
      deadline: '2026-12-24',
    });
    expect(requireData(plain).deadline).toBe('2026-12-24');
  });

  it('rejects an exact deadline that fails the date schema', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe');

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      deadline: 'soon',
    });

    expect(snoozed.success).toBe(false);
    expect(snoozed.diagnostics[0]?.code).toBe('task.invalid_deadline');
  });

  it('rejects a snooze on a done task', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe', {
      status: 'done',
      completed: '2026-09-02',
      updated: '2026-09-02',
    });

    const snoozed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash: await taskHash(root, 'task_probe'),
      duration: '1h',
    });

    expect(snoozed.success).toBe(false);
    expect(snoozed.changed).toBe(false);
    expect(snoozed.diagnostics[0]?.code).toBe('task.invalid_status');
  });

  it('rejects snooze input that is not exactly one of duration or deadline', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'probe');
    const expectedHash = await taskHash(root, 'task_probe');

    const both = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash,
      duration: '1h',
      deadline: '2026-10-01',
    });
    expect(both.success).toBe(false);
    expect(both.diagnostics[0]?.code).toBe('task.invalid_snooze');

    const neither = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash,
    });
    expect(neither.success).toBe(false);
    expect(neither.diagnostics[0]?.code).toBe('task.invalid_snooze');

    const malformed = await snoozeTask(root, {
      taskId: 'task_probe',
      expectedHash,
      duration: '30x',
    });
    expect(malformed.success).toBe(false);
    expect(malformed.diagnostics[0]?.code).toBe('task.invalid_snooze');
  });
});

describe('listTasks grouping and ordering', () => {
  it('groups tasks into active, overdue, upcoming, and done', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'overdue', {
      id: 'task_overdue',
      title: 'Overdue',
      deadline: dateOffset(-1),
      updated: dateOffset(-1),
    });
    await writeTask(root, 'today', {
      id: 'task_today',
      title: 'Today',
      deadline: todayDate(),
      updated: dateOffset(-1),
    });
    await writeTask(root, 'soon', {
      id: 'task_soon',
      title: 'Soon',
      deadline: dateOffset(3),
      updated: dateOffset(-1),
    });
    await writeTask(root, 'undated', {
      id: 'task_undated',
      title: 'Undated',
      updated: dateOffset(-1),
    });
    await writeTask(root, 'done-recent', {
      id: 'task_done_recent',
      title: 'Done recent',
      status: 'done',
      completed: todayDate(),
      updated: todayDate(),
    });
    await writeTask(root, 'done-older', {
      id: 'task_done_older',
      title: 'Done older',
      status: 'done',
      completed: dateOffset(-4),
      updated: dateOffset(-4),
    });

    const listed = await listTasks(root);
    const data = requireData(listed);

    expect(data.tasks.map((task) => task.id)).toEqual([
      'task_overdue',
      'task_today',
      'task_soon',
      'task_undated',
      'task_done_recent',
      'task_done_older',
    ]);
    expect(data.groups.active.map((task) => task.id)).toEqual([
      'task_overdue',
      'task_today',
      'task_soon',
      'task_undated',
    ]);
    expect(data.groups.overdue.map((task) => task.id)).toEqual([
      'task_overdue',
    ]);
    expect(data.groups.upcoming.map((task) => task.id)).toEqual([
      'task_today',
      'task_soon',
    ]);
    expect(data.groups.done.map((task) => task.id)).toEqual([
      'task_done_recent',
      'task_done_older',
    ]);
    expect(data.groups.overdue.every((task) => task.overdue)).toBe(true);
    expect(data.groups.upcoming.every((task) => task.upcoming)).toBe(true);
    expect(data.tasks.every((task) => task.contentHash.length === 64)).toBe(
      true,
    );
  });

  it('orders dated actives first, then undated actives and done tasks by recency', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'undated-old', {
      id: 'task_undated_old',
      updated: dateOffset(-9),
    });
    await writeTask(root, 'undated-new', {
      id: 'task_undated_new',
      updated: dateOffset(-1),
    });
    await writeTask(root, 'dated', {
      id: 'task_dated',
      deadline: dateOffset(2),
      updated: dateOffset(-5),
    });
    await writeTask(root, 'done-plain', {
      id: 'task_done_plain',
      status: 'done',
      updated: dateOffset(-2),
    });
    await writeTask(root, 'done-stamped', {
      id: 'task_done_stamped',
      status: 'done',
      completed: dateOffset(-3),
      updated: dateOffset(-10),
    });

    const listed = await listTasks(root);
    const data = requireData(listed);

    expect(data.tasks.map((task) => task.id)).toEqual([
      'task_dated',
      'task_undated_new',
      'task_undated_old',
      'task_done_plain',
      'task_done_stamped',
    ]);
  });

  it('reports task files that do not produce a view as diagnostics', async () => {
    const root = await createWorkspace();
    await writeTask(root, 'broken', {
      id: 'task_broken',
      title: 'Broken',
      status: 'paused',
    });
    await writeTask(root, 'fine', { id: 'task_fine', title: 'Fine' });

    const listed = await listTasks(root);

    expect(listed.success).toBe(true);
    expect(requireData(listed).tasks.map((task) => task.id)).toEqual([
      'task_fine',
    ]);
    expect(
      listed.diagnostics.some(
        (entry) =>
          entry.severity === 'error' && entry.code.startsWith('schema.'),
      ),
    ).toBe(true);
  });
});

describe('resolveTaskAttachment', () => {
  it('resolves a task into an attachment payload with a path-free label', async () => {
    const root = await createWorkspace();
    const created = await createTask(root, {
      text: 'Attach me\nWith a body.',
    });
    const createdView = requireData(created);

    const resolved = await resolveTaskAttachment(root, {
      taskId: createdView.id,
    });

    const data = requireData(resolved);
    expect(data.reference).toEqual({ id: createdView.id });
    expect(data.attachment).toEqual({
      id: createdView.id,
      kind: 'task',
      path: createdView.path,
      title: 'Attach me',
      label: 'Attach me',
      mime: 'text/markdown',
    });
    expect(data.attachment.label.includes(data.attachment.path)).toBe(false);
    expect(data.attachment.label.includes('tasks/')).toBe(false);
  });

  it('fails with task.missing for an unknown task', async () => {
    const root = await createWorkspace();

    const resolved = await resolveTaskAttachment(root, {
      taskId: 'task_nowhere',
    });

    expect(resolved.success).toBe(false);
    expect(resolved.diagnostics[0]?.code).toBe('task.missing');
    expect(resolved.diagnostics[0]?.message).toContain('task_nowhere');
  });
});
