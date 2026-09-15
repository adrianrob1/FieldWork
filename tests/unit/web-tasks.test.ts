import { describe, expect, it } from 'vitest';

import {
  deadlineForPreset,
  deadlineText,
  formatPickedLabel,
  localTimestamp,
  parseQuickAdd,
  parseTaskList,
  parseTaskView,
  snoozePayload,
  statusPayload,
  taskSections,
  type TaskGroups,
  type TaskView,
} from '../../web/src/pages/tasksModel.js';

const hash = 'ab'.repeat(32);

function task(overrides: Partial<TaskView> = {}): TaskView {
  const base: TaskView = {
    id: 'task_x',
    title: 'Task',
    status: 'active',
    description: '',
    projects: [],
    created: '2026-09-01',
    updated: '2026-09-01',
    path: 'tasks/task.md',
    contentHash: hash,
    overdue: false,
    upcoming: false,
  };
  return { ...base, ...overrides };
}

describe('parseQuickAdd', () => {
  it('rejects empty and whitespace-only text', () => {
    expect(parseQuickAdd('')).toBeNull();
    expect(parseQuickAdd('   \n  ')).toBeNull();
  });

  it('uses a single line as the title with no description', () => {
    expect(parseQuickAdd('Buy milk')).toEqual({
      title: 'Buy milk',
      description: '',
    });
  });

  it('splits the first line from the rest', () => {
    expect(parseQuickAdd('Buy milk\n2%, organic')).toEqual({
      title: 'Buy milk',
      description: '2%, organic',
    });
  });

  it('collapses surrounding whitespace across lines', () => {
    expect(parseQuickAdd('  Buy milk  \n\n  2%  ')).toEqual({
      title: 'Buy milk',
      description: '2%',
    });
  });

  it('keeps multi-paragraph descriptions', () => {
    expect(parseQuickAdd('Title\nfirst\n\nsecond')).toEqual({
      title: 'Title',
      description: 'first\n\nsecond',
    });
  });
});

describe('localTimestamp', () => {
  it('round-trips through Date and carries an explicit offset', () => {
    const date = new Date(2026, 8, 13, 17, 0, 0);
    const stamp = localTimestamp(date);
    expect(stamp).toMatch(/^2026-09-13T17:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(stamp).getTime()).toBe(date.getTime());
  });
});

describe('deadlineForPreset', () => {
  const now = new Date(2026, 8, 13, 10, 30, 0);

  it('returns today at 17:00 in local time', () => {
    const stamp = deadlineForPreset('today', now, '');
    expect(stamp).toBeDefined();
    const date = new Date(stamp ?? '');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8);
    expect(date.getDate()).toBe(13);
    expect(date.getHours()).toBe(17);
    expect(date.getMinutes()).toBe(0);
    expect(stamp).toMatch(/^2026-09-13T17:00:00[+-]\d{2}:\d{2}$/);
  });

  it('returns tomorrow at 09:00 in local time', () => {
    const stamp = deadlineForPreset('tomorrow', now, '');
    expect(stamp).toBeDefined();
    const date = new Date(stamp ?? '');
    expect(date.getDate()).toBe(14);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it('returns one hour after now', () => {
    const stamp = deadlineForPreset('hour', now, '');
    expect(stamp).toBeDefined();
    expect(new Date(stamp ?? '').getTime() - now.getTime()).toBe(3_600_000);
  });

  it('converts a picked datetime-local value and rejects a blank one', () => {
    const stamp = deadlineForPreset('pick', now, '2026-09-14T08:15');
    expect(stamp).toBeDefined();
    const date = new Date(stamp ?? '');
    expect(date.getDate()).toBe(14);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(15);
    expect(deadlineForPreset('pick', now, '')).toBeUndefined();
    expect(deadlineForPreset('pick', now, 'not-a-date')).toBeUndefined();
  });
});

describe('formatPickedLabel', () => {
  it('renders the mockup chip label', () => {
    expect(formatPickedLabel('2026-09-13T17:30')).toBe('Sun, Sep 13 17:30');
  });

  it('falls back to the preset label for an unreadable value', () => {
    expect(formatPickedLabel('')).toBe('Pick a time…');
  });
});

describe('snoozePayload', () => {
  it('sends a duration when one is given', () => {
    expect(snoozePayload({ duration: '30m' })).toEqual({ duration: '30m' });
    expect(snoozePayload({ duration: '1h' })).toEqual({ duration: '1h' });
  });

  it('sends an exact deadline instead', () => {
    const stamp = '2026-09-14T09:00:00+02:00';
    expect(snoozePayload({ deadline: stamp })).toEqual({ deadline: stamp });
  });

  it('sends nothing when neither is provided', () => {
    expect(snoozePayload({})).toEqual({});
  });
});

describe('statusPayload', () => {
  it('wraps the expected hash used by done and reopen', () => {
    expect(statusPayload(hash)).toEqual({ expectedHash: hash });
  });
});

describe('taskSections', () => {
  const undated = task({ id: 'task_undated' });
  const overdue = task({
    id: 'task_overdue',
    overdue: true,
    deadline: '2026-09-05',
  });
  const upcoming = task({
    id: 'task_upcoming',
    upcoming: true,
    deadline: '2026-09-20',
  });
  const done = task({ id: 'task_done', status: 'done' });

  const groups: TaskGroups = {
    active: [overdue, upcoming, undated],
    overdue: [overdue],
    upcoming: [upcoming],
    done: [done],
  };

  it('orders sections overdue, active, upcoming, done', () => {
    expect(taskSections(groups).map((section) => section.key)).toEqual([
      'overdue',
      'active',
      'upcoming',
      'done',
    ]);
  });

  it('de-duplicates active tasks into exactly one section', () => {
    const sections = taskSections(groups);
    expect(sections[0]?.tasks.map((entry) => entry.id)).toEqual([
      'task_overdue',
    ]);
    expect(sections[1]?.tasks.map((entry) => entry.id)).toEqual([
      'task_undated',
    ]);
    expect(sections[2]?.tasks.map((entry) => entry.id)).toEqual([
      'task_upcoming',
    ]);
    expect(sections[3]?.tasks.map((entry) => entry.id)).toEqual(['task_done']);
  });
});

describe('parseTaskList', () => {
  it('resolves id-based groups against the task list', () => {
    const list = parseTaskList({
      tasks: [
        { ...task({ id: 'task_a' }), status: 'active' },
        { ...task({ id: 'task_b' }), status: 'done' },
      ],
      groups: {
        active: ['task_a'],
        overdue: [],
        upcoming: [],
        done: ['task_b'],
      },
    });
    expect(list.tasks).toHaveLength(2);
    expect(list.groups.active[0]?.id).toBe('task_a');
    expect(list.groups.done[0]?.id).toBe('task_b');
  });

  it('accepts resolved task objects in groups', () => {
    const list = parseTaskList({
      tasks: [],
      groups: {
        active: [],
        overdue: [task({ id: 'task_o', overdue: true })],
        upcoming: [],
        done: [],
      },
    });
    expect(list.groups.overdue[0]?.id).toBe('task_o');
    expect(list.groups.overdue[0]?.overdue).toBe(true);
  });

  it('drops malformed task entries', () => {
    expect(parseTaskView({ title: 'no id' })).toBeNull();
    const list = parseTaskList({ tasks: [{ id: 'x' }], groups: {} });
    expect(list.tasks).toHaveLength(0);
  });
});

describe('deadlineText', () => {
  const now = new Date(2026, 8, 13, 14, 0, 0);

  it('marks an overdue task with an elapsed span', () => {
    const entry = task({
      overdue: true,
      deadline: '2026-09-12T16:00:00',
    });
    expect(deadlineText(entry, now)).toBe('due yesterday 16:00 · 22h over');
  });

  it('states a near-future deadline relative to now', () => {
    const entry = task({
      upcoming: true,
      deadline: '2026-09-13T18:00:00',
    });
    expect(deadlineText(entry, now)).toBe('due today 18:00 · in 4h');
  });

  it('names a weekday for deadlines later this week', () => {
    const entry = task({
      upcoming: true,
      deadline: '2026-09-15T18:00:00',
    });
    expect(deadlineText(entry, now)).toBe('due Tue 18:00 · in 2d');
  });

  it('omits the clock for a date-only deadline and a different year', () => {
    const entry = task({ deadline: '2027-09-20' });
    expect(deadlineText(entry, now)).toContain('due Sep 20, 2027');
  });

  it('reports a done task and its original deadline', () => {
    const entry = task({
      status: 'done',
      updated: '2026-09-09T11:20:00',
      completed: '2026-09-09T11:20:00',
      deadline: '2026-09-09T17:00:00',
    });
    expect(deadlineText(entry, now)).toBe('done Wed 11:20 · was due Wed 17:00');
  });

  it('labels an active task without a deadline', () => {
    expect(deadlineText(task(), now)).toBe('no deadline');
  });
});
