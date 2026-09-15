import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';
import { Document, parseDocument, type ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  attachmentReferenceSchema,
  type AttachmentReference,
} from '../domain/transcript.js';
import { hashOf, singleTrailingNewline } from '../operations/edit.js';

export interface DraftRecord {
  id: string;
  message: string;
  projects: string[];
  backend?: string;
  attachments: AttachmentReference[];
  created: string;
  updated: string;
  consumed?: boolean;
}

export interface DraftCreateInput {
  message?: string | undefined;
  projects?: string[] | undefined;
  backend?: string | undefined;
  attachments?: AttachmentReference[] | undefined;
}

export interface DraftPatch {
  message?: string | undefined;
  projects?: string[] | undefined;
  backend?: string | undefined;
  attachments?: AttachmentReference[] | undefined;
}

export interface DraftUpdateInput {
  id: string;
  expectedHash: string;
  patch: DraftPatch;
}

export type DraftOutcome =
  | { draft: DraftRecord; contentHash: string; diagnostics: Diagnostic[] }
  | { draft: null; contentHash: null; diagnostics: Diagnostic[] };

export interface DraftEntry {
  draft: DraftRecord;
  contentHash: string;
}

export interface DraftListOutcome {
  drafts: DraftEntry[];
  diagnostics: Diagnostic[];
}

export interface DraftDeleteOutcome {
  deleted: boolean;
  diagnostics: Diagnostic[];
}

const draftIdPattern = /^draft_[a-z0-9]{12}$/;
const draftFilePattern = /^draft_[a-z0-9]{12}\.yml$/;

export function isDraftId(id: string): boolean {
  return draftIdPattern.test(id);
}

export function draftFilePath(root: string, id: string): string {
  return path.join(path.resolve(root), '.workspace', 'drafts', `${id}.yml`);
}

export async function createDraft(
  root: string,
  input: DraftCreateInput,
): Promise<DraftOutcome> {
  const attachments = validAttachmentReferences(input.attachments ?? []);
  if (attachments === null) {
    return {
      draft: null,
      contentHash: null,
      diagnostics: [
        diagnostic(
          path.resolve(root),
          'draft.invalid',
          'error',
          'The draft attachments are invalid references.',
        ),
      ],
    };
  }
  let id = newDraftId();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (!(await fileExists(draftFilePath(root, id)))) break;
    id = newDraftId();
  }
  const file = draftFilePath(root, id);
  if (await fileExists(file)) {
    return {
      draft: null,
      contentHash: null,
      diagnostics: [
        diagnostic(
          file,
          'operation.target_exists',
          'error',
          'A draft already exists at this location; refusing to overwrite it.',
        ),
      ],
    };
  }
  const now = new Date().toISOString();
  const record: DraftRecord = {
    id,
    message: input.message ?? '',
    projects: [...(input.projects ?? [])],
    attachments,
    created: now,
    updated: now,
  };
  if (input.backend !== undefined) record.backend = input.backend;
  const source = singleTrailingNewline(String(newDraftDocument(record)));
  const failure = await writeDraftFile(file, source);
  if (failure !== null) {
    return { draft: null, contentHash: null, diagnostics: [failure] };
  }
  return {
    draft: record,
    contentHash: hashOf(Buffer.from(source, 'utf8')),
    diagnostics: [],
  };
}

export async function loadDraft(
  root: string,
  id: string,
): Promise<DraftOutcome> {
  const read = await readDraft(root, id);
  if (!read.ok) {
    if (read.consumed) await quietlyRemove(draftFilePath(root, id));
    return read.outcome;
  }
  return { draft: read.record, contentHash: read.contentHash, diagnostics: [] };
}

export async function listDrafts(root: string): Promise<DraftListOutcome> {
  const directory = path.join(path.resolve(root), '.workspace', 'drafts');
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return { drafts: [], diagnostics: [] };
  }
  const drafts: DraftEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!draftFilePattern.test(entry.name)) continue;
    const id = entry.name.slice(0, -'.yml'.length);
    const loaded = await loadDraft(root, id);
    if (loaded.draft !== null) {
      drafts.push({ draft: loaded.draft, contentHash: loaded.contentHash });
      continue;
    }
    if (!loaded.diagnostics.some((item) => item.code === 'draft.missing')) {
      diagnostics.push(...loaded.diagnostics);
    }
  }
  drafts.sort((left, right) =>
    left.draft.updated === right.draft.updated
      ? left.draft.id < right.draft.id
        ? -1
        : 1
      : left.draft.updated < right.draft.updated
        ? 1
        : -1,
  );
  return { drafts, diagnostics };
}

export async function updateDraft(
  root: string,
  input: DraftUpdateInput,
): Promise<DraftOutcome> {
  const read = await readDraft(root, input.id);
  if (!read.ok) {
    if (read.consumed) await quietlyRemove(draftFilePath(root, input.id));
    return read.outcome;
  }
  const file = draftFilePath(root, input.id);
  if (read.contentHash !== input.expectedHash) {
    return {
      draft: null,
      contentHash: null,
      diagnostics: [staleHashDiagnostic(file)],
    };
  }
  const patch = input.patch;
  const attachments =
    patch.attachments === undefined
      ? undefined
      : validAttachmentReferences(patch.attachments);
  if (attachments === null) {
    return {
      draft: null,
      contentHash: null,
      diagnostics: [
        diagnostic(
          file,
          'draft.invalid',
          'error',
          'The draft attachments are invalid references.',
        ),
      ],
    };
  }
  const now = new Date().toISOString();
  const record: DraftRecord = { ...read.record, updated: now };
  const document = read.document;
  if (patch.message !== undefined) {
    record.message = patch.message;
    document.set('message', patch.message);
  }
  if (patch.projects !== undefined) {
    record.projects = [...patch.projects];
    document.set('projects', [...patch.projects]);
  }
  if (patch.backend !== undefined) {
    record.backend = patch.backend;
    document.set('backend', patch.backend);
  }
  if (attachments !== undefined) {
    record.attachments = attachments;
    document.set('attachments', attachments);
  }
  document.set('updated', now);
  const source = singleTrailingNewline(String(document));
  const failure = await writeDraftFile(file, source);
  if (failure !== null) {
    return { draft: null, contentHash: null, diagnostics: [failure] };
  }
  return {
    draft: record,
    contentHash: hashOf(Buffer.from(source, 'utf8')),
    diagnostics: [],
  };
}

export async function deleteDraft(
  root: string,
  id: string,
): Promise<DraftDeleteOutcome> {
  if (!isDraftId(id)) {
    return { deleted: false, diagnostics: [missingDiagnostic(root, id)] };
  }
  const file = draftFilePath(root, id);
  try {
    await rm(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { deleted: false, diagnostics: [missingDiagnostic(root, id)] };
    }
    return {
      deleted: false,
      diagnostics: [
        diagnostic(
          file,
          'draft.delete_failed',
          'error',
          `The draft could not be deleted: ${errorMessage(error)}`,
        ),
      ],
    };
  }
  return { deleted: true, diagnostics: [] };
}

export async function markDraftConsumed(
  root: string,
  id: string,
): Promise<DraftOutcome> {
  const read = await readDraft(root, id);
  if (!read.ok) {
    if (read.consumed) await quietlyRemove(draftFilePath(root, id));
    return read.outcome;
  }
  const file = draftFilePath(root, id);
  read.document.set('consumed', true);
  const source = singleTrailingNewline(String(read.document));
  const failure = await writeDraftFile(file, source);
  if (failure !== null) {
    return { draft: null, contentHash: null, diagnostics: [failure] };
  }
  return {
    draft: { ...read.record, consumed: true },
    contentHash: hashOf(Buffer.from(source, 'utf8')),
    diagnostics: [],
  };
}

type DraftRead =
  | {
      ok: true;
      record: DraftRecord;
      contentHash: string;
      source: string;
      document: Document.Parsed<ParsedNode>;
    }
  | { ok: false; outcome: DraftOutcome; consumed: boolean };

async function readDraft(root: string, id: string): Promise<DraftRead> {
  if (!isDraftId(id)) {
    return { ok: false, outcome: missingOutcome(root, id), consumed: false };
  }
  const file = draftFilePath(root, id);
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, outcome: missingOutcome(root, id), consumed: false };
    }
    return {
      ok: false,
      outcome: unreadableOutcome(file, error),
      consumed: false,
    };
  }
  const source = raw.toString('utf8');
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return {
      ok: false,
      outcome: unreadableOutcome(file),
      consumed: false,
    };
  }
  const record = draftFromDocument(document.toJS(), id);
  if (record === null) {
    return {
      ok: false,
      outcome: {
        draft: null,
        contentHash: null,
        diagnostics: [invalidDiagnostic(file)],
      },
      consumed: false,
    };
  }
  if (record.consumed === true) {
    return {
      ok: false,
      outcome: missingOutcome(root, id),
      consumed: true,
    };
  }
  return { ok: true, record, contentHash: hashOf(raw), source, document };
}

function newDraftId(): string {
  return `draft_${randomBytes(6).toString('hex')}`;
}

function newDraftDocument(record: DraftRecord): Document {
  const value: Record<string, unknown> = {
    id: record.id,
    message: record.message,
    projects: record.projects,
  };
  if (record.backend !== undefined) value.backend = record.backend;
  value.attachments = record.attachments;
  value.created = record.created;
  value.updated = record.updated;
  return new Document(value);
}

function draftFromDocument(raw: unknown, id: string): DraftRecord | null {
  if (!isRecord(raw)) return null;
  if (raw.id !== id) return null;
  if (typeof raw.message !== 'string') return null;
  if (!isStringArray(raw.projects)) return null;
  if (raw.backend !== undefined && typeof raw.backend !== 'string') {
    return null;
  }
  if (!Array.isArray(raw.attachments)) return null;
  const attachments: AttachmentReference[] = [];
  for (const entry of raw.attachments) {
    const reference = cleanAttachmentReference(entry);
    if (reference === null) return null;
    attachments.push(reference);
  }
  if (typeof raw.created !== 'string') return null;
  if (typeof raw.updated !== 'string') return null;
  if (raw.consumed !== undefined && typeof raw.consumed !== 'boolean') {
    return null;
  }
  const record: DraftRecord = {
    id,
    message: raw.message,
    projects: raw.projects,
    attachments,
    created: raw.created,
    updated: raw.updated,
  };
  if (raw.backend !== undefined) record.backend = raw.backend;
  if (raw.consumed === true) record.consumed = true;
  return record;
}

function validAttachmentReferences(
  refs: readonly AttachmentReference[],
): AttachmentReference[] | null {
  const cleaned: AttachmentReference[] = [];
  for (const ref of refs) {
    const reference = cleanAttachmentReference(ref);
    if (reference === null) return null;
    cleaned.push(reference);
  }
  return cleaned;
}

function cleanAttachmentReference(raw: unknown): AttachmentReference | null {
  const parsed = attachmentReferenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const reference: AttachmentReference = {};
  if (parsed.data.id !== undefined) reference.id = parsed.data.id;
  if (parsed.data.path !== undefined) reference.path = parsed.data.path;
  return reference;
}

async function writeDraftFile(
  file: string,
  source: string,
): Promise<Diagnostic | null> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, source);
    return null;
  } catch (error) {
    return diagnostic(
      file,
      'write.failed',
      'error',
      `Could not write file: ${errorMessage(error)}`,
    );
  }
}

function missingDiagnostic(root: string, id: string): Diagnostic {
  return diagnostic(
    root,
    'draft.missing',
    'error',
    `Draft '${id}' was not found in this workspace.`,
  );
}

function missingOutcome(root: string, id: string): DraftOutcome {
  return {
    draft: null,
    contentHash: null,
    diagnostics: [missingDiagnostic(root, id)],
  };
}

function unreadableOutcome(file: string, error?: unknown): DraftOutcome {
  return {
    draft: null,
    contentHash: null,
    diagnostics: [
      diagnostic(
        file,
        'draft.unreadable',
        'error',
        error === undefined
          ? 'The draft file is not readable YAML.'
          : `The draft file could not be read: ${errorMessage(error)}`,
      ),
    ],
  };
}

function invalidDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'draft.invalid',
    'error',
    'The draft file does not match the draft record shape.',
  );
}

function staleHashDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'draft.stale_hash',
    'error',
    'The draft changed since it was loaded; nothing was written.',
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

async function quietlyRemove(file: string): Promise<void> {
  try {
    await rm(file, { force: true });
  } catch {
    return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
