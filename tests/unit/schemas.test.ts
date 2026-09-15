import { describe, expect, it } from 'vitest';

import {
  chatSchema,
  linkSchema,
  projectSchema,
  resourceSchema,
  summarySchema,
  taskSchema,
  workspaceSchema,
} from '../../src/domain/schemas.js';

describe('version 1 schemas', () => {
  it('accepts each Phase 0 object and retains extension fields', () => {
    const values = [
      workspaceSchema.parse({ version: 1, 'x-setting': true }),
      projectSchema.parse({ id: 'project_one', title: 'One', 'x-project': 1 }),
      chatSchema.parse({ id: 'chat_one', title: 'One', created: '2026-09-02' }),
      resourceSchema.parse({ id: 'resource_one', title: 'One', kind: 'note' }),
      summarySchema.parse({ id: 'summary_one', title: 'One', kind: 'root' }),
      linkSchema.parse({
        id: 'link_one',
        from: 'project_one',
        to: 'resource_one',
        relation: 'uses',
      }),
      taskSchema.parse({
        id: 'task_one',
        title: 'One',
        status: 'done',
        created: '2026-09-02',
        updated: '2026-09-03',
        completed: '2026-09-03',
        'x-task': 'kept',
      }),
    ];

    expect(values[0]['x-setting']).toBe(true);
    expect(values[1]['x-project']).toBe(1);
    expect(values[6]['x-task']).toBe('kept');
  });

  it('rejects invalid IDs, dates, and conditional summary ownership', () => {
    expect(
      chatSchema.safeParse({ id: 'Bad-ID', title: 'One', created: 'yesterday' })
        .success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({ id: 'summary_one', title: 'One', kind: 'area' })
        .success,
    ).toBe(false);
    expect(
      summarySchema.safeParse({
        id: 'summary_one',
        title: 'One',
        kind: 'root',
        project: 'project_one',
      }).success,
    ).toBe(false);
  });

  it('rejects invalid task status, dates, and completion before done', () => {
    expect(
      taskSchema.safeParse({
        id: 'task_one',
        title: 'One',
        status: 'paused',
        created: '2026-09-02',
        updated: '2026-09-02',
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        id: 'task_one',
        title: 'One',
        status: 'active',
        created: 'yesterday',
        updated: '2026-09-02',
      }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({
        id: 'task_one',
        title: 'One',
        status: 'active',
        created: '2026-09-02',
        updated: '2026-09-02',
        completed: '2026-09-02',
      }).success,
    ).toBe(false);
  });
});
