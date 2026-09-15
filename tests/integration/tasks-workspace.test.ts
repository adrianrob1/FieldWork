import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { validateCommand } from '../../src/commands/validate.js';
import type { CommandContext } from '../../src/commands/output.js';
import {
  discoverWorkspaceFiles,
  parseWorkspace,
} from '../../src/files/workspace.js';
import { rebuildIndex } from '../../src/index/build.js';
import { openDatabase } from '../../src/index/database.js';
import { indexPath } from '../../src/index/paths.js';
import { searchIndex } from '../../src/index/search.js';
import {
  applyFrontmatterPatch,
  editableFieldPolicy,
  loadEditableFile,
} from '../../src/operations/frontmatterEdit.js';
import { workspaceView } from '../../src/server/api.js';
import {
  startWorkspaceWatcher,
  type WatchBatchResult,
  type WatcherHandle,
  type WatcherOptions,
} from '../../src/watch/watcher.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: WatcherHandle[] = [];
const watcherTestTimeout = 20_000;

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

async function createWorkspace(settings = 'version: 1\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-tasks-'));
  temporaryDirectories.push(root);
  await write(root, 'workspace.yml', settings);
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

function taskSource(
  overrides: Record<string, string> = {},
  projects: string[] = [],
): string {
  const frontmatter: Record<string, string> = {
    id: 'task_demo',
    title: 'Demo task',
    status: 'active',
    created: '2026-09-10',
    updated: '2026-09-11',
    ...overrides,
  };
  const lines = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${value}`);
  }
  if (projects.length > 0) {
    lines.push('projects:');
    for (const project of projects) lines.push(`  - ${project}`);
  }
  lines.push('---', '', 'A sunstone marker task body.', '');
  return lines.join('\n');
}

function countKinds(files: { kind: string }[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of files) result[file.kind] = (result[file.kind] ?? 0) + 1;
  return result;
}

describe('task discovery and validation', () => {
  it('parses the sample workspace tasks without diagnostics', async () => {
    const result = await parseWorkspace(sampleWorkspace);

    expect(
      result.diagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
    expect(countKinds(result.files)).toEqual({
      workspace: 1,
      project: 3,
      chat: 3,
      resource: 2,
      summary: 5,
      task: 4,
    });
    const tasks = result.files.filter(({ kind }) => kind === 'task');
    expect(tasks).toHaveLength(4);
    expect(tasks.every(({ area }) => area === 'tasks')).toBe(true);
    expect(tasks.map((task) => task.metadata?.id).sort()).toEqual([
      'task_baseline_notes',
      'task_lab_refresh',
      'task_scaling_review',
      'task_writers_room',
    ]);
  });

  it('classifies Markdown under the tasks area as task files', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());
    await write(root, 'tasks/notes.txt', 'not markdown\n');

    const discovery = await discoverWorkspaceFiles(root);
    const task = discovery.files.find(({ kind }) => kind === 'task');

    expect(task?.area).toBe('tasks');
    expect(task?.file).toBe(path.join(root, 'tasks', 'one.md'));
    expect(discovery.files.some(({ file }) => file.endsWith('notes.txt'))).toBe(
      false,
    );

    const parsed = await parseWorkspace(root);
    expect(parsed.files.find(({ kind }) => kind === 'task')?.metadata?.id).toBe(
      'task_demo',
    );
  });

  it('honors a workspace.yml tasks path override', async () => {
    const root = await createWorkspace(
      'version: 1\npaths:\n  tasks: work/tasks\n',
    );
    await write(root, 'work/tasks/one.md', taskSource());

    const result = await parseWorkspace(root);

    const task = result.files.find(({ kind }) => kind === 'task');
    expect(task?.file).toBe(path.join(root, 'work', 'tasks', 'one.md'));
    expect(task?.area).toBe('tasks');
  });

  it('reports duplicate task ids as id.duplicate diagnostics', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());
    await write(
      root,
      'tasks/two.md',
      taskSource({ id: 'task_demo', title: 'Second task' }),
    );

    const result = await parseWorkspace(root);

    const duplicates = result.diagnostics.filter(
      ({ code }) => code === 'id.duplicate',
    );
    expect(duplicates).toHaveLength(2);
    expect(duplicates.every(({ fieldPath }) => fieldPath === 'id')).toBe(true);
  });

  it('reports missing project references on a task', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'tasks/one.md',
      taskSource({ id: 'task_orphan' }, ['project_nowhere']),
    );

    const result = await parseWorkspace(root);

    const missing = result.diagnostics.find(
      ({ code }) => code === 'reference.missing',
    );
    expect(missing?.fieldPath).toBe('projects.0');
    expect(missing?.message).toContain('project_nowhere');
  });

  it('rejects a completed date while a task is active', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource({ completed: '2026-09-11' }));

    const result = await parseWorkspace(root);

    expect(
      result.diagnostics.some(
        ({ code, fieldPath }) =>
          code === 'schema.custom' && fieldPath === 'completed',
      ),
    ).toBe(true);
  });

  it('accepts a completed date on a done task', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'tasks/one.md',
      taskSource({ status: 'done', completed: '2026-09-12' }),
    );

    const result = await parseWorkspace(root);

    expect(
      result.diagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
  });
});

describe('task counts', () => {
  it('includes tasks in the workspace view counts', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());
    await write(root, 'tasks/two.md', taskSource({ id: 'task_two' }));

    const view = await workspaceView(root);

    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.data.counts.task).toBe(2);
      expect(view.data.counts.project).toBe(1);
    }
  });

  it('includes tasks in the validate command output', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());
    const lines: string[] = [];
    const context: CommandContext = {
      workspace: root,
      json: true,
      io: {
        out: (text) => {
          lines.push(text);
        },
        err: () => undefined,
      },
    };

    const exitCode = await validateCommand(context);

    expect(exitCode).toBe(0);
    const envelope = JSON.parse(lines.join('')) as {
      data: { files: Record<string, number> };
    };
    expect(envelope.data.files.task).toBe(1);
  });
});

describe('task indexing and search', () => {
  it('indexes task objects, references, and routing metadata', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'tasks/one.md',
      taskSource({ deadline: '2026-10-01' }, ['project_demo']),
    );

    const result = await rebuildIndex(root);

    expect(result.diagnostics).toEqual([]);
    const database = openDatabase(indexPath(root), { readonly: true });
    try {
      const task = database.get<{
        id: string;
        type: string;
        title: string;
        metadata: string;
      }>(
        "SELECT id, type, title, metadata FROM objects WHERE id = 'task_demo'",
      );
      expect(task?.type).toBe('task');
      expect(task?.title).toBe('Demo task');
      const metadata = JSON.parse(task?.metadata ?? '{}') as Record<
        string,
        unknown
      >;
      expect(metadata).toMatchObject({
        status: 'active',
        projects: ['project_demo'],
        deadline: '2026-10-01',
        created: '2026-09-10',
        updated: '2026-09-11',
      });
      const reference = database.get<{
        source: string;
        target: string;
        relation: string;
      }>(
        'SELECT source, target, relation FROM "references" WHERE source = \'task_demo\'',
      );
      expect(reference).toEqual({
        source: 'task_demo',
        target: 'project_demo',
        relation: 'project',
      });
      const document = database.get<{ object_id: string }>(
        "SELECT object_id FROM documents_fts WHERE object_id = 'task_demo'",
      );
      expect(document?.object_id).toBe('task_demo');
    } finally {
      database.close();
    }
  });

  it('returns a task hit with type task from lexical search', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());
    await rebuildIndex(root);

    const found = await searchIndex(root, 'sunstone');

    expect(found.diagnostics).toEqual([]);
    expect(found.hits).toHaveLength(1);
    expect(found.hits[0]).toMatchObject({
      objectId: 'task_demo',
      type: 'task',
      path: 'tasks/one.md',
    });
  });
});

describe('task watching', () => {
  async function startTestWatcher(
    root: string,
  ): Promise<{ handle: WatcherHandle; batches: WatchBatchResult[] }> {
    const batches: WatchBatchResult[] = [];
    const options: WatcherOptions = {
      debounceMs: 25,
      awaitWriteFinish: { stabilityThresholdMs: 20, pollIntervalMs: 5 },
      polling: { usePolling: true, intervalMs: 20 },
      onBatch: (batch) => {
        batches.push(batch);
      },
    };
    const handle = await startWorkspaceWatcher(root, options);
    runningHandles.push(handle);
    return { handle, batches };
  }

  async function waitForBatch(
    batches: WatchBatchResult[],
    description: string,
    predicate: (batch: WatchBatchResult) => boolean,
  ): Promise<WatchBatchResult> {
    await vi.waitFor(
      () => {
        if (!batches.some(predicate))
          throw new Error(`not yet satisfied: ${description}`);
      },
      { timeout: 10_000, interval: 10 },
    );
    const found = batches.find(predicate);
    if (found === undefined)
      throw new Error(`batch disappeared: ${description}`);
    return found;
  }

  it(
    'applies add, change, and unlink of a task file',
    async () => {
      const root = await createWorkspace();
      await write(root, 'tasks/one.md', taskSource());
      const { handle, batches } = await startTestWatcher(root);

      await write(
        root,
        'tasks/two.md',
        taskSource({ id: 'task_added', title: 'Added task' }),
      );
      const added = await waitForBatch(
        batches,
        'task added batch',
        (entry) => entry.applied && entry.paths.added.includes('tasks/two.md'),
      );
      expect(added.diagnostics).toEqual([]);
      expect(
        (await searchIndex(root, 'sunstone')).hits.map((hit) => hit.objectId),
      ).toContain('task_added');

      await write(root, 'tasks/one.md', taskSource({ title: 'Renamed task' }));
      const changed = await waitForBatch(
        batches,
        'task changed batch',
        (entry) =>
          entry.applied && entry.paths.changed.includes('tasks/one.md'),
      );
      expect(changed.diagnostics).toEqual([]);
      const database = openDatabase(indexPath(root), { readonly: true });
      expect(
        database.get<{ title: string }>(
          "SELECT title FROM objects WHERE id = 'task_demo'",
        )?.title,
      ).toBe('Renamed task');
      database.close();

      await rm(path.join(root, 'tasks', 'two.md'));
      await waitForBatch(
        batches,
        'task deleted batch',
        (entry) =>
          entry.applied && entry.paths.deleted.includes('tasks/two.md'),
      );
      const afterDelete = openDatabase(indexPath(root), { readonly: true });
      expect(
        afterDelete.get<{ id: string }>(
          "SELECT id FROM objects WHERE id = 'task_added'",
        ),
      ).toBeUndefined();
      afterDelete.close();

      await handle.stop();
    },
    watcherTestTimeout,
  );
});

describe('task safe editing', () => {
  it('loads a task with the task field policy', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());

    const outcome = await loadEditableFile(root, 'tasks/one.md');

    expect(outcome.status).toBe('ok');
    expect(outcome.view?.kind).toBe('task');
    expect(outcome.view?.editableFields).toEqual(editableFieldPolicy.task);
    expect(outcome.view?.unknownKeys).toEqual([]);
  });

  it('applies a frontmatter patch to editable task fields', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());

    const outcome = await applyFrontmatterPatch(root, {
      path: 'tasks/one.md',
      changes: {
        title: 'Renamed task',
        status: 'done',
        deadline: '2026-10-01',
        updated: '2026-09-12',
        completed: '2026-09-12',
      },
      expectedHash: null,
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(true);
    const view = await loadEditableFile(root, 'tasks/one.md');
    expect(view.view?.metadata.status).toBe('done');
    expect(view.view?.metadata.completed).toBe('2026-09-12');
  });

  it('refuses changes to immutable task fields', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());

    const outcome = await applyFrontmatterPatch(root, {
      path: 'tasks/one.md',
      changes: { id: 'task_other', created: '2020-01-01' },
      expectedHash: null,
    });

    expect(outcome.status).toBe('invalid');
    expect(
      outcome.diagnostics
        .filter((entry) => entry.code === 'edit.field_not_editable')
        .map((entry) => entry.fieldPath)
        .sort(),
    ).toEqual(['created', 'id']);
  });

  it('rejects a patch that would leave the task schema invalid', async () => {
    const root = await createWorkspace();
    await write(root, 'tasks/one.md', taskSource());

    const outcome = await applyFrontmatterPatch(root, {
      path: 'tasks/one.md',
      changes: { status: 'paused' },
      expectedHash: null,
    });

    expect(outcome.status).toBe('invalid');
    expect(
      outcome.diagnostics.some(
        (entry) => entry.severity === 'error' && entry.fieldPath === 'status',
      ),
    ).toBe(true);
  });
});
