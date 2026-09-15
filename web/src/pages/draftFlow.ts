import type { DiagnosticView } from '../shared/types.js';

// Pure draft state helpers. Everything here is fetch-free so the state machine
// can be unit tested; the React hook in useStoredDraft.ts wires these to the
// live API.

export interface DraftAttachmentRef {
  id?: string;
  path?: string;
}

export interface DraftRecordView {
  id: string;
  message: string;
  projects: string[];
  backend: string | null;
  attachments: DraftAttachmentRef[];
  created: string;
  updated: string;
  consumed: boolean;
}

export interface DraftEntry {
  draft: DraftRecordView;
  contentHash: string;
}

export interface DraftView {
  draft: DraftRecordView;
  contentHash: string | null;
}

// A draft attachment resolved to what the composer shows: a label and kind,
// never a file path.
export interface StagedAttachment {
  key: string;
  id: string | null;
  path: string | null;
  label: string;
  kind: string;
}

export interface AttachableView {
  id: string;
  kind: string;
  title: string;
  path: string;
  label: string;
}

export interface DraftFields {
  message: string;
  projects: string[];
  backend: string | null;
  attachments: StagedAttachment[];
}

export interface DraftPatch {
  message?: string;
  projects?: string[];
  backend?: string;
  attachments?: DraftAttachmentRef[];
}

export const untitledDraftLabel = 'Untitled draft';
export const emptyDraftPreview = "Write the first message when you're ready.";

export function emptyDraftFields(): DraftFields {
  return { message: '', projects: [], backend: null, attachments: [] };
}

export function fieldsOf(input: DraftFields): DraftFields {
  return {
    message: input.message,
    projects: [...input.projects],
    backend: input.backend,
    attachments: [...input.attachments],
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseAttachmentRef(value: unknown): DraftAttachmentRef | null {
  if (!isRecord(value)) return null;
  const ref: DraftAttachmentRef = {};
  if (typeof value.id === 'string') ref.id = value.id;
  if (typeof value.path === 'string') ref.path = value.path;
  if (ref.id === undefined && ref.path === undefined) return null;
  return ref;
}

function attachmentRefsOf(value: unknown): DraftAttachmentRef[] {
  if (!Array.isArray(value)) return [];
  const refs: DraftAttachmentRef[] = [];
  for (const entry of value) {
    const ref = parseAttachmentRef(entry);
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

export function parseDraftRecord(value: unknown): DraftRecordView | null {
  if (!isRecord(value)) return null;
  const id = stringOrNull(value.id);
  if (id === null) return null;
  if (typeof value.message !== 'string') return null;
  return {
    id,
    message: value.message,
    projects: stringList(value.projects),
    backend: stringOrNull(value.backend),
    attachments: attachmentRefsOf(value.attachments),
    created: stringOf(value.created),
    updated: stringOf(value.updated),
    consumed: value.consumed === true,
  };
}

// POST /api/drafts, POST /api/drafts/:id/update, and GET /api/drafts/:id all
// wrap the record in a view. The view may carry the record directly or nest it
// one level (DraftView); tolerate both.
export function parseDraftView(data: unknown): DraftView | null {
  if (!isRecord(data)) return null;
  const outer = data.draft;
  if (outer === undefined) return null;
  if (isRecord(outer) && outer.draft !== undefined) {
    const draft = parseDraftRecord(outer.draft);
    if (draft === null) return null;
    return { draft, contentHash: stringOrNull(outer.contentHash) };
  }
  const draft = parseDraftRecord(outer);
  if (draft === null) return null;
  return { draft, contentHash: stringOrNull(data.contentHash) };
}

export function parseDraftList(data: unknown): DraftEntry[] {
  if (!isRecord(data) || !Array.isArray(data.drafts)) return [];
  const list: unknown[] = data.drafts as unknown[];
  const entries: DraftEntry[] = [];
  for (const value of list) {
    const view = parseDraftView({ draft: value });
    if (view === null || view.contentHash === null) continue;
    entries.push({ draft: view.draft, contentHash: view.contentHash });
  }
  return entries;
}

export function parseAttachables(data: unknown): AttachableView[] {
  if (!isRecord(data) || !Array.isArray(data.attachables)) return [];
  const attachables: AttachableView[] = [];
  for (const value of data.attachables) {
    if (!isRecord(value)) continue;
    const id = stringOrNull(value.id);
    if (id === null) continue;
    const title = stringOrNull(value.title) ?? id;
    attachables.push({
      id,
      kind: stringOf(value.kind),
      title,
      path: stringOf(value.path),
      label: stringOrNull(value.label) ?? title,
    });
  }
  return attachables;
}

// ————— row presentation —————

export function firstLineTitle(message: string): string {
  const line = message.split(/\r?\n/, 1)[0] ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? untitledDraftLabel : collapsed;
}

export function draftRowPreview(message: string): string {
  if (message.trim() === '') return emptyDraftPreview;
  for (const raw of message.split(/\r?\n/)) {
    const collapsed = raw.replace(/\s+/g, ' ').trim();
    if (collapsed !== '') return collapsed;
  }
  return emptyDraftPreview;
}

// ————— attachment labels —————

function pathLabel(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

export function indexAttachables(
  attachables: readonly AttachableView[],
): Map<string, AttachableView> {
  const byId = new Map<string, AttachableView>();
  for (const attachable of attachables) byId.set(attachable.id, attachable);
  return byId;
}

export function stagedAttachmentOf(
  ref: DraftAttachmentRef,
  byId: ReadonlyMap<string, AttachableView>,
): StagedAttachment {
  const id = ref.id ?? null;
  const path = ref.path ?? null;
  const attachable = id === null ? undefined : byId.get(id);
  const label =
    attachable?.label ?? attachable?.title ?? id ?? pathLabel(path ?? '');
  const kind = attachable?.kind ?? '';
  return { key: id ?? path ?? label, id, path, label, kind };
}

export function stagedAttachmentsOf(
  refs: readonly DraftAttachmentRef[],
  attachables: readonly AttachableView[],
): StagedAttachment[] {
  const byId = indexAttachables(attachables);
  return refs.map((ref) => stagedAttachmentOf(ref, byId));
}

export function fieldsFromRecord(
  record: DraftRecordView,
  attachables: readonly AttachableView[],
): DraftFields {
  return {
    message: record.message,
    projects: [...record.projects],
    backend: record.backend,
    attachments: stagedAttachmentsOf(record.attachments, attachables),
  };
}

export function attachmentRefOf(staged: StagedAttachment): DraftAttachmentRef {
  if (staged.id !== null) return { id: staged.id };
  if (staged.path !== null) return { path: staged.path };
  return { id: staged.key };
}

export function attachmentRefsOfStaged(
  staged: readonly StagedAttachment[],
): DraftAttachmentRef[] {
  return staged.map((entry) => attachmentRefOf(entry));
}

export function addStagedAttachment(
  staged: readonly StagedAttachment[],
  attachable: AttachableView,
): StagedAttachment[] {
  if (staged.some((entry) => entry.id === attachable.id)) return [...staged];
  return [
    ...staged,
    {
      key: attachable.id,
      id: attachable.id,
      path: null,
      label: attachable.label,
      kind: attachable.kind,
    },
  ];
}

// ————— patch building —————

function attachmentSignatureOfStaged(
  staged: readonly StagedAttachment[],
): string {
  return staged
    .map((entry) =>
      entry.id !== null ? `id:${entry.id}` : `path:${entry.path ?? ''}`,
    )
    .join('\u0000');
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

// Only fields whose value actually changed are included, so the update request
// never rewrites untouched parts of the draft.
export function buildDraftPatch(
  previous: DraftFields,
  next: DraftFields,
): DraftPatch {
  const patch: DraftPatch = {};
  if (previous.message !== next.message) patch.message = next.message;
  if (!sameStringList(previous.projects, next.projects)) {
    patch.projects = [...next.projects];
  }
  // The API has no way to remove a backend, so only a new non-null backend is
  // worth sending; clearing back to the workspace default stays local.
  if (next.backend !== null && previous.backend !== next.backend) {
    patch.backend = next.backend;
  }
  if (
    attachmentSignatureOfStaged(previous.attachments) !==
    attachmentSignatureOfStaged(next.attachments)
  ) {
    patch.attachments = attachmentRefsOfStaged(next.attachments);
  }
  return patch;
}

export function isEmptyPatch(patch: DraftPatch): boolean {
  return (
    patch.message === undefined &&
    patch.projects === undefined &&
    patch.backend === undefined &&
    patch.attachments === undefined
  );
}

export interface PendingDraftSave {
  draftId: string;
  expectedHash: string;
  patch: DraftPatch;
}

// A save is pending when a stored draft exists with a known hash and the live
// fields differ from the last synced fields. Both the debounced autosave and
// its unmount flush use this to decide whether anything must be sent.
export function pendingDraftSave(input: {
  draftId: string | null;
  contentHash: string | null;
  synced: DraftFields;
  current: DraftFields;
}): PendingDraftSave | null {
  if (input.draftId === null || input.contentHash === null) return null;
  const patch = buildDraftPatch(input.synced, input.current);
  if (isEmptyPatch(patch)) return null;
  return { draftId: input.draftId, expectedHash: input.contentHash, patch };
}

export function createPayloadOf(fields: DraftFields): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message: fields.message,
    projects: [...fields.projects],
    attachments: attachmentRefsOfStaged(fields.attachments),
  };
  if (fields.backend !== null) payload.backend = fields.backend;
  return payload;
}

export function updatePayloadOf(
  expectedHash: string,
  patch: DraftPatch,
): Record<string, unknown> {
  return { expectedHash, patch };
}

// Sending always requires message text: the server rejects a draft whose
// message is empty (422 "The draft has no message text to submit."), so both
// the send button and the Enter path are disabled while the trimmed text is
// empty, even when attachments are staged.
export function hasMessageText(message: string): boolean {
  return message.trim() !== '';
}

export function hasDraftContent(fields: DraftFields): boolean {
  return (
    fields.message.trim() !== '' ||
    fields.projects.length > 0 ||
    fields.backend !== null ||
    fields.attachments.length > 0
  );
}

// ————— resume decision —————

export type ResumeDecision =
  | { kind: 'open-param'; draftId: string }
  | { kind: 'resume-recent'; draftId: string }
  | { kind: 'fresh' };

export function mostRecentDraft(
  entries: readonly DraftEntry[],
): DraftEntry | null {
  const active = entries.filter((entry) => !entry.draft.consumed);
  if (active.length === 0) return null;
  const sorted = [...active].sort((left, right) => {
    if (left.draft.updated === right.draft.updated) {
      return left.draft.id < right.draft.id ? -1 : 1;
    }
    return left.draft.updated < right.draft.updated ? 1 : -1;
  });
  return sorted[0] ?? null;
}

// A draft can be adopted by the composer instead of minting a fresh one when it
// has no message text and no attachments. Project and backend picks alone do
// not count as content, so they do not block reuse; the typed compose state is
// patched into the adopted draft afterwards.
export function isReusableDraft(record: DraftRecordView): boolean {
  return (
    !record.consumed &&
    record.message.trim() === '' &&
    record.attachments.length === 0
  );
}

// The most recently updated reusable draft, or null when none exists.
export function pickReusableDraft(
  entries: readonly DraftEntry[],
): DraftEntry | null {
  return mostRecentDraft(
    entries.filter((entry) => isReusableDraft(entry.draft)),
  );
}

// A `draft` query param always wins; otherwise the most recently updated stored
// draft is resumed; otherwise the composer starts empty and creates lazily.
export function resumeDecision(
  paramDraftId: string | null,
  entries: readonly DraftEntry[],
): ResumeDecision {
  if (paramDraftId !== null && paramDraftId !== '') {
    return { kind: 'open-param', draftId: paramDraftId };
  }
  const recent = mostRecentDraft(entries);
  if (recent !== null) {
    return { kind: 'resume-recent', draftId: recent.draft.id };
  }
  return { kind: 'fresh' };
}

// ————— submit transitions —————

export type SubmitStatus = 'idle' | 'sending' | 'done' | 'failed';

export interface SubmitState {
  status: SubmitStatus;
  errorText: string | null;
  diagnostics: DiagnosticView[];
}

export const idleSubmit: SubmitState = {
  status: 'idle',
  errorText: null,
  diagnostics: [],
};

export function submitStarted(): SubmitState {
  return { status: 'sending', errorText: null, diagnostics: [] };
}

export function submitSucceeded(): SubmitState {
  return { status: 'done', errorText: null, diagnostics: [] };
}

export function submitFailed(failure: {
  errorText: string | null;
  diagnostics: DiagnosticView[];
}): SubmitState {
  return {
    status: 'failed',
    errorText: failure.errorText,
    diagnostics: failure.diagnostics,
  };
}

export function chatIdOfSubmit(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.chat)) return null;
  return stringOrNull(data.chat.chatId);
}
