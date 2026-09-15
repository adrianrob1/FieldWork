import { parseWorkspace } from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import {
  badRequest,
  parseNonNegativeIntegerParam,
  type ApiResponse,
} from './api.js';

const attachableKinds = [
  'task',
  'resource',
  'summary',
  'chat',
  'project',
] as const;

export type AttachableKind = (typeof attachableKinds)[number];

export interface AttachableEntry {
  id: string;
  kind: AttachableKind;
  title: string;
  path: string;
  label: string;
}

export interface AttachablesViewData {
  attachables: AttachableEntry[];
  total: number;
  returned: number;
  limit: number;
  hasMore: boolean;
}

const defaultLimit = 100;
const maxLimit = 200;

export async function attachablesApi(
  root: string,
  query: URLSearchParams,
): Promise<ApiResponse> {
  const limitParam = parseNonNegativeIntegerParam(query, 'limit');
  if (!limitParam.ok) return badRequest(limitParam.message);
  const limit = limitParam.present
    ? Math.min(Math.max(limitParam.value, 1), maxLimit)
    : defaultLimit;
  const kinds = parseKindsParam(query);
  if (!kinds.ok) return badRequest(kinds.message);
  const q = query.get('q')?.trim().toLowerCase() ?? '';

  const parsed = await parseWorkspace(root);
  const entries = parsed.files
    .filter((file) =>
      (attachableKinds as readonly string[]).includes(file.kind),
    )
    .map((file) => attachableEntryOf(parsed.root, file))
    .filter((entry) => entry !== null)
    .filter((entry) => kinds.kinds === null || kinds.kinds.includes(entry.kind))
    .filter(
      (entry) =>
        q === '' ||
        entry.title.toLowerCase().includes(q) ||
        entry.id.toLowerCase().includes(q),
    )
    .sort(compareEntries);
  const returned = entries.slice(0, limit);
  return {
    status: 200,
    body: {
      attachables: returned,
      total: entries.length,
      returned: returned.length,
      limit,
      hasMore: entries.length > returned.length,
      diagnostics: parsed.diagnostics,
    },
  };
}

function parseKindsParam(
  query: URLSearchParams,
):
  | { ok: true; kinds: AttachableKind[] | null }
  | { ok: false; message: string } {
  const raw = query.get('kinds');
  if (raw === null || raw.trim() === '') return { ok: true, kinds: null };
  const kinds: AttachableKind[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') continue;
    if (!(attachableKinds as readonly string[]).includes(trimmed)) {
      return {
        ok: false,
        message: `The 'kinds' parameter accepts task, resource, summary, chat, and project.`,
      };
    }
    kinds.push(trimmed as AttachableKind);
  }
  return { ok: true, kinds: kinds.length === 0 ? null : kinds };
}

function attachableEntryOf(
  root: string,
  file: {
    kind: string;
    metadata: Record<string, unknown> | null;
    file: string;
  },
): AttachableEntry | null {
  const metadata = file.metadata ?? {};
  const id = typeof metadata.id === 'string' ? metadata.id : '';
  if (id === '') return null;
  const title = typeof metadata.title === 'string' ? metadata.title : id;
  return {
    id,
    kind: file.kind as AttachableKind,
    title,
    path: canonicalPath(root, file.file),
    label: title,
  };
}

function compareEntries(left: AttachableEntry, right: AttachableEntry): number {
  const kindGap =
    attachableKinds.indexOf(left.kind) - attachableKinds.indexOf(right.kind);
  if (kindGap !== 0) return kindGap;
  if (left.title !== right.title) {
    return left.title < right.title ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
