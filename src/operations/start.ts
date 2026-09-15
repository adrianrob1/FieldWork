import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { serializeChatMessage } from '../files/transcript.js';
import { workspaceAreaPaths } from '../files/workspace.js';
import { createCanonicalFile } from './edit.js';
import { hasError, invalidStableIdDiagnostic } from './lookup.js';
import { chatMessageDiagnostics, type AppendChatMessage } from './message.js';
import { refreshDiagnostics } from './register.js';
import {
  operationFailed,
  operationOk,
  type OperationResult,
} from './result.js';

export interface StartChatInput {
  id: string;
  title: string;
  topics?: string[] | undefined;
  projects?: string[] | undefined;
  message?: string | undefined;
  at?: string | undefined;
}

export interface ChatStart {
  chatId: string;
  title: string;
  file: string;
}

export function chatTitleSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function todayDate(date: Date = new Date()): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function chatFileName(title: string, date: string): string | null {
  const slug = chatTitleSlug(title);
  if (slug.length === 0) return null;
  return `${date}-${slug}.md`;
}

export async function startChat(
  root: string,
  input: StartChatInput,
): Promise<OperationResult<ChatStart>> {
  const createdAt = input.at ?? todayDate();
  const fileName = chatFileName(input.title, createdAt.slice(0, 10));
  const message: AppendChatMessage | null =
    input.message === undefined ? null : { role: 'user', text: input.message };

  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Chat ID', input.id),
    fileName === null ? invalidTitleDiagnostic(root, input.title) : null,
    ...(message !== null ? chatMessageDiagnostics(root, message) : []),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0 || fileName === null) {
    return operationFailed(argumentDiagnostics);
  }

  const areas = await workspaceAreaPaths(root);
  const file = path.join(areas.chats, fileName);

  const metadata: Record<string, unknown> = {
    id: input.id,
    title: input.title,
    created: createdAt,
  };
  if (input.projects !== undefined && input.projects.length > 0) {
    metadata.projects = [...input.projects];
  }
  if (input.topics !== undefined && input.topics.length > 0) {
    metadata.topics = [...input.topics];
  }

  await mkdir(areas.chats, { recursive: true });
  const created = await createCanonicalFile({
    file,
    kind: 'chat',
    root,
    metadata,
    body:
      message === null
        ? undefined
        : serializeChatMessage({
            role: message.role,
            text: message.text,
          }),
  });
  if (!created.changed || hasError(created.diagnostics)) {
    return operationFailed(created.diagnostics);
  }
  const diagnostics = await refreshDiagnostics(root);
  return operationOk(
    true,
    [file],
    {
      chatId: input.id,
      title: input.title,
      file,
    },
    [...created.diagnostics, ...diagnostics],
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
