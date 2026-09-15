import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  parseWorkspace,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { stageTaskInDraft } from '../operations/drafts.js';
import { findFileById, missingObjectDiagnostic } from '../operations/lookup.js';
import {
  completeTask,
  createTask,
  listTasks,
  reopenTask,
  snoozeTask,
  taskView,
  updateTask,
} from '../operations/tasks.js';
import {
  apiFailure,
  badRequest,
  hashRequiredResponse,
  isContentHash,
  type ApiResponse,
} from './api.js';

export interface TaskCreateInput {
  text: string;
  projects: string[] | undefined;
  deadline: string | undefined;
}

export interface TaskAddOpenChatInput {
  text: string;
  projects: string[] | undefined;
  deadline: string | undefined;
  draftId: string | undefined;
}

export interface TaskStageInput {
  draftId: string | undefined;
}

export interface TaskUpdatePayloadInput {
  title: string | undefined;
  body: string | undefined;
  projects: string[] | undefined;
  deadline: string | undefined;
  expectedHash: string | null;
}

export interface TaskHashInput {
  expectedHash: string | null;
}

export interface TaskSnoozeInput {
  duration: string | undefined;
  deadline: string | undefined;
  expectedHash: string | null;
}

export function parseTaskCreatePayload(
  payload: unknown,
): { ok: true; input: TaskCreateInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    return {
      ok: false,
      message: "The 'text' field must be a non-empty string.",
    };
  }
  if (payload.projects !== undefined && !isStringArray(payload.projects)) {
    return {
      ok: false,
      message: "The 'projects' field must be an array of strings.",
    };
  }
  if (payload.deadline !== undefined && typeof payload.deadline !== 'string') {
    return { ok: false, message: "The 'deadline' field must be a string." };
  }
  return {
    ok: true,
    input: {
      text: payload.text,
      projects: payload.projects,
      deadline: payload.deadline,
    },
  };
}

export function parseTaskAddOpenChatPayload(
  payload: unknown,
): { ok: true; input: TaskAddOpenChatInput } | { ok: false; message: string } {
  const parsed = parseTaskCreatePayload(payload);
  if (!parsed.ok) return parsed;
  const draftId = (payload as Record<string, unknown>).draftId;
  if (draftId !== undefined && typeof draftId !== 'string') {
    return { ok: false, message: "The 'draftId' field must be a string." };
  }
  return {
    ok: true,
    input: {
      text: parsed.input.text,
      projects: parsed.input.projects,
      deadline: parsed.input.deadline,
      draftId,
    },
  };
}

export function parseTaskStagePayload(
  payload: unknown,
): { ok: true; input: TaskStageInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (payload.draftId !== undefined && typeof payload.draftId !== 'string') {
    return { ok: false, message: "The 'draftId' field must be a string." };
  }
  return { ok: true, input: { draftId: payload.draftId } };
}

export function parseTaskUpdatePayload(
  payload: unknown,
):
  { ok: true; input: TaskUpdatePayloadInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (payload.title !== undefined && typeof payload.title !== 'string') {
    return { ok: false, message: "The 'title' field must be a string." };
  }
  if (payload.body !== undefined && typeof payload.body !== 'string') {
    return { ok: false, message: "The 'body' field must be a string." };
  }
  if (payload.projects !== undefined && !isStringArray(payload.projects)) {
    return {
      ok: false,
      message: "The 'projects' field must be an array of strings.",
    };
  }
  if (payload.deadline !== undefined && typeof payload.deadline !== 'string') {
    return { ok: false, message: "The 'deadline' field must be a string." };
  }
  return {
    ok: true,
    input: {
      title: payload.title,
      body: payload.body,
      projects: payload.projects,
      deadline: payload.deadline,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseTaskHashPayload(
  payload: unknown,
): { ok: true; input: TaskHashInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  return {
    ok: true,
    input: {
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseTaskSnoozePayload(
  payload: unknown,
): { ok: true; input: TaskSnoozeInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (payload.duration !== undefined && typeof payload.duration !== 'string') {
    return { ok: false, message: "The 'duration' field must be a string." };
  }
  if (payload.deadline !== undefined && typeof payload.deadline !== 'string') {
    return { ok: false, message: "The 'deadline' field must be a string." };
  }
  return {
    ok: true,
    input: {
      duration: payload.duration,
      deadline: payload.deadline,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export async function tasksApi(root: string): Promise<ApiResponse> {
  const result = await listTasks(root);
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 200,
    body: {
      tasks: result.data.tasks,
      groups: result.data.groups,
      diagnostics: result.diagnostics,
    },
  };
}

export async function taskApi(
  root: string,
  taskId: string,
): Promise<ApiResponse> {
  const parsed = await parseWorkspace(root);
  const file = findFileById(parsed.files, 'task', taskId);
  if (file === null) {
    return apiFailure(404, [
      missingObjectDiagnostic(parsed.root, 'task', taskId),
    ]);
  }
  const view = taskView(parsed.root, file);
  if (view === null) {
    return apiFailure(
      422,
      unviewableTaskDiagnostics(parsed.root, taskId, file),
    );
  }
  return { status: 200, body: { task: view, diagnostics: parsed.diagnostics } };
}

export async function createTaskApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskCreatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const result = await createTask(root, {
    text: parsed.input.text,
    projects: parsed.input.projects,
    deadline: parsed.input.deadline,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 201,
    body: { task: result.data, diagnostics: result.diagnostics },
  };
}

export async function addOpenChatTaskApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskAddOpenChatPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const created = await createTask(root, {
    text: parsed.input.text,
    projects: parsed.input.projects,
    deadline: parsed.input.deadline,
  });
  if (!created.success || created.data === null) {
    return taskFailureResponse(root, null, created.diagnostics);
  }
  const task = created.data;
  const staged = await stageTaskInDraft(root, {
    taskId: task.id,
    draftId: parsed.input.draftId,
  });
  const diagnostics = [...created.diagnostics, ...staged.diagnostics];
  if (!staged.success || staged.data === null) {
    return {
      status: 201,
      body: { task, draft: null, diagnostics },
    };
  }
  return {
    status: 201,
    body: { task, draft: staged.data, diagnostics },
  };
}

export async function openTaskChatApi(
  root: string,
  taskId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskStagePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const result = await stageTaskInDraft(root, {
    taskId,
    draftId: parsed.input.draftId,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 200,
    body: { draft: result.data, diagnostics: result.diagnostics },
  };
}

export async function updateTaskApi(
  root: string,
  taskId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskUpdatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/tasks/:id');
  }
  const result = await updateTask(root, {
    taskId,
    title: parsed.input.title,
    body: parsed.input.body,
    projects: parsed.input.projects,
    deadline: parsed.input.deadline,
    expectedHash: parsed.input.expectedHash,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, taskId, result.diagnostics);
  }
  return {
    status: 200,
    body: { task: result.data, diagnostics: result.diagnostics },
  };
}

export async function doneTaskApi(
  root: string,
  taskId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskHashPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/tasks/:id');
  }
  const result = await completeTask(root, {
    taskId,
    expectedHash: parsed.input.expectedHash,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, taskId, result.diagnostics);
  }
  return {
    status: 200,
    body: { task: result.data, diagnostics: result.diagnostics },
  };
}

export async function reopenTaskApi(
  root: string,
  taskId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskHashPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/tasks/:id');
  }
  const result = await reopenTask(root, {
    taskId,
    expectedHash: parsed.input.expectedHash,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, taskId, result.diagnostics);
  }
  return {
    status: 200,
    body: { task: result.data, diagnostics: result.diagnostics },
  };
}

export async function snoozeTaskApi(
  root: string,
  taskId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseTaskSnoozePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/tasks/:id');
  }
  const result = await snoozeTask(root, {
    taskId,
    expectedHash: parsed.input.expectedHash,
    duration: parsed.input.duration,
    deadline: parsed.input.deadline,
  });
  if (!result.success || result.data === null) {
    return taskFailureResponse(root, taskId, result.diagnostics);
  }
  return {
    status: 200,
    body: { task: result.data, diagnostics: result.diagnostics },
  };
}

type TaskFailureStatus =
  'notFound' | 'conflict' | 'writeFailed' | 'backendFailed' | 'invalid';

const taskFailureStatusCodes: Record<TaskFailureStatus, number> = {
  notFound: 404,
  conflict: 409,
  writeFailed: 500,
  backendFailed: 502,
  invalid: 422,
};

function taskFailureStatusOf(diagnostics: Diagnostic[]): TaskFailureStatus {
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'task.missing' ||
        entry.code === 'project.missing' ||
        entry.code === 'draft.missing',
    )
  ) {
    return 'notFound';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'edit.stale_hash' ||
        entry.code === 'draft.stale_hash' ||
        entry.code === 'write.conflict' ||
        entry.code === 'id.duplicate' ||
        entry.code === 'operation.target_exists',
    )
  ) {
    return 'conflict';
  }
  if (diagnostics.some((entry) => entry.code.startsWith('backend.'))) {
    return 'backendFailed';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'write.failed' ||
        entry.code === 'file.unreadable' ||
        entry.code === 'draft.unreadable',
    )
  ) {
    return 'writeFailed';
  }
  return 'invalid';
}

async function taskFailureResponse(
  root: string,
  taskId: string | null,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const status = taskFailureStatusOf(diagnostics);
  const extra: Record<string, unknown> = {};
  if (status === 'conflict' && taskId !== null) {
    extra.currentHash = await currentTaskHash(root, taskId);
  }
  return apiFailure(taskFailureStatusCodes[status], diagnostics, extra);
}

async function currentTaskHash(
  root: string,
  taskId: string,
): Promise<string | null> {
  const parsed = await parseWorkspace(root);
  const file = findFileById(parsed.files, 'task', taskId);
  if (file === null) return null;
  const view = taskView(parsed.root, file);
  return view === null ? null : view.contentHash;
}

function unviewableTaskDiagnostics(
  root: string,
  taskId: string,
  file: ParsedWorkspaceFile,
): Diagnostic[] {
  const failures = file.diagnostics.filter(
    (entry) => entry.severity === 'error',
  );
  if (failures.length > 0) return failures;
  return [
    diagnostic(
      root,
      'operation.target_invalid',
      'error',
      `Task '${taskId}' could not be read as a task.`,
    ),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}
