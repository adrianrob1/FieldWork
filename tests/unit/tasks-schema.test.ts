import { describe, expect, it } from 'vitest';

import {
  dateSchema,
  stableIdSchema,
  taskSchema,
  workspaceSchema,
} from '../../src/domain/schemas.js';

const validTask = {
  id: 'task_writers_room',
  title: 'Draft the writers room agenda',
  status: 'active',
  created: '2026-09-10',
  updated: '2026-09-11',
};

describe('taskSchema', () => {
  it('accepts a minimal active task', () => {
    const parsed = taskSchema.parse(validTask);

    expect(parsed.id).toBe('task_writers_room');
    expect(parsed.status).toBe('active');
    expect(parsed.completed).toBeUndefined();
  });

  it('accepts a done task with deadline, projects, and completion date', () => {
    const parsed = taskSchema.parse({
      ...validTask,
      status: 'done',
      deadline: '2026-09-08',
      projects: ['project_soap_bubbles', 'project_evon'],
      completed: '2026-09-09T18:00:00Z',
    });

    expect(parsed.status).toBe('done');
    expect(parsed.deadline).toBe('2026-09-08');
    expect(parsed.completed).toBe('2026-09-09T18:00:00Z');
  });

  it('retains unknown extension keys', () => {
    const parsed = taskSchema.parse({ ...validTask, 'x-task': 7 });

    expect(parsed['x-task']).toBe(7);
  });

  it('rejects a missing id, title, status, created, or updated', () => {
    for (const field of ['id', 'title', 'status', 'created', 'updated']) {
      const candidate: Record<string, unknown> = { ...validTask };
      delete candidate[field];
      expect(taskSchema.safeParse(candidate).success, field).toBe(false);
    }
  });

  it('rejects an invalid stable id', () => {
    expect(taskSchema.safeParse({ ...validTask, id: 'Task-One' }).success).toBe(
      false,
    );
    expect(stableIdSchema.safeParse('task_one').success).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(
      taskSchema.safeParse({ ...validTask, status: 'paused' }).success,
    ).toBe(false);
  });

  it('rejects completed set while the task is active', () => {
    const result = taskSchema.safeParse({
      ...validTask,
      completed: '2026-09-11',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path[0] === 'completed' && issue.code === 'custom',
        ),
      ).toBe(true);
    }
  });

  it('accepts completed for a done task', () => {
    expect(
      taskSchema.safeParse({
        ...validTask,
        status: 'done',
        updated: '2026-09-12',
        completed: '2026-09-12',
      }).success,
    ).toBe(true);
  });

  it('rejects invalid created, updated, deadline, and completed dates', () => {
    for (const field of ['created', 'updated', 'deadline', 'completed']) {
      expect(
        taskSchema.safeParse({
          ...validTask,
          status: 'done',
          [field]: 'yesterday',
        }).success,
        field,
      ).toBe(false);
    }
    expect(dateSchema.safeParse('2026-09-10').success).toBe(true);
    expect(dateSchema.safeParse('2026-9-10').success).toBe(false);
  });

  it('rejects a projects list that is not stable ids', () => {
    expect(
      taskSchema.safeParse({ ...validTask, projects: ['Project One'] }).success,
    ).toBe(false);
  });
});

describe('workspace paths schema', () => {
  it('accepts a tasks path override', () => {
    const parsed = workspaceSchema.parse({
      version: 1,
      paths: { tasks: 'work/tasks' },
    });

    expect(parsed.paths?.tasks).toBe('work/tasks');
  });
});
