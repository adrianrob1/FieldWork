import { readFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { stableIdSchema } from '../domain/schemas.js';
import type { AttachmentReference } from '../domain/transcript.js';
import { parseWorkspace } from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import { attachChat } from '../operations/attach.js';
import { detachChat } from '../operations/detach.js';
import { stageInDraft } from '../operations/drafts.js';
import { hashOf } from '../operations/edit.js';
import { continueChat } from '../operations/exchange.js';
import { findFileById } from '../operations/lookup.js';
import { promoteChat } from '../operations/promote.js';
import { startChat } from '../operations/start.js';
import {
  apiFailure,
  badRequest,
  chatDetailView,
  hashRequiredResponse,
  isContentHash,
  type ApiResponse,
} from './api.js';
import type { BackendCredentialStore } from './credentials.js';
import { createCancelSignal, createNdjsonTransport } from './ndjson.js';

export interface ChatCreateInput {
  title: string;
  id: string | undefined;
  topics: string[] | undefined;
  projects: string[] | undefined;
  message: string | undefined;
  at: string | undefined;
}

export interface ChatSendInput {
  message: string;
  backend: string | null;
  expectedHash: string | null;
  attachments: AttachmentReference[] | undefined;
}

export interface ChatMembershipInput {
  projectId: string;
  expectedHash: string | undefined;
}

export interface ChatPromoteInput {
  id: string;
  title: string;
  directory: string | undefined;
  expectedHash: string | undefined;
}

export interface ChatOpenChatInput {
  draftId: string | undefined;
}

export function chatIdFromTitle(
  title: string,
  existingIds: Iterable<string>,
): string {
  const taken = new Set(existingIds);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base =
    slug === ''
      ? 'chat'
      : stableIdSchema.safeParse(slug).success
        ? slug
        : `chat_${slug}`;
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function parseChatCreatePayload(
  payload: unknown,
): { ok: true; input: ChatCreateInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.title !== 'string') {
    return { ok: false, message: "The 'title' field must be a string." };
  }
  if (payload.id !== undefined && typeof payload.id !== 'string') {
    return { ok: false, message: "The 'id' field must be a string." };
  }
  if (payload.topics !== undefined && !Array.isArray(payload.topics)) {
    return { ok: false, message: "The 'topics' field must be an array." };
  }
  if (payload.projects !== undefined && !Array.isArray(payload.projects)) {
    return { ok: false, message: "The 'projects' field must be an array." };
  }
  if (payload.message !== undefined && typeof payload.message !== 'string') {
    return { ok: false, message: "The 'message' field must be a string." };
  }
  if (payload.at !== undefined && typeof payload.at !== 'string') {
    return { ok: false, message: "The 'at' field must be a string." };
  }
  return {
    ok: true,
    input: {
      title: payload.title,
      id: payload.id,
      topics: payload.topics,
      projects: payload.projects,
      message: payload.message,
      at: payload.at,
    },
  };
}

export function parseChatSendPayload(
  payload: unknown,
):
  | { ok: true; input: ChatSendInput }
  | { ok: false; message: string; code: 'attachment.invalid' | null } {
  if (!isRecord(payload)) {
    return {
      ok: false,
      message: 'The request body must be a JSON object.',
      code: null,
    };
  }
  if (typeof payload.message !== 'string') {
    return {
      ok: false,
      message: "The 'message' field must be a string.",
      code: null,
    };
  }
  if (
    payload.backend !== undefined &&
    payload.backend !== null &&
    typeof payload.backend !== 'string'
  ) {
    return {
      ok: false,
      message: "The 'backend' field must be a string.",
      code: null,
    };
  }
  const attachments = attachmentReferencesOf(payload.attachments);
  if (!attachments.ok) {
    return {
      ok: false,
      message: attachments.message,
      code: 'attachment.invalid',
    };
  }
  return {
    ok: true,
    input: {
      message: payload.message,
      backend: typeof payload.backend === 'string' ? payload.backend : null,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
      attachments: attachments.references,
    },
  };
}

function attachmentReferencesOf(
  value: unknown,
):
  | { ok: true; references: AttachmentReference[] | undefined }
  | { ok: false; message: string } {
  if (value === undefined) return { ok: true, references: undefined };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      message: "The 'attachments' field must be an array.",
    };
  }
  const references: AttachmentReference[] = [];
  for (const entry of value) {
    const reference = attachmentReferenceOf(entry);
    if (reference === null) {
      return {
        ok: false,
        message:
          "Each attachment reference must be an object with exactly one of 'id' or 'path'.",
      };
    }
    references.push(reference);
  }
  return { ok: true, references };
}

function attachmentReferenceOf(value: unknown): AttachmentReference | null {
  if (!isRecord(value)) return null;
  if (typeof value.id === 'string' && value.path === undefined) {
    return { id: value.id };
  }
  if (typeof value.path === 'string' && value.id === undefined) {
    return { path: value.path };
  }
  return null;
}

export function parseChatMembershipPayload(
  payload: unknown,
): { ok: true; input: ChatMembershipInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (
    typeof payload.projectId !== 'string' ||
    payload.projectId.trim() === ''
  ) {
    return { ok: false, message: "The 'projectId' field is required." };
  }
  return {
    ok: true,
    input: {
      projectId: payload.projectId,
      expectedHash:
        typeof payload.expectedHash === 'string'
          ? payload.expectedHash
          : undefined,
    },
  };
}

export function parseChatPromotePayload(
  payload: unknown,
): { ok: true; input: ChatPromoteInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.id !== 'string' || payload.id.trim() === '') {
    return { ok: false, message: "The 'id' field is required." };
  }
  if (typeof payload.title !== 'string' || payload.title.trim() === '') {
    return { ok: false, message: "The 'title' field is required." };
  }
  if (
    payload.directory !== undefined &&
    typeof payload.directory !== 'string'
  ) {
    return { ok: false, message: "The 'directory' field must be a string." };
  }
  return {
    ok: true,
    input: {
      id: payload.id,
      title: payload.title,
      directory: payload.directory,
      expectedHash:
        typeof payload.expectedHash === 'string'
          ? payload.expectedHash
          : undefined,
    },
  };
}

export function parseChatOpenChatPayload(
  payload: unknown,
): { ok: true; input: ChatOpenChatInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (payload.draftId !== undefined && typeof payload.draftId !== 'string') {
    return { ok: false, message: "The 'draftId' field must be a string." };
  }
  return { ok: true, input: { draftId: payload.draftId } };
}

export async function createChatApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseChatCreatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  let id = parsed.input.id;
  if (id === undefined) {
    const workspace = await parseWorkspace(root);
    const existing = workspace.files
      .filter((file) => file.kind === 'chat')
      .map((file) => file.metadata?.id)
      .filter((entry): entry is string => typeof entry === 'string');
    id = chatIdFromTitle(parsed.input.title, existing);
  }
  const result = await startChat(root, {
    id,
    title: parsed.input.title,
    topics: parsed.input.topics,
    projects: parsed.input.projects,
    message: parsed.input.message,
    at: parsed.input.at,
  });
  if (!result.success || result.data === null) {
    return chatFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 201,
    body: {
      chatId: result.data.chatId,
      title: result.data.title,
      file: canonicalPath(path.resolve(root), result.data.file),
      contentHash: await hashOfFile(result.data.file),
      diagnostics: result.diagnostics,
    },
  };
}

export async function sendChatMessageApi(
  root: string,
  chatId: string,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl?: string,
): Promise<ApiResponse> {
  const parsed = parseChatSendPayload(payload);
  if (!parsed.ok) {
    return parsed.code === 'attachment.invalid'
      ? attachmentInvalidResponse(root, parsed.message)
      : badRequest(parsed.message);
  }
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/chats/:id');
  }
  const result = await continueChat(
    root,
    {
      chatId,
      message: parsed.input.message,
      backend: parsed.input.backend ?? undefined,
      expectedHash: parsed.input.expectedHash ?? undefined,
      attachments: parsed.input.attachments,
      serverUrl,
    },
    {
      resolveBackendCredential: (backendName) =>
        credentials.getCredential(backendName),
    },
  );
  if (!result.success || result.data === null) {
    return chatFailureResponse(root, chatId, result.diagnostics);
  }
  return {
    status: 200,
    body: {
      chatId,
      file: canonicalPath(path.resolve(root), result.data.file),
      backend: result.data.backend,
      contentHash: await hashOfFile(result.data.file),
      exchange: {
        user: result.data.messages[0],
        assistant: result.data.messages[1],
      },
      diagnostics: result.diagnostics,
    },
  };
}

export async function streamChatMessageApi(
  root: string,
  chatId: string,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl: string | undefined,
  response: ServerResponse,
): Promise<ApiResponse | null> {
  const parsed = parseChatSendPayload(payload);
  if (!parsed.ok) {
    return parsed.code === 'attachment.invalid'
      ? attachmentInvalidResponse(root, parsed.message)
      : badRequest(parsed.message);
  }
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/chats/:id');
  }
  const transport = createNdjsonTransport(response);
  const signal = createCancelSignal(response);
  const result = await continueChat(
    root,
    {
      chatId,
      message: parsed.input.message,
      backend: parsed.input.backend ?? undefined,
      expectedHash: parsed.input.expectedHash ?? undefined,
      attachments: parsed.input.attachments,
      serverUrl,
      onStart: () => transport.start(),
      onDelta: (text, kind) => transport.delta(text, kind),
      signal,
    },
    {
      resolveBackendCredential: (backendName) =>
        credentials.getCredential(backendName),
    },
  );
  if (!result.success || result.data === null) {
    const failure = await chatFailureResponse(root, chatId, result.diagnostics);
    if (!transport.started) return failure;
    const body = failure.body as {
      error?: string;
      diagnostics?: Diagnostic[];
    };
    transport.error(
      failure.status,
      body.error ?? null,
      body.diagnostics ?? result.diagnostics,
    );
    transport.end();
    return null;
  }
  transport.done({
    chatId,
    file: canonicalPath(path.resolve(root), result.data.file),
    backend: result.data.backend,
    contentHash: await hashOfFile(result.data.file),
    exchange: {
      user: result.data.messages[0],
      assistant: result.data.messages[1],
    },
    diagnostics: result.diagnostics,
  });
  transport.end();
  return null;
}

export async function attachChatApi(
  root: string,
  chatId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseChatMembershipPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/chats/:id');
  }
  return membershipResponse(root, chatId, parsed.input, 'attach');
}

export async function detachChatApi(
  root: string,
  chatId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseChatMembershipPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/chats/:id');
  }
  return membershipResponse(root, chatId, parsed.input, 'detach');
}

export async function promoteChatApi(
  root: string,
  chatId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseChatPromotePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/chats/:id');
  }
  const result = await promoteChat(root, {
    chatId,
    id: parsed.input.id,
    title: parsed.input.title,
    directory: parsed.input.directory,
    expectedHash: parsed.input.expectedHash,
  });
  if (!result.success || result.data === null) {
    return chatFailureResponse(root, chatId, result.diagnostics);
  }
  const view = await chatDetailView(root, chatId);
  if (!view.ok) return apiFailure(500, view.diagnostics);
  const project = result.data.project;
  return {
    status: 200,
    body: {
      chat: view.data,
      project: {
        id: project.id,
        title: project.title,
        directory: project.directory,
        file: canonicalPath(path.resolve(root), project.file),
        repositories: project.repositories,
      },
      diagnostics: [...result.diagnostics, ...view.diagnostics],
    },
  };
}

// Stages an existing chat as an attachment in a created or updated draft and
// returns that draft's `/chats/new?draft=<id>` route. Mirrors the task
// open-chat endpoint; no chat field is written back onto the chat.
export async function openChatApi(
  root: string,
  chatId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseChatOpenChatPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const result = await stageInDraft(root, {
    attachable: { kind: 'chat', id: chatId },
    draftId: parsed.input.draftId,
  });
  if (!result.success || result.data === null) {
    return chatFailureResponse(root, chatId, result.diagnostics);
  }
  return {
    status: 200,
    body: { draft: result.data, diagnostics: result.diagnostics },
  };
}

async function membershipResponse(
  root: string,
  chatId: string,
  input: ChatMembershipInput,
  change: 'attach' | 'detach',
): Promise<ApiResponse> {
  const result =
    change === 'attach'
      ? await attachChat(root, { chatId, ...input })
      : await detachChat(root, { chatId, ...input });
  if (!result.success || result.data === null) {
    return chatFailureResponse(root, chatId, result.diagnostics);
  }
  return chatViewResponse(root, chatId, result.diagnostics);
}

async function chatViewResponse(
  root: string,
  chatId: string,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const view = await chatDetailView(root, chatId);
  if (!view.ok) return apiFailure(500, view.diagnostics);
  return {
    status: 200,
    body: { ...view.data, diagnostics: [...diagnostics, ...view.diagnostics] },
  };
}

type ChatFailureStatus = 'invalid' | 'conflict' | 'notFound' | 'backendFailed';

const chatFailureStatusCodes: Record<ChatFailureStatus, number> = {
  invalid: 422,
  conflict: 409,
  notFound: 404,
  backendFailed: 502,
};

function chatFailureStatusOf(diagnostics: Diagnostic[]): ChatFailureStatus {
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'chat.missing' ||
        entry.code === 'project.missing' ||
        entry.code === 'draft.missing',
    )
  ) {
    return 'notFound';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'write.conflict' ||
        entry.code === 'edit.stale_hash' ||
        entry.code === 'id.duplicate' ||
        entry.code === 'operation.target_exists',
    )
  ) {
    return 'conflict';
  }
  if (diagnostics.some((entry) => entry.code.startsWith('backend.'))) {
    return 'backendFailed';
  }
  if (diagnostics.some((entry) => entry.code.startsWith('attachment.'))) {
    return 'invalid';
  }
  return 'invalid';
}

async function chatFailureResponse(
  root: string,
  chatId: string | null,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const status = chatFailureStatusOf(diagnostics);
  const extra: Record<string, unknown> = {};
  if (status === 'conflict' && chatId !== null) {
    extra.currentHash = await currentChatHash(root, chatId);
  }
  return apiFailure(chatFailureStatusCodes[status], diagnostics, extra);
}

async function currentChatHash(
  root: string,
  chatId: string,
): Promise<string | null> {
  const parsed = await parseWorkspace(root);
  const chat = findFileById(parsed.files, 'chat', chatId);
  if (chat === null) return null;
  return hashOfFile(chat.file);
}

async function hashOfFile(file: string): Promise<string | null> {
  try {
    return hashOf(await readFile(file));
  } catch {
    return null;
  }
}

function attachmentInvalidResponse(root: string, message: string): ApiResponse {
  const entry = diagnostic(root, 'attachment.invalid', 'error', message, {
    fieldPath: 'attachments',
  });
  return { status: 400, body: { error: message, diagnostics: [entry] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
