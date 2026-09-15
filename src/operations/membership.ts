import { isScalar, isSeq, type Document, type ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { parseWorkspace } from '../files/workspace.js';
import { editCanonicalFile, type WriteHooks } from './edit.js';
import {
  findFileById,
  invalidStableIdDiagnostic,
  missingObjectDiagnostic,
} from './lookup.js';
import { refreshDiagnostics } from './register.js';
import {
  operationFailed,
  operationOk,
  type ChatAttachment,
  type OperationResult,
} from './result.js';

export interface ChatProjectInput {
  chatId: string;
  projectId: string;
  expectedHash?: string | undefined;
}

export type MembershipChange = 'attach' | 'detach';

export function addProjectToDocument(
  document: Document.Parsed<ParsedNode>,
  projectId: string,
): boolean {
  const current = document.get('projects', true);
  if (isSeq(current)) {
    const present = current.items.some(
      (item) => isScalar(item) && item.value === projectId,
    );
    if (present) return false;
    current.add(document.createNode(projectId));
    return true;
  }
  if (current === undefined) {
    document.set('projects', [projectId]);
    return true;
  }
  document.set('projects', [projectId]);
  return true;
}

export function removeProjectFromDocument(
  document: Document.Parsed<ParsedNode>,
  projectId: string,
): boolean {
  const current = document.get('projects', true);
  if (!isSeq(current)) return false;
  const remaining = current.items.filter(
    (item) => !(isScalar(item) && item.value === projectId),
  );
  if (remaining.length === current.items.length) return false;
  if (remaining.length === 0) {
    document.delete('projects');
    return true;
  }
  current.items = remaining;
  return true;
}

export async function runMembershipChange(
  root: string,
  input: ChatProjectInput,
  change: MembershipChange,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatAttachment>> {
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Chat ID', input.chatId),
    invalidStableIdDiagnostic(root, 'Project ID', input.projectId),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const parsed = await parseWorkspace(root);
  const failures: Diagnostic[] = [];
  const chat = findFileById(parsed.files, 'chat', input.chatId);
  if (chat === null) {
    failures.push(missingObjectDiagnostic(root, 'chat', input.chatId));
  }
  const project = findFileById(parsed.files, 'project', input.projectId);
  if (project === null) {
    failures.push(missingObjectDiagnostic(root, 'project', input.projectId));
  }
  if (chat === null || project === null) {
    return operationFailed(failures);
  }

  if (chat.contentHash === null) {
    return operationFailed(chat.diagnostics);
  }
  if (
    input.expectedHash !== undefined &&
    input.expectedHash !== chat.contentHash
  ) {
    return operationFailed([staleHashDiagnostic(chat.file)]);
  }

  const edited = await editCanonicalFile({
    file: chat.file,
    kind: 'chat',
    root,
    expectedHash: input.expectedHash,
    change: (document) =>
      change === 'attach'
        ? addProjectToDocument(document, input.projectId)
        : removeProjectFromDocument(document, input.projectId),
    hooks,
  });
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    return operationFailed(edited.diagnostics);
  }
  const diagnostics = edited.changed ? await refreshDiagnostics(root) : [];
  return operationOk(
    edited.changed,
    edited.changed ? [chat.file] : [],
    { chatId: input.chatId, projectId: input.projectId },
    [...edited.diagnostics, ...diagnostics],
  );
}

function staleHashDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'edit.stale_hash',
    'error',
    'The chat changed since it was loaded; nothing was written.',
  );
}
