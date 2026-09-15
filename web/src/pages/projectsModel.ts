import type { DiagnosticView } from '../shared/types.js';
import {
  repositoryName,
  type ChatListEntry,
  type OwnedFileEntry,
  type RepositoryEntry,
} from '../shared/projects/catalog.js';
import { relativeTime } from './workspaceModel.js';

export {
  repositoryName,
  toChatListEntries,
  toProjectDetail,
  toProjectListEntries,
} from '../shared/projects/catalog.js';
export type {
  ChatListEntry,
  InboundReferenceEntry,
  OwnedFileEntry,
  ProjectDetail,
  ProjectListEntry,
  ProjectResourceEntry,
  RepositoryEntry,
  RepositoryState,
  SummaryDocument,
} from '../shared/projects/catalog.js';

// "evon · live", "evon · missing", or "none" for an empty list. More than one
// repository keeps the first name and appends the remaining count.
export function repositoryStateLabel(
  repositories: readonly RepositoryEntry[],
): {
  text: string;
  className: string;
} {
  const first = repositories[0];
  if (first === undefined) return { text: 'none', className: '' };
  const state = first.state === 'live' ? 'live' : 'missing';
  const className = first.state === 'live' ? 'proj' : 'inbox';
  const extra =
    repositories.length > 1 ? ` +${String(repositories.length - 1)}` : '';
  return {
    text: `${repositoryName(first)} · ${state}${extra}`,
    className,
  };
}

// Workspace overview card meta: "repo evon" while the repository is present,
// "repo archived" once it goes missing. Null when the project has none.
export function projectRepoLabel(
  repositories: readonly RepositoryEntry[],
): string | null {
  const first = repositories[0];
  if (first === undefined) return null;
  return first.state === 'live'
    ? `repo ${repositoryName(first)}`
    : 'repo archived';
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

export function chatCountLabel(count: number): string {
  return `${String(count)} ${plural(count, 'chat')}`;
}

export function fileCountLabel(count: number): string {
  return `${String(count)} ${plural(count, 'file')}`;
}

// The mobile table card collapses to one meta line: "4 chats · 6 files · 09:30".
export function projectRowMeta(
  chatCount: number,
  fileCount: number,
  lastActivity: string | null,
  now: Date,
): string {
  const parts = [chatCountLabel(chatCount), fileCountLabel(fileCount)];
  if (lastActivity !== null && lastActivity !== '') {
    parts.push(relativeTime(lastActivity, now));
  }
  return parts.join(' · ');
}

export function ownedFilesTotalSize(files: readonly OwnedFileEntry[]): number {
  return files.reduce((total, file) => total + file.sizeBytes, 0);
}

export function chatDateOf(chat: ChatListEntry): string | null {
  return chat.updated ?? chat.created;
}

export interface NewProjectValues {
  title: string;
  directory: string;
  repositoryPath: string;
}

export type PayloadResult<T> =
  { ok: true; payload: T } | { ok: false; message: string };

export function newProjectPayload(
  values: NewProjectValues,
): PayloadResult<Record<string, unknown>> {
  const title = values.title.trim();
  const directory = values.directory.trim();
  if (title === '') return { ok: false, message: 'The title is required.' };
  if (directory === '') {
    return { ok: false, message: 'The directory is required.' };
  }
  const payload: Record<string, unknown> = { title, directory };
  const repositoryPath = values.repositoryPath.trim();
  if (repositoryPath !== '') {
    payload.repository = { path: repositoryPath };
  }
  return { ok: true, payload };
}

export interface RepositoryValues {
  path: string;
  id: string;
  title: string;
  remote: string;
}

export function repositoryPayload(
  values: RepositoryValues,
  expectedHash: string | null,
): PayloadResult<Record<string, unknown>> {
  const path = values.path.trim();
  if (path === '') {
    return { ok: false, message: 'The repository path is required.' };
  }
  if (expectedHash === null) {
    return { ok: false, message: 'The project must be reloaded first.' };
  }
  const payload: Record<string, unknown> = { path, expectedHash };
  if (values.id.trim() !== '') payload.id = values.id.trim();
  if (values.title.trim() !== '') payload.title = values.title.trim();
  if (values.remote.trim() !== '') payload.remote = values.remote.trim();
  return { ok: true, payload };
}

export interface ProjectFormErrors {
  title: string[];
  directory: string[];
  id: string[];
  repositoryPath: string[];
  unassigned: DiagnosticView[];
}

// Maps validation diagnostics to the fields the new-project and repository
// forms render. fieldPath is authoritative; when the server omits it the
// quoted field name in the message is used as a fallback.
export function projectFormErrorsOf(
  diagnostics: readonly DiagnosticView[],
): ProjectFormErrors {
  const errors: ProjectFormErrors = {
    title: [],
    directory: [],
    id: [],
    repositoryPath: [],
    unassigned: [],
  };
  for (const entry of diagnostics) {
    const field = formFieldOf(entry.fieldPath, entry.message);
    if (field === null) {
      errors.unassigned.push(entry);
      continue;
    }
    errors[field].push(entry.message);
  }
  return errors;
}

type FormField = 'title' | 'directory' | 'id' | 'repositoryPath';

function formFieldOf(
  fieldPath: string | null,
  message: string,
): FormField | null {
  const direct = directFieldOf(fieldPath);
  if (direct !== null) return direct;
  if (message.includes("'directory'") || /directory/.test(message)) {
    return 'directory';
  }
  if (message.includes("'title'")) return 'title';
  if (message.includes("'id'")) return 'id';
  if (/repositor/i.test(message)) return 'repositoryPath';
  return null;
}

function directFieldOf(fieldPath: string | null): FormField | null {
  if (fieldPath === null) return null;
  if (fieldPath === 'title') return 'title';
  if (fieldPath === 'directory' || fieldPath === 'path') return 'directory';
  if (fieldPath === 'id') return 'id';
  if (
    fieldPath.startsWith('repository') ||
    fieldPath.startsWith('repositories')
  ) {
    return 'repositoryPath';
  }
  return null;
}
