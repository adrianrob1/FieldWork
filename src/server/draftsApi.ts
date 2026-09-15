import path from 'node:path';
import type { ServerResponse } from 'node:http';

import type { Diagnostic } from '../domain/diagnostics.js';
import type { AttachmentReference } from '../domain/transcript.js';
import {
  createDraft,
  deleteDraft,
  loadDraft,
  updateDraft,
  type DraftPatch,
  type DraftRecord,
} from '../files/draftStore.js';
import { canonicalPath } from '../index/rows.js';
import {
  draftRoute,
  getDraft,
  listDrafts,
  submitDraft,
} from '../operations/drafts.js';
import {
  apiFailure,
  badRequest,
  hashRequiredResponse,
  isContentHash,
  type ApiResponse,
} from './api.js';
import type { BackendCredentialStore } from './credentials.js';
import { createCancelSignal, createNdjsonTransport } from './ndjson.js';

export interface DraftView {
  draft: DraftRecord;
  contentHash: string;
  route: string;
}

export interface DraftCreatePayloadInput {
  message: string | undefined;
  projects: string[] | undefined;
  backend: string | undefined;
  attachments: AttachmentReference[] | undefined;
}

export interface DraftUpdatePayloadInput {
  expectedHash: string | null;
  patch: DraftPatch;
}

export interface DraftSubmitInput {
  expectedHash: string | null;
}

export function parseDraftCreatePayload(
  payload: unknown,
):
  | { ok: true; input: DraftCreatePayloadInput }
  | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (payload.message !== undefined && typeof payload.message !== 'string') {
    return { ok: false, message: "The 'message' field must be a string." };
  }
  if (payload.projects !== undefined && !isStringArray(payload.projects)) {
    return {
      ok: false,
      message: "The 'projects' field must be an array of strings.",
    };
  }
  if (payload.backend !== undefined && typeof payload.backend !== 'string') {
    return { ok: false, message: "The 'backend' field must be a string." };
  }
  let attachments: AttachmentReference[] | undefined;
  if (payload.attachments !== undefined) {
    const parsedAttachments = attachmentReferencesOf(payload.attachments);
    if (parsedAttachments === null) {
      return {
        ok: false,
        message:
          "The 'attachments' field must be an array of objects with an 'id' or 'path'.",
      };
    }
    attachments = parsedAttachments;
  }
  return {
    ok: true,
    input: {
      message: payload.message,
      projects: payload.projects,
      backend: payload.backend,
      attachments,
    },
  };
}

export function parseDraftUpdatePayload(payload: unknown):
  | {
      ok: true;
      input: DraftUpdatePayloadInput;
    }
  | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (!isRecord(payload.patch)) {
    return { ok: false, message: "The 'patch' field must be an object." };
  }
  const patch = payload.patch;
  if (patch.message !== undefined && typeof patch.message !== 'string') {
    return {
      ok: false,
      message: "The patch 'message' field must be a string.",
    };
  }
  if (patch.projects !== undefined && !isStringArray(patch.projects)) {
    return {
      ok: false,
      message: "The patch 'projects' field must be an array of strings.",
    };
  }
  if (patch.backend !== undefined && typeof patch.backend !== 'string') {
    return {
      ok: false,
      message: "The patch 'backend' field must be a string.",
    };
  }
  let attachments: AttachmentReference[] | undefined;
  if (patch.attachments !== undefined) {
    const parsedAttachments = attachmentReferencesOf(patch.attachments);
    if (parsedAttachments === null) {
      return {
        ok: false,
        message:
          "The patch 'attachments' field must be an array of objects with an 'id' or 'path'.",
      };
    }
    attachments = parsedAttachments;
  }
  return {
    ok: true,
    input: {
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
      patch: {
        message: patch.message,
        projects: patch.projects,
        backend: patch.backend,
        attachments,
      },
    },
  };
}

export function parseDraftSubmitPayload(
  payload: unknown,
): { ok: true; input: DraftSubmitInput } | { ok: false; message: string } {
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

export async function draftsApi(root: string): Promise<ApiResponse> {
  const result = await listDrafts(root);
  if (!result.success || result.data === null) {
    return draftFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 200,
    body: { drafts: result.data, diagnostics: result.diagnostics },
  };
}

export async function draftApi(
  root: string,
  draftId: string,
): Promise<ApiResponse> {
  const result = await getDraft(root, { id: draftId });
  if (!result.success || result.data === null) {
    return draftFailureResponse(root, draftId, result.diagnostics);
  }
  return {
    status: 200,
    body: { draft: result.data, diagnostics: result.diagnostics },
  };
}

export async function createDraftApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseDraftCreatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const result = await createDraft(root, {
    message: parsed.input.message,
    projects: parsed.input.projects,
    backend: parsed.input.backend,
    attachments: parsed.input.attachments,
  });
  if (result.draft === null || result.contentHash === null) {
    return draftFailureResponse(root, null, result.diagnostics);
  }
  return {
    status: 201,
    body: {
      draft: draftView(result.draft, result.contentHash),
      diagnostics: result.diagnostics,
    },
  };
}

export async function updateDraftApi(
  root: string,
  draftId: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseDraftUpdatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/drafts/:id');
  }
  const result = await updateDraft(root, {
    id: draftId,
    expectedHash: parsed.input.expectedHash,
    patch: parsed.input.patch,
  });
  if (result.draft === null || result.contentHash === null) {
    return draftFailureResponse(root, draftId, result.diagnostics);
  }
  return {
    status: 200,
    body: {
      draft: draftView(result.draft, result.contentHash),
      diagnostics: result.diagnostics,
    },
  };
}

export async function discardDraftApi(
  root: string,
  draftId: string,
): Promise<ApiResponse> {
  const result = await deleteDraft(root, draftId);
  if (!result.deleted) {
    return draftFailureResponse(root, draftId, result.diagnostics);
  }
  return {
    status: 200,
    body: { deleted: true, diagnostics: result.diagnostics },
  };
}

export async function submitDraftApi(
  root: string,
  draftId: string,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl?: string,
): Promise<ApiResponse> {
  const parsed = parseDraftSubmitPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/drafts/:id');
  }
  const result = await submitDraft(root, {
    draftId,
    expectedHash: parsed.input.expectedHash,
    serverUrl,
    hooks: {
      resolveBackendCredential: (backendName) =>
        credentials.getCredential(backendName),
    },
  });
  if (!result.success || result.data === null) {
    return draftFailureResponse(root, draftId, result.diagnostics);
  }
  return {
    status: 200,
    body: {
      chat: {
        chatId: result.data.chat.chatId,
        title: result.data.chat.title,
        file: canonicalPath(path.resolve(root), result.data.chat.file),
        contentHash: result.data.chat.contentHash,
      },
      exchange: result.data.exchange,
      draftConsumed: result.data.draftConsumed,
      diagnostics: result.diagnostics,
    },
  };
}

export async function streamSubmitDraftApi(
  root: string,
  draftId: string,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl: string | undefined,
  response: ServerResponse,
): Promise<ApiResponse | null> {
  const parsed = parseDraftSubmitPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/drafts/:id');
  }
  const transport = createNdjsonTransport(response);
  const signal = createCancelSignal(response);
  const result = await submitDraft(root, {
    draftId,
    expectedHash: parsed.input.expectedHash,
    serverUrl,
    signal,
    onChatCreated: (chat) => {
      transport.created({
        chatId: chat.chatId,
        title: chat.title,
        file: canonicalPath(path.resolve(root), chat.file),
        contentHash: null,
      });
    },
    onDelta: (text) => transport.delta(text),
    hooks: {
      resolveBackendCredential: (backendName) =>
        credentials.getCredential(backendName),
    },
  });
  if (!result.success || result.data === null) {
    const failure = await draftFailureResponse(
      root,
      draftId,
      result.diagnostics,
    );
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
    chat: {
      chatId: result.data.chat.chatId,
      title: result.data.chat.title,
      file: canonicalPath(path.resolve(root), result.data.chat.file),
      contentHash: result.data.chat.contentHash,
    },
    exchange: result.data.exchange,
    draftConsumed: result.data.draftConsumed,
    diagnostics: result.diagnostics,
  });
  transport.end();
  return null;
}

function draftView(draft: DraftRecord, contentHash: string): DraftView {
  return { draft, contentHash, route: draftRoute(draft.id) };
}

type DraftFailureStatus =
  'notFound' | 'conflict' | 'writeFailed' | 'backendFailed' | 'invalid';

const draftFailureStatusCodes: Record<DraftFailureStatus, number> = {
  notFound: 404,
  conflict: 409,
  writeFailed: 500,
  backendFailed: 502,
  invalid: 422,
};

function draftFailureStatusOf(diagnostics: Diagnostic[]): DraftFailureStatus {
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'draft.missing' ||
        entry.code === 'task.missing' ||
        entry.code === 'project.missing',
    )
  ) {
    return 'notFound';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'draft.stale_hash' ||
        entry.code === 'edit.stale_hash' ||
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
        entry.code === 'draft.delete_failed' ||
        entry.code === 'draft.unreadable' ||
        entry.code === 'file.unreadable',
    )
  ) {
    return 'writeFailed';
  }
  return 'invalid';
}

async function draftFailureResponse(
  root: string,
  draftId: string | null,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const status = draftFailureStatusOf(diagnostics);
  const extra: Record<string, unknown> = {};
  if (status === 'conflict' && draftId !== null) {
    extra.currentHash = await currentDraftHash(root, draftId);
  }
  return apiFailure(draftFailureStatusCodes[status], diagnostics, extra);
}

async function currentDraftHash(
  root: string,
  draftId: string,
): Promise<string | null> {
  const loaded = await loadDraft(root, draftId);
  return loaded.contentHash;
}

function attachmentReferencesOf(value: unknown): AttachmentReference[] | null {
  if (!Array.isArray(value)) return null;
  const references: AttachmentReference[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const reference: AttachmentReference = {};
    if (typeof entry.id === 'string') reference.id = entry.id;
    if (typeof entry.path === 'string') reference.path = entry.path;
    if (reference.id === undefined && reference.path === undefined) {
      return null;
    }
    references.push(reference);
  }
  return references;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}
