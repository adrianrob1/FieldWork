import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { Document, ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { dateSchema } from '../domain/schemas.js';
import type { AttachmentReference } from '../domain/transcript.js';
import {
  metadataDeclaredIds,
  parseWorkspace,
  workspaceAreaPaths,
  type ParsedWorkspaceFile,
  type WorkspaceParseResult,
} from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import {
  createCanonicalFile,
  editCanonicalFile,
  singleTrailingNewline,
  type CanonicalWriteOutcome,
  type WriteHooks,
} from './edit.js';
import {
  findFileById,
  hasError,
  invalidStableIdDiagnostic,
  missingObjectDiagnostic,
} from './lookup.js';
import { refreshDiagnostics } from './register.js';
import {
  operationFailed,
  operationOk,
  type OperationResult,
} from './result.js';
import { chatTitleSlug, todayDate } from './start.js';

export interface TaskView {
  id: string;
  title: string;
  status: 'active' | 'done';
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
}

export interface TaskQuickAddInput {
  text: string;
  projects?: string[] | undefined;
  deadline?: string | undefined;
}

export interface TaskUpdateInput {
  taskId: string;
  title?: string | undefined;
  body?: string | undefined;
  projects?: string[] | undefined;
  deadline?: string | undefined;
  expectedHash: string;
}

export interface TaskStatusInput {
  taskId: string;
  expectedHash: string;
}

export interface TaskSnoozeInput {
  taskId: string;
  expectedHash: string;
  duration?: string | undefined;
  deadline?: string | undefined;
  at?: Date | undefined;
}

export interface TaskIdInput {
  taskId: string;
}

export interface TaskAttachmentPayload {
  id: string;
  kind: 'task';
  path: string;
  title: string;
  label: string;
  mime: string;
}

export interface TaskAttachmentResolution {
  reference: AttachmentReference;
  attachment: TaskAttachmentPayload;
}

interface QuickAddText {
  title: string;
  description: string;
}

interface TaskLookup {
  file: string;
  body: string;
  view: TaskView;
}

type TaskLookupOutcome =
  { ok: true; found: TaskLookup } | { ok: false; failures: Diagnostic[] };

export function taskView(
  root: string,
  file: ParsedWorkspaceFile,
): TaskView | null {
  const metadata = file.metadata;
  const contentHash = file.contentHash;
  if (metadata === null || contentHash === null) return null;
  const id = metadata.id;
  const title = metadata.title;
  const status = metadata.status;
  const created = metadata.created;
  const updated = metadata.updated;
  if (
    typeof id !== 'string' ||
    typeof title !== 'string' ||
    (status !== 'active' && status !== 'done') ||
    typeof created !== 'string' ||
    typeof updated !== 'string'
  ) {
    return null;
  }
  const today = todayDate();
  const deadline =
    typeof metadata.deadline === 'string' ? metadata.deadline : null;
  const deadlineDate = deadline === null ? null : deadline.slice(0, 10);
  const view: TaskView = {
    id,
    title,
    status,
    description: (file.body ?? '').trim(),
    projects: stringList(metadata.projects),
    created,
    updated,
    path: canonicalPath(root, file.file),
    contentHash,
    overdue:
      status === 'active' && deadlineDate !== null && deadlineDate < today,
    upcoming:
      status === 'active' && deadlineDate !== null && deadlineDate >= today,
  };
  if (deadline !== null) view.deadline = deadline;
  if (typeof metadata.completed === 'string') {
    view.completed = metadata.completed;
  }
  return view;
}

export async function listTasks(
  root: string,
): Promise<OperationResult<TaskListData>> {
  const parsed = await parseWorkspace(root);
  const diagnostics: Diagnostic[] = [];
  const views: TaskView[] = [];
  for (const file of parsed.files) {
    if (file.kind !== 'task') continue;
    const view = taskView(parsed.root, file);
    if (view === null) {
      diagnostics.push(
        ...file.diagnostics.filter((entry) => entry.severity === 'error'),
      );
      continue;
    }
    views.push(view);
  }
  const active = views
    .filter((task) => task.status === 'active')
    .sort(compareActiveTasks);
  const done = views
    .filter((task) => task.status === 'done')
    .sort(compareDoneTasks);
  return operationOk(
    false,
    [],
    {
      tasks: [...active, ...done],
      groups: {
        active,
        overdue: active.filter((task) => task.overdue),
        upcoming: active.filter((task) => task.upcoming),
        done,
      },
    },
    diagnostics,
  );
}

export async function createTask(
  root: string,
  input: TaskQuickAddInput,
): Promise<OperationResult<TaskView>> {
  const deadline = input.deadline ?? undefined;
  const projects = input.projects ?? undefined;
  if (deadline !== undefined && !dateSchema.safeParse(deadline).success) {
    return operationFailed([invalidDeadlineDiagnostic(root, deadline)]);
  }
  const quickAdd = parseQuickAddText(input.text);
  if (quickAdd === null) {
    return operationFailed([invalidTitleDiagnostic(root)]);
  }

  const parsed = await parseWorkspace(root);
  const projectDiagnostics = missingProjectDiagnostics(
    root,
    parsed.files,
    projects,
  );
  if (projectDiagnostics.length > 0) {
    return operationFailed(projectDiagnostics);
  }

  const existingIds = new Set<string>();
  for (const file of parsed.files) {
    for (const declared of metadataDeclaredIds(file.kind, file.metadata)) {
      existingIds.add(declared.id);
    }
  }
  const id = taskIdFromTitle(quickAdd.title, existingIds);
  const areas = await workspaceAreaPaths(root);
  const file = await taskFileForTitle(areas.tasks, quickAdd.title);
  const metadata: Record<string, unknown> = {
    id,
    title: quickAdd.title,
    status: 'active',
    created: todayDate(),
    updated: todayDate(),
  };
  if (deadline !== undefined) metadata.deadline = deadline;
  if (projects !== undefined && projects.length > 0) {
    metadata.projects = [...projects];
  }
  await mkdir(areas.tasks, { recursive: true });
  const created = await createCanonicalFile({
    file,
    kind: 'task',
    root,
    metadata,
    body: quickAdd.description.length === 0 ? undefined : quickAdd.description,
  });
  if (!created.changed || hasError(created.diagnostics)) {
    return operationFailed(created.diagnostics);
  }
  const refreshed = await refreshDiagnostics(root);
  const current = await loadTaskView(root, id);
  if (current.view === null) {
    return operationFailed(
      [...created.diagnostics, ...refreshed, ...current.failures],
      [file],
    );
  }
  return operationOk(true, [file], current.view, [
    ...created.diagnostics,
    ...refreshed,
  ]);
}

export async function updateTask(
  root: string,
  input: TaskUpdateInput,
  hooks?: WriteHooks,
): Promise<OperationResult<TaskView>> {
  const title = input.title ?? undefined;
  const body = input.body ?? undefined;
  const projects = input.projects ?? undefined;
  const deadline = input.deadline ?? undefined;
  const expectedHash = input.expectedHash.toLowerCase();
  if (deadline !== undefined && !dateSchema.safeParse(deadline).success) {
    return operationFailed([invalidDeadlineDiagnostic(root, deadline)]);
  }
  if (title !== undefined && title.trim().length === 0) {
    return operationFailed([invalidTitleDiagnostic(root)]);
  }
  const idDiagnostic = invalidStableIdDiagnostic(root, 'Task ID', input.taskId);
  if (idDiagnostic !== null) {
    return operationFailed([idDiagnostic]);
  }

  const parsed = await parseWorkspace(root);
  const projectDiagnostics = missingProjectDiagnostics(
    root,
    parsed.files,
    projects,
  );
  if (projectDiagnostics.length > 0) {
    return operationFailed(projectDiagnostics);
  }
  const resolution = lookupTaskForWrite(
    root,
    parsed,
    input.taskId,
    expectedHash,
  );
  if (!resolution.ok) {
    return operationFailed(resolution.failures);
  }

  const bodyWillChange =
    body !== undefined && singleTrailingNewline(body) !== resolution.found.body;
  const edited = await editCanonicalFile({
    file: resolution.found.file,
    kind: 'task',
    root,
    expectedHash,
    change: (document) => {
      const before = String(document);
      if (title !== undefined) document.set('title', title);
      if (deadline !== undefined) document.set('deadline', deadline);
      if (projects !== undefined) setProjectsNode(document, projects);
      const changed = String(document) !== before;
      if (!changed && !bodyWillChange) return false;
      setUpdatedNode(document, todayDate());
      return String(document) !== before;
    },
    body: body === undefined ? undefined : () => singleTrailingNewline(body),
    hooks,
  });
  return finishTaskWrite(
    root,
    input.taskId,
    resolution.found.file,
    resolution.found.view,
    edited,
  );
}

export async function completeTask(
  root: string,
  input: TaskStatusInput,
  hooks?: WriteHooks,
): Promise<OperationResult<TaskView>> {
  const expectedHash = input.expectedHash.toLowerCase();
  const idDiagnostic = invalidStableIdDiagnostic(root, 'Task ID', input.taskId);
  if (idDiagnostic !== null) {
    return operationFailed([idDiagnostic]);
  }
  const parsed = await parseWorkspace(root);
  const resolution = lookupTaskForWrite(
    root,
    parsed,
    input.taskId,
    expectedHash,
  );
  if (!resolution.ok) {
    return operationFailed(resolution.failures);
  }
  const edited = await editCanonicalFile({
    file: resolution.found.file,
    kind: 'task',
    root,
    expectedHash,
    change: (document) => applyTaskStatusChange(document, 'done'),
    hooks,
  });
  return finishTaskWrite(
    root,
    input.taskId,
    resolution.found.file,
    resolution.found.view,
    edited,
  );
}

export async function reopenTask(
  root: string,
  input: TaskStatusInput,
  hooks?: WriteHooks,
): Promise<OperationResult<TaskView>> {
  const expectedHash = input.expectedHash.toLowerCase();
  const idDiagnostic = invalidStableIdDiagnostic(root, 'Task ID', input.taskId);
  if (idDiagnostic !== null) {
    return operationFailed([idDiagnostic]);
  }
  const parsed = await parseWorkspace(root);
  const resolution = lookupTaskForWrite(
    root,
    parsed,
    input.taskId,
    expectedHash,
  );
  if (!resolution.ok) {
    return operationFailed(resolution.failures);
  }
  const edited = await editCanonicalFile({
    file: resolution.found.file,
    kind: 'task',
    root,
    expectedHash,
    change: (document) => applyTaskStatusChange(document, 'active'),
    hooks,
  });
  return finishTaskWrite(
    root,
    input.taskId,
    resolution.found.file,
    resolution.found.view,
    edited,
  );
}

export async function snoozeTask(
  root: string,
  input: TaskSnoozeInput,
  hooks?: WriteHooks,
): Promise<OperationResult<TaskView>> {
  const duration = input.duration ?? undefined;
  const exactDeadline = input.deadline ?? undefined;
  const expectedHash = input.expectedHash.toLowerCase();
  const argumentDiagnostics: Diagnostic[] = [];
  const idDiagnostic = invalidStableIdDiagnostic(root, 'Task ID', input.taskId);
  if (idDiagnostic !== null) argumentDiagnostics.push(idDiagnostic);
  if (duration !== undefined && exactDeadline !== undefined) {
    argumentDiagnostics.push(
      diagnostic(
        root,
        'task.invalid_snooze',
        'error',
        'A task snooze accepts a duration or a deadline, not both.',
      ),
    );
  }
  if (duration === undefined && exactDeadline === undefined) {
    argumentDiagnostics.push(
      diagnostic(
        root,
        'task.invalid_snooze',
        'error',
        'A task snooze needs a duration or a deadline.',
      ),
    );
  }
  let minutes = 0;
  if (duration !== undefined) {
    const parsedDuration = snoozeMinutes(duration);
    if (parsedDuration === null) {
      argumentDiagnostics.push(
        diagnostic(
          root,
          'task.invalid_snooze',
          'error',
          `A task snooze duration must be a positive whole amount like '30m', '1h', or '2d', not '${duration}'.`,
        ),
      );
    } else {
      minutes = parsedDuration;
    }
  }
  if (
    exactDeadline !== undefined &&
    !dateSchema.safeParse(exactDeadline).success
  ) {
    argumentDiagnostics.push(invalidDeadlineDiagnostic(root, exactDeadline));
  }
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const parsed = await parseWorkspace(root);
  const resolution = lookupTaskForWrite(
    root,
    parsed,
    input.taskId,
    expectedHash,
  );
  if (!resolution.ok) {
    return operationFailed(resolution.failures);
  }
  if (resolution.found.view.status === 'done') {
    return operationFailed([
      diagnostic(
        root,
        'task.invalid_status',
        'error',
        'A done task cannot be snoozed.',
      ),
    ]);
  }
  const at = input.at ?? new Date();
  const newDeadline =
    exactDeadline !== undefined
      ? exactDeadline
      : snoozedDeadline(resolution.found.view.deadline, at, minutes);
  const edited = await editCanonicalFile({
    file: resolution.found.file,
    kind: 'task',
    root,
    expectedHash,
    change: (document) => {
      const before = String(document);
      document.set('deadline', newDeadline);
      if (String(document) === before) return false;
      setUpdatedNode(document, todayDate(at));
      return String(document) !== before;
    },
    hooks,
  });
  return finishTaskWrite(
    root,
    input.taskId,
    resolution.found.file,
    resolution.found.view,
    edited,
  );
}

export async function resolveTaskAttachment(
  root: string,
  input: TaskIdInput,
): Promise<OperationResult<TaskAttachmentResolution>> {
  const idDiagnostic = invalidStableIdDiagnostic(root, 'Task ID', input.taskId);
  if (idDiagnostic !== null) {
    return operationFailed([idDiagnostic]);
  }
  const parsed = await parseWorkspace(root);
  const lookup = lookupTask(root, parsed, input.taskId);
  if (!lookup.ok) {
    return operationFailed(lookup.failures);
  }
  const view = lookup.found.view;
  return operationOk(false, [], {
    reference: { id: view.id },
    attachment: {
      id: view.id,
      kind: 'task',
      path: view.path,
      title: view.title,
      label: view.title,
      mime: 'text/markdown',
    },
  });
}

function lookupTask(
  root: string,
  parsed: WorkspaceParseResult,
  taskId: string,
): TaskLookupOutcome {
  const file = findFileById(parsed.files, 'task', taskId);
  if (file === null) {
    return {
      ok: false,
      failures: [missingObjectDiagnostic(root, 'task', taskId)],
    };
  }
  const view = taskView(parsed.root, file);
  if (view === null) {
    return { ok: false, failures: unviewableTaskDiagnostics(file) };
  }
  return {
    ok: true,
    found: { file: file.file, body: file.body ?? '', view },
  };
}

function lookupTaskForWrite(
  root: string,
  parsed: WorkspaceParseResult,
  taskId: string,
  expectedHash: string,
): TaskLookupOutcome {
  const lookup = lookupTask(root, parsed, taskId);
  if (!lookup.ok) return lookup;
  if (lookup.found.view.contentHash !== expectedHash) {
    return { ok: false, failures: [staleHashDiagnostic(lookup.found.file)] };
  }
  return lookup;
}

async function loadTaskView(
  root: string,
  taskId: string,
): Promise<{ view: TaskView | null; failures: Diagnostic[] }> {
  const parsed = await parseWorkspace(root);
  const lookup = lookupTask(root, parsed, taskId);
  if (lookup.ok) return { view: lookup.found.view, failures: [] };
  return { view: null, failures: lookup.failures };
}

async function finishTaskWrite(
  root: string,
  taskId: string,
  file: string,
  prior: TaskView,
  edited: CanonicalWriteOutcome,
): Promise<OperationResult<TaskView>> {
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    return operationFailed(edited.diagnostics);
  }
  if (!edited.changed) {
    return operationOk(false, [], prior, edited.diagnostics);
  }
  const refreshed = await refreshDiagnostics(root);
  const current = await loadTaskView(root, taskId);
  if (current.view === null) {
    return operationFailed(
      [...edited.diagnostics, ...refreshed, ...current.failures],
      [file],
    );
  }
  return operationOk(true, [file], current.view, [
    ...edited.diagnostics,
    ...refreshed,
  ]);
}

function applyTaskStatusChange(
  document: Document.Parsed<ParsedNode>,
  status: 'active' | 'done',
): boolean {
  const before = String(document);
  document.set('status', status);
  if (status === 'done') {
    if (document.get('completed', true) === undefined) {
      document.set('completed', todayDate());
    }
  } else {
    document.delete('completed');
  }
  if (String(document) === before) return false;
  setUpdatedNode(document, todayDate());
  return String(document) !== before;
}

function setProjectsNode(
  document: Document.Parsed<ParsedNode>,
  projects: string[],
): void {
  if (projects.length === 0) {
    document.delete('projects');
    return;
  }
  document.set('projects', document.createNode([...projects]));
}

function setUpdatedNode(
  document: Document.Parsed<ParsedNode>,
  value: string,
): void {
  if (document.get('updated', true) === value) return;
  document.set('updated', value);
}

function compareActiveTasks(left: TaskView, right: TaskView): number {
  const leftDeadline =
    left.deadline === undefined ? null : left.deadline.slice(0, 10);
  const rightDeadline =
    right.deadline === undefined ? null : right.deadline.slice(0, 10);
  if (leftDeadline !== null && rightDeadline !== null) {
    if (leftDeadline !== rightDeadline) {
      return leftDeadline < rightDeadline ? -1 : 1;
    }
    return compareByTimestampDesc(left.updated, right.updated);
  }
  if (leftDeadline !== null) return -1;
  if (rightDeadline !== null) return 1;
  return compareByTimestampDesc(left.updated, right.updated);
}

function compareDoneTasks(left: TaskView, right: TaskView): number {
  return compareByTimestampDesc(
    left.completed ?? left.updated,
    right.completed ?? right.updated,
  );
}

function compareByTimestampDesc(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? 1 : -1;
}

function parseQuickAddText(text: string): QuickAddText | null {
  if (typeof text !== 'string') return null;
  const source = text.trim();
  if (source.length === 0) return null;
  const newline = source.indexOf('\n');
  const title = (newline === -1 ? source : source.slice(0, newline)).trim();
  if (title.length === 0) return null;
  const description = newline === -1 ? '' : source.slice(newline + 1).trim();
  return { title, description };
}

function taskIdFromTitle(
  title: string,
  existingIds: ReadonlySet<string>,
): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = slug === '' ? 'task' : `task_${slug}`;
  let candidate = base;
  let suffix = 2;
  while (existingIds.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function taskFileForTitle(
  tasksDirectory: string,
  title: string,
): Promise<string> {
  const slug = chatTitleSlug(title);
  const stem = slug.length === 0 ? 'task' : slug;
  const date = todayDate();
  let name = `${date}-${stem}.md`;
  let suffix = 2;
  while (await fileExists(path.join(tasksDirectory, name))) {
    name = `${date}-${stem}-${suffix}.md`;
    suffix += 1;
  }
  return path.join(tasksDirectory, name);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function snoozeMinutes(duration: string): number | null {
  const match = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/.exec(duration);
  if (match === null) return null;
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const hours = match[2] === undefined ? 0 : Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (days === 0 && hours === 0 && minutes === 0) return null;
  return days * 1440 + hours * 60 + minutes;
}

function snoozedDeadline(
  current: string | undefined,
  at: Date,
  minutes: number,
): string {
  const nowDate = todayDate(at);
  const currentDate = current === undefined ? null : current.slice(0, 10);
  const base =
    currentDate !== null && currentDate > nowDate ? currentDate : nowDate;
  const target = new Date(`${base}T00:00:00`);
  target.setMinutes(target.getMinutes() + minutes);
  return todayDate(target);
}

function missingProjectDiagnostics(
  root: string,
  files: ParsedWorkspaceFile[],
  projects: string[] | undefined,
): Diagnostic[] {
  if (projects === undefined) return [];
  const diagnostics: Diagnostic[] = [];
  for (const projectId of projects) {
    if (findFileById(files, 'project', projectId) === null) {
      diagnostics.push(missingObjectDiagnostic(root, 'project', projectId));
    }
  }
  return diagnostics;
}

function unviewableTaskDiagnostics(file: ParsedWorkspaceFile): Diagnostic[] {
  const failures = file.diagnostics.filter(
    (entry) => entry.severity === 'error',
  );
  if (failures.length > 0) return failures;
  return [
    diagnostic(
      file.file,
      'operation.target_invalid',
      'error',
      'The task file could not be read as a task.',
    ),
  ];
}

function staleHashDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'edit.stale_hash',
    'error',
    'The task changed since it was loaded; nothing was written.',
  );
}

function invalidTitleDiagnostic(root: string): Diagnostic {
  return diagnostic(
    root,
    'task.invalid_title',
    'error',
    'A task needs a non-empty title.',
  );
}

function invalidDeadlineDiagnostic(root: string, deadline: string): Diagnostic {
  return diagnostic(
    root,
    'task.invalid_deadline',
    'error',
    `A task deadline must be a YYYY-MM-DD date or an RFC 3339 timestamp, not '${deadline}'.`,
  );
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
