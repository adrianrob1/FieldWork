import { parseDiagnostics } from '../shared/responses.js';
import type { DiagnosticView } from '../shared/types.js';

// Pure task logic. Fetch-free so the state machine can be unit tested; the
// React page in TasksPage.tsx wires these to the live /api/tasks endpoints.

export type TaskStatus = 'active' | 'done';

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  description: string;
  projects: string[];
  created: string;
  updated: string;
  deadline?: string;
  completed?: string;
  path: string;
  contentHash: string;
  overdue: boolean;
  upcoming: boolean;
}

export interface TaskGroups {
  active: TaskView[];
  overdue: TaskView[];
  upcoming: TaskView[];
  done: TaskView[];
}

export interface TaskListData {
  tasks: TaskView[];
  groups: TaskGroups;
  diagnostics: DiagnosticView[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function parseTaskView(value: unknown): TaskView | null {
  if (!isRecord(value)) return null;
  const { id, title, status } = value;
  if (typeof id !== 'string' || typeof title !== 'string') return null;
  if (status !== 'active' && status !== 'done') return null;
  const view: TaskView = {
    id,
    title,
    status,
    description: stringOf(value.description),
    projects: stringList(value.projects),
    created: stringOf(value.created),
    updated: stringOf(value.updated),
    path: stringOf(value.path),
    contentHash: stringOf(value.contentHash),
    overdue: value.overdue === true,
    upcoming: value.upcoming === true,
  };
  if (typeof value.deadline === 'string') view.deadline = value.deadline;
  if (typeof value.completed === 'string') view.completed = value.completed;
  return view;
}

// GET /api/tasks returns groups as resolved task views, but the route's shape is
// allowed to carry bare ids, so both are accepted.
function groupOf(
  raw: unknown,
  byId: ReadonlyMap<string, TaskView>,
): TaskView[] {
  if (!Array.isArray(raw)) return [];
  const tasks: TaskView[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const task = byId.get(entry);
      if (task !== undefined) tasks.push(task);
      continue;
    }
    const task = parseTaskView(entry);
    if (task !== null) tasks.push(task);
  }
  return tasks;
}

export function parseTaskList(data: unknown): TaskListData {
  const record = isRecord(data) ? data : {};
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : [];
  const tasks: TaskView[] = [];
  for (const entry of rawTasks) {
    const task = parseTaskView(entry);
    if (task !== null) tasks.push(task);
  }
  const byId = new Map<string, TaskView>();
  for (const task of tasks) byId.set(task.id, task);
  const rawGroups = isRecord(record.groups) ? record.groups : {};
  return {
    tasks,
    groups: {
      active: groupOf(rawGroups.active, byId),
      overdue: groupOf(rawGroups.overdue, byId),
      upcoming: groupOf(rawGroups.upcoming, byId),
      done: groupOf(rawGroups.done, byId),
    },
    diagnostics: parseDiagnostics(data),
  };
}

// ————— quick add —————

export interface QuickAdd {
  title: string;
  description: string;
}

// Mirrors createTask's parser: the first line is the title and the rest of the
// trimmed text is the description. A blank title yields null.
export function parseQuickAdd(text: string): QuickAdd | null {
  const source = text.trim();
  if (source.length === 0) return null;
  const newline = source.indexOf('\n');
  const title = (newline === -1 ? source : source.slice(0, newline)).trim();
  if (title.length === 0) return null;
  const description = newline === -1 ? '' : source.slice(newline + 1).trim();
  return { title, description };
}

// ————— deadline presets —————

export const deadlinePresets = ['today', 'tomorrow', 'hour', 'pick'] as const;
export type DeadlinePreset = (typeof deadlinePresets)[number];
export const defaultDeadlinePreset: DeadlinePreset = 'tomorrow';

export const deadlinePresetLabels: Record<DeadlinePreset, string> = {
  today: 'Today 17:00',
  tomorrow: 'Tomorrow 09:00',
  hour: 'In 1 hour',
  pick: 'Pick a time…',
};

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// A local wall-clock timestamp with an explicit offset. The task schema accepts
// RFC 3339 with an offset, and an offset (rather than toISOString's UTC) keeps
// deadline.slice(0, 10) aligned with the server's local todayDate().
export function localTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}` +
    `${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  );
}

// ISO deadline sent to the API for each preset; undefined means "no deadline"
// (only possible for an unset "Pick a time…").
export function deadlineForPreset(
  preset: DeadlinePreset,
  now: Date,
  pickedValue: string,
): string | undefined {
  switch (preset) {
    case 'today':
      return localTimestamp(
        new Date(now.getFullYear(), now.getMonth(), now.getDate(), 17, 0, 0),
      );
    case 'tomorrow':
      return localTimestamp(
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0),
      );
    case 'hour':
      return localTimestamp(new Date(now.getTime() + 60 * 60 * 1000));
    case 'pick': {
      const value = pickedValue.trim();
      if (value === '') return undefined;
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : localTimestamp(date);
    }
    default:
      return undefined;
  }
}

const shortWeekdays = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
] as const;
const shortMonths = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

// Label the "Pick a time…" chip takes once a datetime-local value is chosen,
// matching the mockup's "Sun, Sep 13 17:30".
export function formatPickedLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return deadlinePresetLabels.pick;
  const weekday = shortWeekdays[date.getDay()] ?? '';
  const month = shortMonths[date.getMonth()] ?? '';
  return `${weekday}, ${month} ${date.getDate()} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// ————— payload builders —————

export interface SnoozeRequest {
  duration?: string;
  deadline?: string;
}

// The snooze endpoint takes exactly one of duration or deadline.
export function snoozePayload(input: SnoozeRequest): Record<string, string> {
  if (input.duration !== undefined) return { duration: input.duration };
  if (input.deadline !== undefined) return { deadline: input.deadline };
  return {};
}

export function statusPayload(expectedHash: string): {
  expectedHash: string;
} {
  return { expectedHash };
}

// ————— grouping —————

export type TaskSectionKey = 'overdue' | 'active' | 'upcoming' | 'done';

export interface TaskSection {
  key: TaskSectionKey;
  tasks: TaskView[];
}

// The server's `active` group contains every active task, including the overdue
// and upcoming ones. Sections de-duplicate so a task appears once: overdue
// first, then the undated active remainder, then upcoming, then done.
export function taskSections(groups: TaskGroups): TaskSection[] {
  const seen = new Set<string>();
  const take = (tasks: readonly TaskView[]): TaskView[] => {
    const out: TaskView[] = [];
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      out.push(task);
    }
    return out;
  };
  const overdue = take(groups.overdue);
  const upcoming = take(groups.upcoming);
  const active = take(groups.active);
  const done = take(groups.done);
  return [
    { key: 'overdue', tasks: overdue },
    { key: 'active', tasks: active },
    { key: 'upcoming', tasks: upcoming },
    { key: 'done', tasks: done },
  ];
}

// ————— deadline display —————

interface ParsedDeadline {
  date: Date;
  hasTime: boolean;
}

// Date-only deadlines are parsed as local midnight; parsing them with
// `new Date('YYYY-MM-DD')` would treat them as UTC and can shift the day.
function parseDeadline(value: string): ParsedDeadline | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : { date, hasTime: false };
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : { date, hasTime: true };
}

function startOfDay(date: Date): number {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

function dayDifference(date: Date, now: Date): number {
  return Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
}

function dayLabel(date: Date, now: Date): string {
  const difference = dayDifference(date, now);
  if (difference === 0) return 'today';
  if (difference === 1) return 'tomorrow';
  if (difference === -1) return 'yesterday';
  if (Math.abs(difference) <= 6) return shortWeekdays[date.getDay()] ?? '';
  const month = shortMonths[date.getMonth()] ?? '';
  if (date.getFullYear() !== now.getFullYear()) {
    return `${month} ${date.getDate()}, ${date.getFullYear()}`;
  }
  return `${month} ${date.getDate()}`;
}

function dayClock(value: string, now: Date): string {
  const parsed = parseDeadline(value);
  if (parsed === null) return '';
  const label = dayLabel(parsed.date, now);
  if (!parsed.hasTime) return label;
  return `${label} ${pad2(parsed.date.getHours())}:${pad2(parsed.date.getMinutes())}`;
}

function spanLabel(milliseconds: number): string {
  const minutes = Math.round(Math.abs(milliseconds) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

// Mockup shapes: "due today 14:00 · in 4h", "due yesterday 16:00 · 22h over",
// "due Fri 18:00 · in 2d", "done Wed 11:20 · was due Wed 17:00".
export function deadlineText(task: TaskView, now: Date): string {
  if (task.status === 'done') {
    const completed = task.completed ?? task.updated;
    const donePart =
      completed === '' ? 'done' : `done ${dayClock(completed, now)}`;
    if (task.deadline === undefined) return donePart;
    return `${donePart} · was due ${dayClock(task.deadline, now)}`;
  }
  if (task.deadline === undefined) return 'no deadline';
  const parsed = parseDeadline(task.deadline);
  if (parsed === null) return 'no deadline';
  const due = `due ${dayClock(task.deadline, now)}`;
  if (task.overdue) {
    return `${due} · ${spanLabel(now.getTime() - parsed.date.getTime())} over`;
  }
  const difference = parsed.date.getTime() - now.getTime();
  if (difference >= 0) return `${due} · in ${spanLabel(difference)}`;
  return due;
}

// ————— project labels —————

export function projectTitles(data: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  if (!isRecord(data)) return titles;
  const list = data.projects;
  if (!Array.isArray(list)) return titles;
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const { id, title } = entry;
    if (typeof id === 'string' && typeof title === 'string') {
      titles.set(id, title);
    }
  }
  return titles;
}

export function projectTagLabel(
  id: string,
  titles: ReadonlyMap<string, string>,
): string {
  const title = titles.get(id);
  if (title !== undefined) return title;
  return id.replace(/^project_/, '');
}
