import {
  parseWorkspace,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import type { ApiResponse } from './api.js';

export interface TopicEntry {
  id: string;
  title: string;
  summary: string | null;
  path: string;
  updated: string | null;
  chatCount: number;
  objectCount: number;
}

export async function topicsApi(root: string): Promise<ApiResponse> {
  const parsed = await parseWorkspace(root);
  const topics = parsed.files
    .filter(
      (file) => file.kind === 'summary' && file.metadata?.kind === 'topic',
    )
    .map((file) => topicEntryOf(parsed.root, file, parsed.files))
    .sort((left, right) => compareText(left.id, right.id));
  return {
    status: 200,
    body: { topics, diagnostics: parsed.diagnostics },
  };
}

function topicEntryOf(
  root: string,
  file: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
): TopicEntry {
  const metadata = file.metadata ?? {};
  const id = typeof metadata.id === 'string' ? metadata.id : '';
  return {
    id,
    title: typeof metadata.title === 'string' ? metadata.title : '',
    summary: summaryOf(metadata, file.body),
    path: canonicalPath(root, file.file),
    updated:
      typeof metadata.updated === 'string'
        ? metadata.updated
        : typeof metadata.reviewed === 'string'
          ? metadata.reviewed
          : null,
    chatCount: files.filter(
      (candidate) =>
        candidate.kind === 'chat' && topicsOf(candidate).includes(id),
    ).length,
    objectCount: files.filter((candidate) => topicsOf(candidate).includes(id))
      .length,
  };
}

function summaryOf(
  metadata: Record<string, unknown>,
  body: string | null,
): string | null {
  if (typeof metadata.summary === 'string' && metadata.summary.length > 0) {
    return metadata.summary;
  }
  if (body === null) return null;
  const line = body
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line ?? null;
}

function topicsOf(file: ParsedWorkspaceFile): string[] {
  const topics = file.metadata?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.filter((entry): entry is string => typeof entry === 'string');
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
