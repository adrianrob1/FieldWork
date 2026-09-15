import { readFile, rm } from 'node:fs/promises';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { parseWorkspace } from '../files/workspace.js';
import {
  editCanonicalFile,
  type CanonicalWriteOutcome,
  hashOf,
  type WriteHooks,
} from './edit.js';
import {
  findFileById,
  invalidDirectoryDiagnostic,
  invalidStableIdDiagnostic,
  missingObjectDiagnostic,
} from './lookup.js';
import { addProjectToDocument } from './membership.js';
import { createProjectManifest, refreshDiagnostics } from './register.js';
import {
  operationFailed,
  operationOk,
  type ChatPromotion,
  type OperationResult,
} from './result.js';

export interface PromoteChatInput {
  chatId: string;
  id: string;
  title: string;
  directory?: string | undefined;
  expectedHash?: string | undefined;
}

export async function promoteChat(
  root: string,
  input: PromoteChatInput,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatPromotion>> {
  const directory = input.directory ?? input.id;
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Chat ID', input.chatId),
    invalidStableIdDiagnostic(root, 'Project ID', input.id),
    invalidDirectoryDiagnostic(root, directory),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }

  const parsed = await parseWorkspace(root);
  const chat = findFileById(parsed.files, 'chat', input.chatId);
  if (chat === null) {
    return operationFailed([
      missingObjectDiagnostic(root, 'chat', input.chatId),
    ]);
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

  const created = await createProjectManifest(root, {
    id: input.id,
    title: input.title,
    directory,
    repositoryPaths: [],
  });
  if (created.registration === null) {
    return operationFailed(created.diagnostics);
  }

  let manifestHash: string;
  try {
    manifestHash = hashOf(await readFile(created.registration.file));
  } catch (error) {
    return operationFailed(
      [
        diagnostic(
          created.registration.file,
          'file.unreadable',
          'error',
          `Could not read the newly created project manifest: ${errorMessage(error)}`,
        ),
      ],
      [created.registration.file],
    );
  }

  let edited: CanonicalWriteOutcome;
  try {
    edited = await editCanonicalFile({
      file: chat.file,
      kind: 'chat',
      root,
      expectedHash: input.expectedHash,
      change: (document) => addProjectToDocument(document, input.id),
      hooks,
    });
  } catch (error) {
    const rollback = await rollbackManifest(
      created.registration.file,
      manifestHash,
    );
    return operationFailed(
      [
        diagnostic(
          chat.file,
          'write.failed',
          'error',
          `Could not update chat: ${errorMessage(error)}`,
        ),
        ...(rollback === null ? [] : [rollback]),
      ],
      rollback === null ? [] : [created.registration.file],
    );
  }
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    const rollback = await rollbackManifest(
      created.registration.file,
      manifestHash,
    );
    return operationFailed(
      [...edited.diagnostics, ...(rollback === null ? [] : [rollback])],
      rollback === null ? [] : [created.registration.file],
    );
  }

  const files = [created.registration.file];
  if (edited.changed) files.push(chat.file);
  const diagnostics = await refreshDiagnostics(root);
  return operationOk(
    true,
    files,
    {
      chatId: input.chatId,
      project: created.registration,
    },
    diagnostics,
  );
}

async function rollbackManifest(
  file: string,
  expectedHash: string,
): Promise<Diagnostic | null> {
  try {
    const currentHash = hashOf(await readFile(file));
    if (currentHash !== expectedHash) {
      return diagnostic(
        file,
        'rollback.failed',
        'error',
        'The project manifest changed after promotion created it; refusing to remove it during rollback.',
      );
    }
    await rm(file);
    return null;
  } catch (error) {
    return diagnostic(
      file,
      'rollback.failed',
      'error',
      `Could not remove the project manifest after chat promotion failed: ${errorMessage(error)}`,
    );
  }
}

function staleHashDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'edit.stale_hash',
    'error',
    'The chat changed since it was loaded; nothing was written.',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
