import { parseDiagnostics } from '../shared/responses.js';
import type { ChatListEntry } from '../shared/projects/catalog.js';
import type { DiagnosticView } from '../shared/types.js';
import type { TaskView } from './tasksModel.js';

export type WorkspaceCounts = Record<string, number>;

export interface WorkspaceIndexSummary {
  path: string;
  modifiedAt: string;
  counts: Record<string, number>;
}

export interface WorkspaceSnapshot {
  root: string;
  title: string | null;
  counts: WorkspaceCounts;
  validation: { errors: number; warnings: number };
  index: WorkspaceIndexSummary;
  storage: { indexBytes: number };
  recentActivity: ActivityEntry[];
  diagnostics: DiagnosticView[];
}

export interface ActivityEntry {
  kind: string;
  id: string | null;
  title: string;
  path: string;
  modifiedAt: string;
}

export function toWorkspaceSnapshot(data: unknown): WorkspaceSnapshot {
  const record = isRecord(data) ? data : {};
  return {
    root: typeof record.root === 'string' ? record.root : '',
    title: typeof record.title === 'string' ? record.title : null,
    counts: numberRecord(record.counts),
    validation: {
      errors: countOf(record.validation, 'errors'),
      warnings: countOf(record.validation, 'warnings'),
    },
    index: indexOf(record.index),
    storage: {
      indexBytes: countOf(record.storage, 'indexBytes'),
    },
    recentActivity: activityEntriesOf(record.recentActivity),
    diagnostics: parseDiagnostics(data),
  };
}

export function activityEntriesOf(value: unknown): ActivityEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ActivityEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item.title !== 'string' || typeof item.path !== 'string') {
      continue;
    }
    entries.push({
      kind: typeof item.kind === 'string' ? item.kind : 'file',
      id: typeof item.id === 'string' ? item.id : null,
      title: item.title,
      path: item.path,
      modifiedAt: typeof item.modifiedAt === 'string' ? item.modifiedAt : '',
    });
  }
  return entries;
}

// Routes for a recent-activity row. Chats and projects open their detail page
// when an id is present; tasks are a list route; everything else opens the file
// in the editor by path.
export function activityTarget(entry: ActivityEntry): string {
  if (entry.kind === 'chat' && entry.id !== null) return `/chats/${entry.id}`;
  if (entry.kind === 'project' && entry.id !== null) {
    return `/projects/${entry.id}`;
  }
  if (entry.kind === 'task') return '/tasks';
  return `/edit?path=${encodeURIComponent(entry.path)}`;
}

// Short label for a recent-activity row, matching the mockup's tag copy.
export function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'project':
      return 'project';
    case 'chat':
      return 'chat';
    case 'task':
      return 'task';
    case 'resource':
      return 'resource';
    case 'summary':
      return 'topic';
    case 'workspace':
      return 'workspace';
    case 'link':
      return 'link';
    default:
      return kind;
  }
}

export function activityTagClass(kind: string): string {
  if (kind === 'project') return 'proj';
  if (kind === 'task') return 'dim';
  return 'dim';
}

// ————— overview selections —————

function compareId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function updatedTime(value: string | null): number {
  if (value === null || value === '') return Number.NEGATIVE_INFINITY;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

// Most recently updated chats first, falling back to the created stamp when a
// chat has no `updated`. Undated entries sort last; ties break on id so the
// selected order is stable.
export function recentChats(
  chats: readonly ChatListEntry[],
  limit = 5,
): ChatListEntry[] {
  return [...chats]
    .sort((left, right) => {
      const leftTime = updatedTime(left.updated ?? left.created);
      const rightTime = updatedTime(right.updated ?? right.created);
      if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1;
      return compareId(left.id, right.id);
    })
    .slice(0, limit);
}

function deadlineTime(deadline: string | undefined): number | null {
  if (deadline === undefined || deadline === '') return null;
  // Date-only values parse as local midnight; `new Date('YYYY-MM-DD')` would
  // treat them as UTC and can shift the day.
  const date = /^\d{4}-\d{2}-\d{2}$/.test(deadline)
    ? new Date(`${deadline}T00:00:00`)
    : new Date(deadline);
  const time = date.getTime();
  return Number.isNaN(time) ? null : time;
}

// Active tasks closest to their deadline first. Overdue tasks carry the
// earliest deadlines and therefore sort to the front; undated tasks go last.
export function priorityTasks(
  tasks: readonly TaskView[],
  limit = 5,
): TaskView[] {
  return tasks
    .filter((task) => task.status === 'active')
    .sort((left, right) => {
      const leftTime = deadlineTime(left.deadline);
      const rightTime = deadlineTime(right.deadline);
      if (leftTime === null && rightTime === null) {
        return compareId(left.id, right.id);
      }
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
      return compareId(left.id, right.id);
    })
    .slice(0, limit);
}

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

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

function sameLocalDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

// "09:30" on the same day, "Sep 6" earlier in the same year, and
// "Sep 6, 2025" across years. `now` is passed in so the value is testable.
export function relativeTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (sameLocalDay(date, now)) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  const month = shortMonths[date.getMonth()] ?? '';
  if (date.getFullYear() === now.getFullYear()) {
    return `${month} ${String(date.getDate())}`;
  }
  return `${month} ${String(date.getDate())}, ${String(date.getFullYear())}`;
}

export function formatClock(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  if (!sameLocalDay(date, now)) return relativeTime(iso, now);
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function humanizeBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = units[unit] ?? 'B';
  if (unit === 0) return `${String(Math.round(value))} ${label}`;
  const rounded = Math.round(value * 10) / 10;
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${text} ${label}`;
}

// Topic frontmatter stores stable ids like "topic_preconditioning"; the UI
// shows the trailing slug.
export function topicLabel(id: string): string {
  return id.replace(/^topic_/, '');
}

function indexOf(value: unknown): WorkspaceIndexSummary {
  const record = isRecord(value) ? value : {};
  return {
    path: typeof record.path === 'string' ? record.path : '',
    modifiedAt: typeof record.modifiedAt === 'string' ? record.modifiedAt : '',
    counts: numberRecord(record.counts),
  };
}

function numberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      result[key] = entry;
    }
  }
  return result;
}

function countOf(value: unknown, key: string): number {
  if (!isRecord(value)) return 0;
  const entry = value[key];
  return typeof entry === 'number' && Number.isFinite(entry) ? entry : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
