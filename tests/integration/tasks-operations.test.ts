import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseWorkspace } from '../../src/files/workspace.js';
import { rebuildIndex } from '../../src/index/build.js';
import { searchIndex } from '../../src/index/search.js';
import { findFileById } from '../../src/operations/lookup.js';
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

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
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

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-tasks-api-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function createEmptyWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-tasks-api-'));
  temporaryDirectories.push(root);
  await mkdir(path.join(root, 'projects', 'demo'), { recursive: true });
  await mkdir(path.join(root, 'tasks'), { recursive: true });
  await writeFile(path.join(root, 'workspace.yml'), 'version: 1\n');
  await writeFile(
    path.join(root, 'projects', 'demo', 'project.yml'),
    'id: project_demo\ntitle: Demo\n',
  );
  return root;
}

async function taskHash(root: string, taskId: string): Promise<string> {
  const parsed = await parseWorkspace(root);
  const file = findFileById(parsed.files, 'task', taskId);
  if (file === null || file.contentHash === null) {
    throw new Error(`task not found: ${taskId}`);
  }
  return file.contentHash;
}

function dateOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return todayDate(date);
}

function errorsOf(diagnostics: { severity: string }[]): { severity: string }[] {
  return diagnostics.filter((entry) => entry.severity === 'error');
}

describe('task index freshness', () => {
  it('makes a created task searchable through the refreshed index', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const created = await createTask(root, {
      text: 'Quench the solar kiln\nAnneal the mirrors before dusk.',
    });

    expect(created.success).toBe(true);
    if (created.data === null) throw new Error('create returned no data');
    const found = await searchIndex(root, 'quench');
    expect(found.diagnostics).toEqual([]);
    const hit = found.hits.find(
      (entry) => entry.objectId === 'task_quench_the_solar_kiln',
    );
    expect(hit?.type).toBe('task');
    expect(hit?.path).toBe(created.data.path);
  });

  it('keeps the index fresh after a task update', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const updated = await updateTask(root, {
      taskId: 'task_writers_room',
      body: 'Agenda now covers the quartzoid markers.',
      expectedHash: await taskHash(root, 'task_writers_room'),
    });

    expect(updated.success).toBe(true);
    const found = await searchIndex(root, 'quartzoid');
    expect(found.diagnostics).toEqual([]);
    expect(
      found.hits.some((entry) => entry.objectId === 'task_writers_room'),
    ).toBe(true);
  });
});

describe('task write conflicts', () => {
  it('rejects a stale hash without writing', async () => {
    const root = await createEmptyWorkspace();
    const created = await createTask(root, {
      text: 'Conflict probe\nOriginal body.',
    });
    if (created.data === null) throw new Error('create returned no data');
    const staleHash = created.data.contentHash;
    const file = path.join(root, ...created.data.path.split('/'));
    const original = await readFile(file, 'utf8');
    const manual = original.replace('Original body.', 'Changed by hand.');
    await writeFile(file, manual);

    const conflict = await updateTask(root, {
      taskId: created.data.id,
      title: 'Too late',
      expectedHash: staleHash,
    });
    expect(conflict.success).toBe(false);
    expect(conflict.changed).toBe(false);
    expect(conflict.files).toEqual([]);
    expect(
      conflict.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
    ).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(manual);

    const staleComplete = await completeTask(root, {
      taskId: created.data.id,
      expectedHash: staleHash,
    });
    expect(staleComplete.success).toBe(false);
    expect(staleComplete.changed).toBe(false);
    expect(
      staleComplete.diagnostics.some(
        (entry) => entry.code === 'edit.stale_hash',
      ),
    ).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(manual);

    const fresh = await updateTask(root, {
      taskId: created.data.id,
      title: 'Timely rename',
      expectedHash: await taskHash(root, created.data.id),
    });
    expect(fresh.success).toBe(true);
    expect(fresh.changed).toBe(true);
    const parsed = await parseWorkspace(root);
    expect(
      parsed.files.find((entry) => entry.kind === 'task')?.metadata?.title,
    ).toBe('Timely rename');
  });

  it('conflicts when the file changes while the edit is prepared', async () => {
    const root = await createEmptyWorkspace();
    const created = await createTask(root, { text: 'Race probe' });
    if (created.data === null) throw new Error('create returned no data');
    const file = path.join(root, ...created.data.path.split('/'));
    const original = await readFile(file, 'utf8');

    const raced = await updateTask(
      root,
      {
        taskId: created.data.id,
        title: 'Raced rename',
        expectedHash: created.data.contentHash,
      },
      {
        beforeConflictCheck: async () => {
          await writeFile(
            file,
            original.replace('title: Race probe', 'title: Race probe edited'),
          );
        },
      },
    );

    expect(raced.success).toBe(false);
    expect(raced.changed).toBe(false);
    expect(
      raced.diagnostics.some((entry) => entry.code === 'write.conflict'),
    ).toBe(true);
  });
});

describe('sample workspace task operations', () => {
  it('lists sample tasks with deadline ordering and status groups', async () => {
    const root = await copySampleWorkspace();

    const listed = await listTasks(root);

    expect(listed.success).toBe(true);
    if (listed.data === null) throw new Error('list returned no data');
    const data = listed.data;
    expect(data.groups.active.map((task) => task.id)).toEqual([
      'task_baseline_notes',
      'task_writers_room',
      'task_lab_refresh',
    ]);
    expect(data.groups.done.map((task) => task.id)).toEqual([
      'task_scaling_review',
    ]);
    const today = todayDate();
    const deadlines: [string, string][] = [
      ['task_baseline_notes', '2026-09-05'],
      ['task_writers_room', '2026-10-01'],
    ];
    expect(data.groups.overdue.map((task) => task.id)).toEqual(
      deadlines
        .filter(([, deadline]) => deadline.slice(0, 10) < today)
        .map(([id]) => id),
    );
    expect(data.groups.upcoming.map((task) => task.id)).toEqual(
      deadlines
        .filter(([, deadline]) => deadline.slice(0, 10) >= today)
        .map(([id]) => id),
    );
  });

  it('updates a sample task deadline and projects without touching other fields', async () => {
    const root = await copySampleWorkspace();
    const deadline = dateOffset(7);

    const updated = await updateTask(root, {
      taskId: 'task_baseline_notes',
      deadline,
      projects: ['project_evon', 'project_soap_bubbles'],
      expectedHash: await taskHash(root, 'task_baseline_notes'),
    });

    expect(updated.success).toBe(true);
    if (updated.data === null) throw new Error('update returned no data');
    expect(updated.data.deadline).toBe(deadline);
    expect(updated.data.projects).toEqual([
      'project_evon',
      'project_soap_bubbles',
    ]);
    expect(updated.data.title).toBe('Write the baseline notes');
    expect(updated.data.description).toContain(
      'Summarize the recorded optimizer baselines',
    );
    expect(updated.data.created).toBe('2026-08-24');
    expect(updated.data.updated).toBe(todayDate());
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('completes and reopens a sample task with fresh hashes', async () => {
    const root = await copySampleWorkspace();

    const done = await completeTask(root, {
      taskId: 'task_writers_room',
      expectedHash: await taskHash(root, 'task_writers_room'),
    });
    expect(done.success).toBe(true);
    if (done.data === null) throw new Error('complete returned no data');
    expect(done.data.status).toBe('done');
    expect(done.data.completed).toBe(todayDate());

    const reopened = await reopenTask(root, {
      taskId: 'task_writers_room',
      expectedHash: done.data.contentHash,
    });
    expect(reopened.success).toBe(true);
    if (reopened.data === null) throw new Error('reopen returned no data');
    expect(reopened.data.status).toBe('active');
    expect(reopened.data.completed).toBeUndefined();
    expect(reopened.data.deadline).toBe('2026-10-01');
    expect(reopened.data.projects).toEqual(['project_soap_bubbles']);
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('snoozes a sample task without a deadline by one day', async () => {
    const root = await copySampleWorkspace();

    const snoozed = await snoozeTask(root, {
      taskId: 'task_lab_refresh',
      expectedHash: await taskHash(root, 'task_lab_refresh'),
      duration: '1d',
    });

    expect(snoozed.success).toBe(true);
    if (snoozed.data === null) throw new Error('snooze returned no data');
    expect(snoozed.data.deadline).toBe(dateOffset(1));
    expect(snoozed.data.updated).toBe(todayDate());
    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('resolves a sample task into an attachment payload', async () => {
    const root = await copySampleWorkspace();

    const resolved = await resolveTaskAttachment(root, {
      taskId: 'task_writers_room',
    });

    expect(resolved.success).toBe(true);
    expect(resolved.data).toEqual({
      reference: { id: 'task_writers_room' },
      attachment: {
        id: 'task_writers_room',
        kind: 'task',
        path: 'tasks/writers-room.md',
        title: 'Draft the writers room agenda',
        label: 'Draft the writers room agenda',
        mime: 'text/markdown',
      },
    });
  });
});
