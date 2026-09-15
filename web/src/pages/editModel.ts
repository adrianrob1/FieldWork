import { parseDiagnostics } from '../shared/responses.js';
import type { DiagnosticView } from '../shared/types.js';

// Pure editor logic for the /edit page. Fetch-free so the autosave decision,
// the stale-hash conflict handshake, title editability, and the status line can
// be unit tested; useEditPage.ts wires these to /api/file and /api/edit/*.

export interface EditableFieldPolicy {
  field: string;
  type: string;
}

export interface EditableFileView {
  kind: string;
  path: string;
  metadata: Record<string, unknown>;
  unknownKeys: string[];
  body: string;
  contentHash: string;
  editableFields: EditableFieldPolicy[];
}

export type EditorLoadStatus = 'loading' | 'ready' | 'error';

export interface EditorDoc {
  status: EditorLoadStatus;
  file: EditableFileView | null;
  body: string;
  savedBody: string;
  expectedHash: string | null;
  saving: boolean;
  conflictHash: string | null;
  errorText: string | null;
  savedAt: number | null;
}

export const initialEditorDoc: EditorDoc = {
  status: 'loading',
  file: null,
  body: '',
  savedBody: '',
  expectedHash: null,
  saving: false,
  conflictHash: null,
  errorText: null,
  savedAt: null,
};

export type EditorStatusKind =
  'loading' | 'error' | 'saving' | 'conflict' | 'unsaved' | 'autosaved';

export interface EditorStatusInput {
  status: EditorLoadStatus;
  saving: boolean;
  conflict: boolean;
  dirty: boolean;
  errorText: string | null;
}

export type ConflictAction =
  | { type: 'keep-editing' }
  | { type: 'reload'; body: string; contentHash: string };

export interface ConflictFields {
  body: string;
  savedBody: string;
  expectedHash: string | null;
  conflictHash: string | null;
}

export interface EditResult {
  changed: boolean;
  contentHash: string | null;
}

export interface EditLoadFailure {
  status: number;
  errorText: string | null;
  diagnostics: DiagnosticView[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseEditableFileView(data: unknown): EditableFileView | null {
  if (!isRecord(data)) return null;
  const kind = typeof data.kind === 'string' ? data.kind : '';
  const path = typeof data.path === 'string' ? data.path : '';
  const contentHash =
    typeof data.contentHash === 'string' ? data.contentHash : '';
  if (kind === '' || path === '' || contentHash === '') return null;
  return {
    kind,
    path,
    metadata: isRecord(data.metadata) ? data.metadata : {},
    unknownKeys: stringArray(data.unknownKeys),
    body: typeof data.body === 'string' ? data.body : '',
    contentHash,
    editableFields: editableFields(data.editableFields),
  };
}

export function parseEditResult(data: unknown): EditResult | null {
  if (!isRecord(data)) return null;
  return {
    changed: data.changed === true,
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
  };
}

export function editLoadFailure(
  status: number,
  body: unknown,
): EditLoadFailure {
  return {
    status,
    errorText: errorTextOf(body),
    diagnostics: parseDiagnostics(body),
  };
}

export function loadFailureMessage(failure: EditLoadFailure): string {
  return (
    failure.errorText ??
    failure.diagnostics.find((entry) => entry.severity === 'error')?.message ??
    'The file could not be read.'
  );
}

export function basenameOf(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments[segments.length - 1] ?? path;
}

export function fileTitle(file: EditableFileView): string {
  const title = file.metadata.title;
  if (typeof title === 'string' && title !== '') return title;
  return basenameOf(file.path);
}

export function titleEditable(file: EditableFileView): boolean {
  return file.editableFields.some((policy) => policy.field === 'title');
}

export function isDirty(doc: Pick<EditorDoc, 'body' | 'savedBody'>): boolean {
  return doc.body !== doc.savedBody;
}

export interface AutosaveInput {
  status: EditorLoadStatus;
  dirty: boolean;
  saving: boolean;
  expectedHash: string | null;
  conflict: boolean;
}

export function shouldAutosave(input: AutosaveInput): boolean {
  return (
    input.status === 'ready' &&
    input.dirty &&
    !input.saving &&
    !input.conflict &&
    input.expectedHash !== null
  );
}

export function editorStatusKind(input: EditorStatusInput): EditorStatusKind {
  if (input.status === 'loading') return 'loading';
  if (input.status === 'error') return 'error';
  if (input.saving) return 'saving';
  if (input.conflict) return 'conflict';
  if (input.dirty) return 'unsaved';
  return 'autosaved';
}

export function formatClock(ms: number): string {
  const date = new Date(ms);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function editorStatusText(
  kind: EditorStatusKind,
  savedAt: number | null,
  format: (ms: number) => string = formatClock,
): string {
  switch (kind) {
    case 'loading':
      return 'loading…';
    case 'error':
      return 'not saved';
    case 'saving':
      return 'saving…';
    case 'conflict':
      return 'conflict';
    case 'unsaved':
      return 'unsaved changes';
    case 'autosaved':
      return savedAt === null ? 'autosaved' : `autosaved ${format(savedAt)}`;
  }
}

export function reduceConflict<T extends ConflictFields>(
  state: T,
  action: ConflictAction,
): T {
  if (action.type === 'keep-editing') {
    return {
      ...state,
      expectedHash: state.conflictHash ?? state.expectedHash,
      conflictHash: null,
    };
  }
  return {
    ...state,
    body: action.body,
    savedBody: action.body,
    expectedHash: action.contentHash,
    conflictHash: null,
  };
}

function errorTextOf(body: unknown): string | null {
  if (isRecord(body) && typeof body.error === 'string') return body.error;
  return null;
}

function editableFields(value: unknown): EditableFieldPolicy[] {
  if (!Array.isArray(value)) return [];
  const fields: EditableFieldPolicy[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    if (typeof entry.field !== 'string') continue;
    fields.push({
      field: entry.field,
      type: typeof entry.type === 'string' ? entry.type : 'text',
    });
  }
  return fields;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
