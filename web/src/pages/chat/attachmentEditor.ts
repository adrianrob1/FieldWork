import { isRecord } from './chatThread.js';

// Pure parsing for the markdown slide-over. The hook in useAttachmentEditor.ts
// owns the fetch/save lifecycle; these helpers keep the response shapes in one
// testable place.

export interface EditableFieldPolicy {
  field: string;
  type: string;
}

export interface EditableFile {
  kind: string;
  path: string;
  metadata: Record<string, unknown>;
  unknownKeys: string[];
  body: string;
  contentHash: string;
  editableFields: EditableFieldPolicy[];
}

export function parseEditableFile(data: unknown): EditableFile | null {
  if (!isRecord(data)) return null;
  const kind = typeof data.kind === 'string' ? data.kind : '';
  const path = typeof data.path === 'string' ? data.path : '';
  if (kind === '' || path === '') return null;
  const contentHash =
    typeof data.contentHash === 'string' ? data.contentHash : '';
  if (contentHash === '') return null;
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

export interface BodyEditResult {
  changed: boolean;
  contentHash: string | null;
}

export function parseBodyEditResult(data: unknown): BodyEditResult | null {
  if (!isRecord(data)) return null;
  return {
    changed: data.changed === true,
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
  };
}

export function editableTitleAllowed(file: EditableFile): boolean {
  return file.editableFields.some((policy) => policy.field === 'title');
}

export function unknownKeysText(
  metadata: Record<string, unknown>,
  unknownKeys: readonly string[],
): string {
  if (unknownKeys.length === 0) return 'none';
  return unknownKeys
    .map((key) => `${key}: ${renderValue(metadata[key])}`)
    .join(' · ');
}

export function shortHash(contentHash: string): string {
  if (contentHash.length <= 12) return contentHash;
  return `${contentHash.slice(0, 4)}…${contentHash.slice(-4)}`;
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json === undefined ? '[unserializable]' : json;
  } catch {
    return '[unserializable]';
  }
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
