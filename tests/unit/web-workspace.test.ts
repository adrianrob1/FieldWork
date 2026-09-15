import { describe, expect, it } from 'vitest';

import type { TaskView } from '../../web/src/pages/tasksModel.js';
import type { ChatListEntry } from '../../web/src/shared/projects/catalog.js';
import {
  activityEntriesOf,
  activityKindLabel,
  activityTagClass,
  activityTarget,
  formatClock,
  humanizeBytes,
  priorityTasks,
  recentChats,
  relativeTime,
  toWorkspaceSnapshot,
  topicLabel,
} from '../../web/src/pages/workspaceModel.js';

const now = new Date(2026, 8, 10, 10, 0, 0);
const sameDay = new Date(2026, 8, 10, 9, 30, 15).toISOString();
const earlierSameYear = new Date(2026, 8, 6, 12, 0, 0).toISOString();
const earlierYear = new Date(2025, 7, 27, 12, 0, 0).toISOString();

describe('toWorkspaceSnapshot', () => {
  it('normalizes the GET response into the local snapshot shape', () => {
    const snapshot = toWorkspaceSnapshot({
      root: 'C:/workspace',
      title: 'Optimizer research',
      counts: { workspace: 1, project: 3, chat: 12, task: 4, resource: 6 },
      validation: { errors: 0, warnings: 0 },
      index: {
        path: 'C:/workspace/.workspace/index.sqlite',
        modifiedAt: sameDay,
        counts: { files: 18, documents: 17, references: 20 },
      },
      storage: { indexBytes: 61440 },
      recentActivity: [
        {
          kind: 'chat',
          id: 'chat_lab',
          title: 'Lab meeting agenda',
          path: 'chats/lab.md',
          modifiedAt: sameDay,
        },
      ],
      diagnostics: [
        {
          code: 'schema.mapping',
          severity: 'warning',
          file: 'workspace.yml',
          fieldPath: null,
          message: 'Minor issue.',
        },
      ],
    });
    expect(snapshot.root).toBe('C:/workspace');
    expect(snapshot.title).toBe('Optimizer research');
    expect(snapshot.counts.project).toBe(3);
    expect(snapshot.validation).toEqual({ errors: 0, warnings: 0 });
    expect(snapshot.index.path).toBe('C:/workspace/.workspace/index.sqlite');
    expect(snapshot.index.counts.documents).toBe(17);
    expect(snapshot.storage.indexBytes).toBe(61440);
    expect(snapshot.recentActivity).toHaveLength(1);
    expect(snapshot.recentActivity[0]?.id).toBe('chat_lab');
    expect(snapshot.diagnostics).toHaveLength(1);
  });

  it('tolerates malformed bodies', () => {
    const snapshot = toWorkspaceSnapshot(null);
    expect(snapshot.root).toBe('');
    expect(snapshot.title).toBeNull();
    expect(snapshot.counts).toEqual({});
    expect(snapshot.validation).toEqual({ errors: 0, warnings: 0 });
    expect(snapshot.recentActivity).toEqual([]);
  });
});

describe('activityEntriesOf', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const entries = activityEntriesOf([
      {
        kind: 'project',
        id: 'p1',
        title: 'P1',
        path: 'a',
        modifiedAt: sameDay,
      },
      { kind: 'resource', title: 'R', path: 'b' },
      { title: 'no path' },
      'nope',
      null,
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[1]?.id).toBeNull();
    expect(entries[1]?.modifiedAt).toBe('');
  });

  it('returns an empty list for non-arrays', () => {
    expect(activityEntriesOf(undefined)).toEqual([]);
    expect(activityEntriesOf({})).toEqual([]);
  });
});

describe('activityTarget', () => {
  const base = { title: 'x', path: 'p', modifiedAt: '' };
  it('routes chats and projects to their detail pages', () => {
    expect(activityTarget({ ...base, kind: 'chat', id: 'c1' })).toBe(
      '/chats/c1',
    );
    expect(activityTarget({ ...base, kind: 'project', id: 'p1' })).toBe(
      '/projects/p1',
    );
  });

  it('routes tasks to the tasks list', () => {
    expect(activityTarget({ ...base, kind: 'task', id: 't1' })).toBe('/tasks');
  });

  it('routes everything else to the editor by path', () => {
    expect(activityTarget({ ...base, kind: 'resource', id: 'r1' })).toBe(
      `/edit?path=${encodeURIComponent('p')}`,
    );
    expect(activityTarget({ ...base, kind: 'chat', id: null })).toBe(
      `/edit?path=${encodeURIComponent('p')}`,
    );
  });
});

describe('activity labels', () => {
  it('maps kinds to mockup labels and tag classes', () => {
    expect(activityKindLabel('project')).toBe('project');
    expect(activityKindLabel('summary')).toBe('topic');
    expect(activityKindLabel('mystery')).toBe('mystery');
    expect(activityTagClass('project')).toBe('proj');
    expect(activityTagClass('chat')).toBe('dim');
  });
});

describe('recentChats', () => {
  function chat(overrides: Partial<ChatListEntry> = {}): ChatListEntry {
    return {
      id: 'chat_a',
      title: 'Chat A',
      created: null,
      updated: null,
      projects: [],
      topics: [],
      provider: null,
      model: null,
      path: 'chats/a.md',
      ...overrides,
    };
  }

  it('orders by updated descending and falls back to created', () => {
    const older = chat({ id: 'chat_older', updated: '2026-09-01' });
    const newer = chat({ id: 'chat_newer', updated: '2026-09-10' });
    const fallback = chat({
      id: 'chat_fallback',
      created: '2026-09-12',
      updated: null,
    });
    expect(
      recentChats([older, newer, fallback]).map((entry) => entry.id),
    ).toEqual(['chat_fallback', 'chat_newer', 'chat_older']);
  });

  it('puts undated chats last and takes the requested limit', () => {
    const entries = [
      chat({ id: 'chat_undated' }),
      chat({ id: 'chat_1', updated: '2026-09-01' }),
      chat({ id: 'chat_2', updated: '2026-09-02' }),
      chat({ id: 'chat_3', updated: '2026-09-03' }),
    ];
    expect(recentChats(entries, 2).map((entry) => entry.id)).toEqual([
      'chat_3',
      'chat_2',
    ]);
    expect(recentChats(entries).at(-1)?.id).toBe('chat_undated');
  });

  it('breaks ties on id so the order is stable', () => {
    const entries = [
      chat({ id: 'chat_b', updated: '2026-09-01' }),
      chat({ id: 'chat_a', updated: '2026-09-01' }),
    ];
    expect(recentChats(entries).map((entry) => entry.id)).toEqual([
      'chat_a',
      'chat_b',
    ]);
  });
});

describe('priorityTasks', () => {
  function task(overrides: Partial<TaskView> = {}): TaskView {
    return {
      id: 'task_a',
      title: 'Task A',
      status: 'active',
      description: '',
      projects: [],
      created: '2026-09-01',
      updated: '2026-09-01',
      path: 'tasks/a.md',
      contentHash: 'ab'.repeat(32),
      overdue: false,
      upcoming: false,
      ...overrides,
    };
  }

  it('keeps active tasks only, deadline ascending, undated last', () => {
    const entries = [
      task({ id: 'task_undated' }),
      task({ id: 'task_late', deadline: '2026-09-20' }),
      task({ id: 'task_early', deadline: '2026-09-05' }),
      task({ id: 'task_done', status: 'done', deadline: '2026-09-01' }),
    ];
    expect(priorityTasks(entries).map((entry) => entry.id)).toEqual([
      'task_early',
      'task_late',
      'task_undated',
    ]);
  });

  it('sorts overdue deadlines ahead of later ones', () => {
    const entries = [
      task({ id: 'task_future', deadline: '2026-10-01' }),
      task({ id: 'task_overdue', deadline: '2026-09-01', overdue: true }),
    ];
    expect(priorityTasks(entries)[0]?.id).toBe('task_overdue');
  });

  it('takes the requested limit and ignores invalid deadlines', () => {
    const entries = [
      task({ id: 'task_1', deadline: '2026-09-01' }),
      task({ id: 'task_2', deadline: '2026-09-02' }),
      task({ id: 'task_3', deadline: '2026-09-03' }),
      task({ id: 'task_bad', deadline: 'not-a-date' }),
    ];
    expect(priorityTasks(entries, 2).map((entry) => entry.id)).toEqual([
      'task_1',
      'task_2',
    ]);
    expect(priorityTasks(entries).at(-1)?.id).toBe('task_bad');
  });
});

describe('relativeTime', () => {
  it('shows a clock for the same local day', () => {
    expect(relativeTime(sameDay, now)).toBe('09:30');
  });

  it('shows a short date earlier in the same year', () => {
    expect(relativeTime(earlierSameYear, now)).toBe('Sep 6');
  });

  it('includes the year across years', () => {
    expect(relativeTime(earlierYear, now)).toBe('Aug 27, 2025');
  });

  it('returns an empty string for invalid input', () => {
    expect(relativeTime('not-a-date', now)).toBe('');
  });
});

describe('formatClock', () => {
  it('shows seconds for the same day', () => {
    expect(formatClock(sameDay, now)).toBe('09:30:15');
  });

  it('falls back to the relative date on other days', () => {
    expect(formatClock(earlierSameYear, now)).toBe('Sep 6');
  });
});

describe('humanizeBytes', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(humanizeBytes(348)).toBe('348 B');
    expect(humanizeBytes(1024)).toBe('1 KB');
    expect(humanizeBytes(1536)).toBe('1.5 KB');
    expect(humanizeBytes(3182)).toBe('3.1 KB');
    expect(humanizeBytes(61440)).toBe('60 KB');
    expect(humanizeBytes(1048576)).toBe('1 MB');
  });

  it('handles zero and negative values', () => {
    expect(humanizeBytes(0)).toBe('0 B');
    expect(humanizeBytes(-5)).toBe('0 B');
  });
});

describe('topicLabel', () => {
  it('strips the stable id prefix', () => {
    expect(topicLabel('topic_preconditioning')).toBe('preconditioning');
    expect(topicLabel('posterior')).toBe('posterior');
  });
});
