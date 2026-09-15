import { access, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { findBackend, resolveBackends } from '../backends/config.js';
import {
  createChatBackend,
  type ChatBackendOptions,
} from '../backends/create.js';
import type { NormalizedExchangeMessage } from '../backends/types.js';
import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { stableIdSchema } from '../domain/schemas.js';
import type { MessageMetadata } from '../domain/transcript.js';
import {
  createDraft,
  deleteDraft,
  draftFilePath,
  listDrafts as listStoredDrafts,
  loadDraft,
  markDraftConsumed,
  updateDraft,
  type DraftRecord,
} from '../files/draftStore.js';
import { serializeTranscript } from '../files/transcript.js';
import { parseWorkspace, workspaceAreaPaths } from '../files/workspace.js';
import { augmentBackendMessage } from './agentInstructions.js';
import {
  messageAttachments,
  resolveAttachmentReferences,
} from './attachments.js';
import { cancelledDiagnostic, isCancelled } from './cancel.js';
import { createCanonicalFile, hashOf } from './edit.js';
import { assistantMetadata, type ContinueChatHooks } from './exchange.js';
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
import { chatFileName, todayDate } from './start.js';

export interface DraftView {
  draft: DraftRecord;
  contentHash: string;
  route: string;
}

export interface StageTaskInDraftInput {
  taskId: string;
  draftId?: string | undefined;
}

export type AttachableKind = 'task' | 'chat';

export interface AttachableReference {
  kind: AttachableKind;
  id: string;
}

export interface StageInDraftInput {
  attachable: AttachableReference;
  draftId?: string | undefined;
}

export interface GetDraftInput {
  id: string;
}

export interface SubmitDraftInput {
  draftId: string;
  expectedHash: string;
  hooks?: ContinueChatHooks | undefined;
  serverUrl?: string | undefined;
  onChatCreated?: ((chat: DraftChatIdentity) => void) | undefined;
  onDelta?: ((text: string) => void) | undefined;
  // Aborted when the streaming HTTP client disconnects. The backend call is
  // cancelled and no chat file is created.
  signal?: AbortSignal | undefined;
}

export interface DraftChatIdentity {
  chatId: string;
  title: string;
  file: string;
}

export interface DraftExchangeMessage {
  role: 'user' | 'assistant';
  text: string;
  metadata: MessageMetadata;
}

export interface DraftSubmit {
  chat: {
    chatId: string;
    title: string;
    file: string;
    contentHash: string;
  };
  exchange: {
    user: DraftExchangeMessage;
    assistant: DraftExchangeMessage;
  };
  draftConsumed: boolean;
}

const titleCharacterLimit = 80;

export function draftRoute(draftId: string): string {
  return `/chats/new?draft=${draftId}`;
}

// Task staging keeps its own entry point; it delegates to the shared
// attachment stager so both tasks and chats land in a draft the same way.
export async function stageTaskInDraft(
  root: string,
  input: StageTaskInDraftInput,
): Promise<OperationResult<DraftView>> {
  return stageInDraft(root, {
    attachable: { kind: 'task', id: input.taskId },
    draftId: input.draftId,
  });
}

// Stages any attachable workspace object (a task or a chat) as a draft
// attachment. With no id it reuses the most recently updated reusable draft
// (unconsumed, no message text, no content attachments), falling back to a new
// draft; with an id it appends to (or dedupes against) that stored draft. The
// kind is validated against the file's real kind so a chat id cannot
// masquerade as a task.
export async function stageInDraft(
  root: string,
  input: StageInDraftInput,
): Promise<OperationResult<DraftView>> {
  const { kind, id } = input.attachable;
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, kindLabel(kind), id),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const parsed = await parseWorkspace(root);
  const file = findFileById(parsed.files, kind, id);
  if (file === null) {
    return operationFailed([missingObjectDiagnostic(root, kind, id)]);
  }

  if (input.draftId === undefined) {
    // Never mint a fresh draft when a stored one can absorb the attachment.
    // `listStoredDrafts` sorts most-recently-updated first, so the first
    // reusable entry wins.
    const listed = await listStoredDrafts(root);
    const reusable = listed.drafts.find((entry) =>
      isReusableDraftFor(entry.draft, id),
    );
    if (reusable !== undefined) {
      return stageIntoDraft(root, reusable.draft, reusable.contentHash, id);
    }
    const created = await createDraft(root, {
      message: '',
      attachments: [{ id }],
    });
    if (created.draft === null) {
      return operationFailed(created.diagnostics);
    }
    return operationOk(
      true,
      [],
      draftView(created.draft, created.contentHash),
      created.diagnostics,
    );
  }

  const loaded = await loadDraft(root, input.draftId);
  if (loaded.draft === null) {
    return operationFailed(loaded.diagnostics);
  }
  return stageIntoDraft(
    root,
    loaded.draft,
    loaded.contentHash,
    id,
    loaded.diagnostics,
  );
}

// A draft can absorb a newly staged attachment when it is unconsumed, has no
// message text, and carries no attachment other than the one being staged.
// Projects and backend picks alone do not count as content, so they do not
// block reuse; a draft that already holds only this attachable is reused so
// restaging the same object is idempotent.
function isReusableDraftFor(draft: DraftRecord, id: string): boolean {
  if (draft.consumed === true) return false;
  if (draft.message.trim().length > 0) return false;
  return draft.attachments.every((ref) => ref.id === id);
}

// Appends (or dedupes) one attachable into an already loaded draft.
async function stageIntoDraft(
  root: string,
  draft: DraftRecord,
  contentHash: string,
  id: string,
  diagnostics: Diagnostic[] = [],
): Promise<OperationResult<DraftView>> {
  if (draft.attachments.some((ref) => ref.id === id)) {
    return operationOk(false, [], draftView(draft, contentHash), diagnostics);
  }
  const updated = await updateDraft(root, {
    id: draft.id,
    expectedHash: contentHash,
    patch: {
      attachments: [...draft.attachments, { id }],
    },
  });
  if (updated.draft === null) {
    return operationFailed(updated.diagnostics);
  }
  return operationOk(
    true,
    [],
    draftView(updated.draft, updated.contentHash),
    updated.diagnostics,
  );
}

function kindLabel(kind: AttachableKind): string {
  return kind === 'chat' ? 'Chat ID' : 'Task ID';
}

export async function getDraft(
  root: string,
  input: GetDraftInput,
): Promise<OperationResult<DraftView>> {
  const loaded = await loadDraft(root, input.id);
  if (loaded.draft === null) {
    return operationFailed(loaded.diagnostics);
  }
  return operationOk(
    false,
    [],
    draftView(loaded.draft, loaded.contentHash),
    loaded.diagnostics,
  );
}

export async function listDrafts(
  root: string,
): Promise<OperationResult<DraftView[]>> {
  const listed = await listStoredDrafts(root);
  return operationOk(
    false,
    [],
    listed.drafts.map((entry) => draftView(entry.draft, entry.contentHash)),
    listed.diagnostics,
  );
}

export async function submitDraft(
  root: string,
  input: SubmitDraftInput,
): Promise<OperationResult<DraftSubmit>> {
  const draftFile = draftFilePath(root, input.draftId);
  const loaded = await loadDraft(root, input.draftId);
  if (loaded.draft === null) {
    return operationFailed(loaded.diagnostics);
  }
  const draft = loaded.draft;
  if (loaded.contentHash !== input.expectedHash) {
    return operationFailed([staleHashDiagnostic(draftFile)]);
  }

  const parsed = await parseWorkspace(root);
  await input.hooks?.afterWorkspaceParse?.(draftFile);

  if (draft.message.trim().length === 0) {
    return operationFailed([emptyMessageDiagnostic(draftFile)]);
  }

  const missingProjects = draft.projects
    .filter(
      (projectId) => findFileById(parsed.files, 'project', projectId) === null,
    )
    .map((projectId) => missingObjectDiagnostic(root, 'project', projectId));
  if (missingProjects.length > 0) {
    return operationFailed(missingProjects);
  }

  const settings =
    parsed.files.find((file) => file.kind === 'workspace') ?? null;
  const resolution = resolveBackends(
    settings?.file ?? path.join(root, 'workspace.yml'),
    settings?.metadata ?? null,
  );
  const lookup = findBackend(resolution, draft.backend);
  const backend = lookup.backend;
  if (backend === null) {
    return operationFailed([...resolution.diagnostics, ...lookup.diagnostics]);
  }

  const attachmentResolution = await resolveAttachmentReferences(
    root,
    parsed.files,
    draft.attachments,
  );
  if (
    attachmentResolution.diagnostics.some((entry) => entry.severity === 'error')
  ) {
    return operationFailed(attachmentResolution.diagnostics);
  }
  const resolvedAttachments = attachmentResolution.resolved;

  const title = titleFromMessage(draft.message);
  if (title === null) {
    return operationFailed([emptyMessageDiagnostic(draftFile)]);
  }
  const today = todayDate();
  const fileName = chatFileName(title, today);
  if (fileName === null) {
    return operationFailed([invalidTitleDiagnostic(root, title)]);
  }
  const areas = await workspaceAreaPaths(root);
  const chatFile = await dedupedChatFile(areas.chats, fileName);
  const chatId = chatIdFromTitle(title, existingChatIds(parsed.files));

  const messages: NormalizedExchangeMessage[] = [
    {
      role: 'user',
      text: augmentBackendMessage(draft.message, {
        attachments: resolvedAttachments,
        serverUrl: input.serverUrl,
      }),
    },
  ];
  const options: ChatBackendOptions = { cwd: root };
  const credential = input.hooks?.resolveBackendCredential?.(backend.name);
  if (credential !== undefined) {
    options.credential = credential;
  }
  if (input.onDelta !== undefined) {
    options.onDelta = input.onDelta;
  }
  options.signal = input.signal;
  input.onChatCreated?.({ chatId, title, file: chatFile });
  const sent = await createChatBackend(backend, options).send({ messages });
  if (!sent.ok) {
    return operationFailed([...resolution.diagnostics, ...sent.diagnostics]);
  }
  if (isCancelled(input.signal)) {
    return operationFailed([cancelledDiagnostic(draftFile, 'draft')]);
  }

  const timestamp = new Date().toISOString();
  const userMetadata: MessageMetadata = {
    at: timestamp,
    ...(resolvedAttachments.length > 0
      ? { attachments: messageAttachments(resolvedAttachments) }
      : {}),
  };
  const assistantMetadataRecord = assistantMetadata(
    sent.exchange,
    backend.name,
    timestamp,
  );
  const body = serializeTranscript('', [
    { role: 'user', text: draft.message, metadata: userMetadata },
    {
      role: 'assistant',
      text: sent.exchange.text,
      metadata: assistantMetadataRecord,
    },
  ]);

  const metadata: Record<string, unknown> = {
    id: chatId,
    title,
    created: today,
    updated: today,
  };
  if (draft.projects.length > 0) {
    metadata.projects = [...draft.projects];
  }

  await mkdir(areas.chats, { recursive: true });
  const created = await createCanonicalFile({
    file: chatFile,
    kind: 'chat',
    root,
    metadata,
    body,
  });
  if (!created.changed || hasError(created.diagnostics)) {
    return operationFailed(created.diagnostics);
  }

  let chatHash: string;
  try {
    chatHash = hashOf(await readFile(chatFile));
  } catch (error) {
    return operationFailed([unreadableDiagnostic(chatFile, error)], [chatFile]);
  }

  const refreshed = await refreshDiagnostics(root);

  const consumption = await consumeDraft(root, input.draftId, draftFile);

  return operationOk(
    true,
    [chatFile],
    {
      chat: { chatId, title, file: chatFile, contentHash: chatHash },
      exchange: {
        user: { role: 'user', text: draft.message, metadata: userMetadata },
        assistant: {
          role: 'assistant',
          text: sent.exchange.text,
          metadata: assistantMetadataRecord,
        },
      },
      draftConsumed: consumption.consumed,
    },
    [
      ...created.diagnostics,
      ...resolution.diagnostics,
      ...refreshed,
      ...consumption.diagnostics,
    ],
  );
}

function draftView(draft: DraftRecord, contentHash: string): DraftView {
  return { draft, contentHash, route: draftRoute(draft.id) };
}

function titleFromMessage(message: string): string | null {
  const firstLine = message.split('\n')[0] ?? '';
  const title = firstLine
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, titleCharacterLimit);
  return title.length > 0 ? title : null;
}

function chatIdFromTitle(title: string, existingIds: Iterable<string>): string {
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

function existingChatIds(
  files: readonly { kind: string; metadata: Record<string, unknown> | null }[],
): string[] {
  return files
    .filter((file) => file.kind === 'chat')
    .map((file) => file.metadata?.id)
    .filter((entry): entry is string => typeof entry === 'string');
}

async function dedupedChatFile(
  chatsDirectory: string,
  fileName: string,
): Promise<string> {
  const candidate = path.join(chatsDirectory, fileName);
  if (!(await fileExists(candidate))) return candidate;
  const stem = fileName.slice(0, -'.md'.length);
  let suffix = 2;
  while (await fileExists(path.join(chatsDirectory, `${stem}-${suffix}.md`))) {
    suffix += 1;
  }
  return path.join(chatsDirectory, `${stem}-${suffix}.md`);
}

async function consumeDraft(
  root: string,
  draftId: string,
  draftFile: string,
): Promise<{ consumed: boolean; diagnostics: Diagnostic[] }> {
  let deleted = false;
  let missing = false;
  try {
    const removed = await deleteDraft(root, draftId);
    deleted = removed.deleted;
    missing = removed.diagnostics.some(
      (entry) => entry.code === 'draft.missing',
    );
  } catch {
    deleted = false;
    missing = false;
  }
  if (deleted || missing) {
    return { consumed: true, diagnostics: [] };
  }
  const failed = {
    consumed: false,
    diagnostics: [
      diagnostic(
        draftFile,
        'draft.consumption_failed',
        'warning',
        'The chat was created, but the draft could not be deleted; it was marked consumed instead.',
      ),
    ],
  };
  try {
    await markDraftConsumed(root, draftId);
  } catch {
    return failed;
  }
  return failed;
}

function emptyMessageDiagnostic(draftFile: string): Diagnostic {
  return diagnostic(
    draftFile,
    'draft.empty_message',
    'error',
    'The draft has no message text to submit.',
  );
}

function staleHashDiagnostic(draftFile: string): Diagnostic {
  return diagnostic(
    draftFile,
    'draft.stale_hash',
    'error',
    'The draft changed since it was loaded; nothing was written.',
  );
}

function invalidTitleDiagnostic(root: string, title: string): Diagnostic {
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    `Chat title '${String(title)}' must be a non-empty string that yields a file name.`,
  );
}

function unreadableDiagnostic(file: string, error: unknown): Diagnostic {
  return diagnostic(
    file,
    'file.unreadable',
    'error',
    `Could not read file: ${error instanceof Error ? error.message : String(error)}`,
  );
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
