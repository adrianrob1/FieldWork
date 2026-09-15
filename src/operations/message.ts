import { isScalar } from 'yaml';
import type { Document, ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  messageMetadataSchema,
  messageRoles,
  type MessageRole,
} from '../domain/transcript.js';
import {
  invalidMetadataDiagnostic,
  parseTranscript,
  serializeChatMessage,
} from '../files/transcript.js';
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
  type OperationResult,
} from './result.js';

export interface AppendChatMessage {
  role: MessageRole;
  text: string;
  metadata?: unknown;
}

export interface AppendChatMessageInput {
  chatId: string;
  message: AppendChatMessage;
  at?: string | undefined;
  expectedHash?: string | undefined;
}

export interface AppendChatMessagesInput {
  chatId: string;
  messages: AppendChatMessage[];
  at?: string | undefined;
  expectedHash?: string | undefined;
}

export interface ChatMessageAppend {
  chatId: string;
  file: string;
  role: MessageRole;
  messageCount: number;
}

export interface ChatMessagesAppend {
  chatId: string;
  file: string;
  messageCount: number;
  roles: MessageRole[];
}

export async function appendChatMessage(
  root: string,
  input: AppendChatMessageInput,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatMessageAppend>> {
  const result = await appendChatMessages(
    root,
    {
      chatId: input.chatId,
      messages: [input.message],
      at: input.at,
      expectedHash: input.expectedHash,
    },
    hooks,
  );
  if (result.success && result.data !== null) {
    return operationOk(
      result.changed,
      result.files,
      {
        chatId: result.data.chatId,
        file: result.data.file,
        role: input.message.role,
        messageCount: result.data.messageCount,
      },
      result.diagnostics,
    );
  }
  return operationFailed(result.diagnostics, result.files);
}

export async function appendChatMessages(
  root: string,
  input: AppendChatMessagesInput,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatMessagesAppend>> {
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Chat ID', input.chatId),
  ].filter((entry) => entry !== null);
  if (argumentDiagnostics.length > 0) {
    return operationFailed(argumentDiagnostics);
  }
  if (input.messages.length === 0) {
    return operationFailed([
      diagnostic(
        root,
        'operation.target_invalid',
        'error',
        'At least one message is required.',
      ),
    ]);
  }

  const parsed = await parseWorkspace(root);
  const chat = findFileById(parsed.files, 'chat', input.chatId);
  if (chat === null) {
    return operationFailed([
      missingObjectDiagnostic(root, 'chat', input.chatId),
    ]);
  }

  const messageDiagnostics = input.messages.flatMap((message) =>
    chatMessageDiagnostics(root, message),
  );
  if (messageDiagnostics.length > 0) {
    return operationFailed(messageDiagnostics);
  }

  const timestamp = input.at ?? new Date().toISOString();
  let messageCount = 0;
  const block = input.messages.map(serializeChatMessage).join('');
  const edited = await editCanonicalFile({
    file: chat.file,
    kind: 'chat',
    root,
    expectedHash: input.expectedHash,
    change: (document) => setUpdatedTimestamp(document, timestamp),
    body: (body) => {
      messageCount =
        parseTranscript(body, chat.file).messages.length +
        input.messages.length;
      return appendToBody(body, block);
    },
    hooks,
  });
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    return operationFailed(edited.diagnostics);
  }
  const diagnostics = edited.changed ? await refreshDiagnostics(root) : [];
  return operationOk(
    edited.changed,
    edited.changed ? [chat.file] : [],
    {
      chatId: input.chatId,
      file: chat.file,
      messageCount,
      roles: input.messages.map((message) => message.role),
    },
    [...edited.diagnostics, ...diagnostics],
  );
}

export function chatMessageDiagnostics(
  root: string,
  message: AppendChatMessage,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!messageRoles.includes(message.role)) {
    diagnostics.push(
      diagnostic(
        root,
        'transcript.role',
        'error',
        `Message role '${String(message.role)}' must be user, assistant, system, or tool.`,
      ),
    );
  }
  if (typeof message.text !== 'string') {
    diagnostics.push(
      diagnostic(
        root,
        'transcript.text',
        'error',
        'Message text must be a string.',
      ),
    );
  }
  if (message.metadata !== undefined) {
    const result = messageMetadataSchema.safeParse(message.metadata);
    if (!result.success) {
      const attachmentIssues = result.error.issues.filter(
        (issue) => issue.path[0] === 'attachments',
      );
      const otherIssues = result.error.issues.filter(
        (issue) => issue.path[0] !== 'attachments',
      );
      if (attachmentIssues.length > 0) {
        const first = attachmentIssues[0];
        diagnostics.push(
          diagnostic(
            root,
            'attachment.invalid',
            'error',
            `Message attachments are invalid: ${attachmentIssues.map((issue) => issue.message).join(' ')}`,
            {
              fieldPath:
                first !== undefined && first.path.length > 0
                  ? first.path.map(String).join('.')
                  : null,
            },
          ),
        );
      }
      if (otherIssues.length > 0) {
        diagnostics.push(invalidMetadataDiagnostic(root, otherIssues));
      }
    }
  }
  return diagnostics;
}

function setUpdatedTimestamp(
  document: Document.Parsed<ParsedNode>,
  timestamp: string,
): boolean {
  const current = document.get('updated', true);
  if (isScalar(current) && current.value === timestamp) return false;
  document.set('updated', timestamp);
  return true;
}

function appendToBody(body: string, block: string): string {
  if (body.length === 0) return block;
  if (body.endsWith('\n\n')) return body + block;
  if (body.endsWith('\n')) return `${body}\n${block}`;
  return `${body}\n\n${block}`;
}
