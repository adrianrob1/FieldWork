import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type {
  AttachmentReference,
  MessageMetadata,
  MessageRole,
} from '../domain/transcript.js';
import type { TranscriptMessage } from '../files/transcript.js';
import { parseTranscript } from '../files/transcript.js';
import { parseWorkspace } from '../files/workspace.js';
import { findBackend, resolveBackends } from '../backends/config.js';
import {
  createChatBackend,
  type ChatBackendOptions,
} from '../backends/create.js';
import type {
  BackendExchange,
  DeltaSink,
  NormalizedExchangeMessage,
} from '../backends/types.js';
import { augmentBackendMessage } from './agentInstructions.js';
import { cancelledDiagnostic, isCancelled } from './cancel.js';
import {
  messageAttachments,
  resolveAttachmentReferences,
  type ResolvedAttachment,
} from './attachments.js';
import type { WriteHooks } from './edit.js';
import {
  findFileById,
  invalidStableIdDiagnostic,
  missingObjectDiagnostic,
} from './lookup.js';
import { appendChatMessages, type AppendChatMessage } from './message.js';
import {
  operationFailed,
  operationOk,
  type OperationResult,
} from './result.js';

export interface ContinueChatInput {
  chatId: string;
  message: string;
  backend?: string | undefined;
  at?: string | undefined;
  expectedHash?: string | undefined;
  attachments?: AttachmentReference[] | undefined;
  serverUrl?: string | undefined;
  onStart?: (() => void) | undefined;
  onDelta?: DeltaSink | undefined;
  // Aborted when the streaming HTTP client disconnects. The backend call is
  // cancelled and the transcript write is skipped entirely.
  signal?: AbortSignal | undefined;
}

export interface ChatExchangeMessage {
  role: MessageRole;
  text: string;
  metadata: MessageMetadata | null;
}

export interface ChatExchange {
  chatId: string;
  file: string;
  backend: string;
  appendedCount: number;
  reply: string;
  messages: [ChatExchangeMessage, ChatExchangeMessage];
}

export interface ContinueChatHooks extends WriteHooks {
  afterWorkspaceParse?: ((file: string) => Promise<void>) | undefined;
  resolveBackendCredential?:
    ((backendName: string) => string | undefined) | undefined;
}

export async function continueChat(
  root: string,
  input: ContinueChatInput,
  hooks?: ContinueChatHooks,
): Promise<OperationResult<ChatExchange>> {
  const argumentDiagnostics = [
    invalidStableIdDiagnostic(root, 'Chat ID', input.chatId),
    emptyMessageDiagnostic(root, input.message),
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

  await hooks?.afterWorkspaceParse?.(chat.file);

  if (chat.contentHash === null) {
    return operationFailed(chat.diagnostics);
  }

  if (
    input.expectedHash !== undefined &&
    input.expectedHash !== chat.contentHash
  ) {
    return operationFailed([staleHashDiagnostic(chat.file)]);
  }

  let attachments: ResolvedAttachment[] = [];
  if (input.attachments !== undefined) {
    const attachmentResolution = await resolveAttachmentReferences(
      root,
      parsed.files,
      input.attachments,
    );
    if (
      attachmentResolution.diagnostics.some(
        (entry) => entry.severity === 'error',
      )
    ) {
      return operationFailed(attachmentResolution.diagnostics);
    }
    attachments = attachmentResolution.resolved;
  }

  const settings =
    parsed.files.find((file) => file.kind === 'workspace') ?? null;
  const resolution = resolveBackends(
    settings?.file ?? path.join(root, 'workspace.yml'),
    settings?.metadata ?? null,
  );
  const lookup = findBackend(resolution, input.backend);
  const backend = lookup.backend;
  if (backend === null) {
    return operationFailed([...resolution.diagnostics, ...lookup.diagnostics]);
  }

  const transcript = parseTranscript(chat.body ?? '', chat.file);
  const messages: NormalizedExchangeMessage[] = transcript.messages.map(
    (message) => ({ role: message.role, text: message.text }),
  );
  messages.push({
    role: 'user',
    text: augmentBackendMessage(input.message, {
      attachments,
      serverUrl: input.serverUrl,
    }),
  });

  const options: ChatBackendOptions = { cwd: root };
  if (backend.type === 'opencode' || backend.type === 'agent') {
    options.session = lastBackendSession(transcript.messages, backend.name);
  }
  const credential = hooks?.resolveBackendCredential?.(backend.name);
  if (credential !== undefined) {
    options.credential = credential;
  }
  if (input.onDelta !== undefined) {
    options.onDelta = input.onDelta;
  }
  options.signal = input.signal;
  input.onStart?.();
  const sent = await createChatBackend(backend, options).send({ messages });
  if (!sent.ok) {
    return operationFailed([...resolution.diagnostics, ...sent.diagnostics]);
  }
  if (isCancelled(input.signal)) {
    return operationFailed([cancelledDiagnostic(chat.file, 'chat')]);
  }

  const timestamp = input.at ?? new Date().toISOString();
  const userMetadata: MessageMetadata | null =
    attachments.length > 0
      ? { attachments: messageAttachments(attachments) }
      : null;
  const assistantMessageMetadata = assistantMetadata(
    sent.exchange,
    backend.name,
    timestamp,
  );
  const userMessage: AppendChatMessage =
    userMetadata === null
      ? { role: 'user', text: input.message }
      : {
          role: 'user',
          text: input.message,
          metadata: userMetadata,
        };
  const assistantMessage: AppendChatMessage = {
    role: 'assistant',
    text: sent.exchange.text,
    metadata: assistantMessageMetadata,
  };
  const appended = await appendChatMessages(
    root,
    {
      chatId: input.chatId,
      messages: [userMessage, assistantMessage],
      at: timestamp,
      expectedHash: input.expectedHash ?? chat.contentHash,
    },
    hooks,
  );
  if (!appended.success || appended.data === null) {
    return operationFailed(appended.diagnostics, appended.files);
  }

  return operationOk(
    appended.changed,
    appended.files,
    {
      chatId: input.chatId,
      file: appended.data.file,
      backend: backend.name,
      appendedCount: appended.data.roles.length,
      reply: sent.exchange.text,
      messages: [
        {
          role: 'user',
          text: input.message,
          metadata: userMetadata,
        },
        {
          role: 'assistant',
          text: sent.exchange.text,
          metadata: assistantMessageMetadata,
        },
      ],
    },
    [...appended.diagnostics, ...resolution.diagnostics],
  );
}

export function assistantMetadata(
  exchange: BackendExchange,
  backendName: string,
  timestamp: string,
): MessageMetadata {
  const metadata: MessageMetadata = {
    provider: exchange.provider ?? undefined,
    model: exchange.model ?? undefined,
    backend: backendName,
    at: timestamp,
  };
  if (exchange.backendSession !== null) {
    metadata.session = exchange.backendSession;
  }
  const thought = exchange.thought === null ? '' : exchange.thought.trim();
  if (thought.length > 0) {
    metadata.thought = thought;
  }
  if (exchange.toolCalls.length > 0) {
    metadata.tool_calls = exchange.toolCalls;
  }
  if (exchange.usage !== null) {
    metadata.usage = exchange.usage;
  }
  return metadata;
}

function lastBackendSession(
  messages: TranscriptMessage[],
  backendName: string,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const metadata = messages[index]?.metadata;
    if (
      metadata !== null &&
      metadata !== undefined &&
      metadata.backend === backendName &&
      typeof metadata.session === 'string'
    ) {
      return metadata.session;
    }
  }
  return undefined;
}

function emptyMessageDiagnostic(
  root: string,
  message: string,
): Diagnostic | null {
  if (typeof message === 'string' && message.trim().length > 0) return null;
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    `Message text '${String(message)}' must not be empty.`,
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
