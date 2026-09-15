import type {
  BackendView,
  ChatMessageView,
  ChatView,
  DiagnosticView,
} from '../shared/types.js';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatTurn {
  id: string;
  role: ChatRole;
  text: string;
  meta: string | null;
  optimistic: boolean;
}

export interface SendPayload {
  message: string;
  backend?: string | undefined;
  expectedHash: string;
}

export interface SendResponseData {
  chatId: string;
  contentHash: string | null;
  exchange: {
    user: ChatMessageView;
    assistant: ChatMessageView;
  };
}

export type SendFailureKind =
  'conflict' | 'backend' | 'validation' | 'invalid' | 'missing' | 'network';

export interface SendFailure {
  kind: SendFailureKind;
  message: string;
  errorText: string | null;
  diagnostics: DiagnosticView[];
  needsSettings: boolean;
}

export function toTurns(messages: ChatMessageView[]): ChatTurn[] {
  return messages.map((message, index) => {
    const role = roleOf(message.role);
    return {
      id: `turn-${String(index)}`,
      role,
      text: message.text,
      meta:
        role === 'assistant' ? assistantMetaSummary(message.metadata) : null,
      optimistic: false,
    };
  });
}

export function pendingTurn(message: string): ChatTurn {
  return {
    id: 'turn-pending',
    role: 'user',
    text: message,
    meta: null,
    optimistic: true,
  };
}

export function assistantMetaSummary(
  metadata: Record<string, unknown> | null,
): string | null {
  if (metadata === null) return null;
  const parts: string[] = [];
  const provider =
    stringValueOf(metadata.provider) ?? stringValueOf(metadata.backend);
  if (provider !== undefined) parts.push(provider);
  const model = stringValueOf(metadata.model);
  if (model !== undefined) parts.push(model);
  const session = stringValueOf(metadata.session);
  if (session !== undefined) parts.push(`session ${session}`);
  return parts.length === 0 ? null : parts.join(' · ');
}

function stringValueOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function backendLabel(backend: BackendView): string {
  const model = backend.model === null ? '' : ` (${backend.model})`;
  return `${backend.name}${model}`;
}

export function buildSendPayload(
  message: string,
  backend: string | null,
  contentHash: string | null,
): { ok: true; payload: SendPayload } | { ok: false; reason: 'missing-hash' } {
  if (contentHash === null) return { ok: false, reason: 'missing-hash' };
  const payload: SendPayload = { message, expectedHash: contentHash };
  if (backend !== null) payload.backend = backend;
  return { ok: true, payload };
}

export function withExpectedHash(
  payload: Record<string, unknown>,
  contentHash: string | null,
):
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: 'missing-hash' } {
  if (contentHash === null) return { ok: false, reason: 'missing-hash' };
  return { ok: true, payload: { ...payload, expectedHash: contentHash } };
}

export function ingestSendResponse(
  chat: ChatView,
  response: SendResponseData,
): ChatView {
  return {
    ...chat,
    messages: [
      ...chat.messages,
      response.exchange.user,
      response.exchange.assistant,
    ],
    contentHash: response.contentHash,
  };
}

export function needsSettingsOf(diagnostics: DiagnosticView[]): boolean {
  return diagnostics.some((entry) => entry.code === 'backend.unconfigured');
}

export function classifySendFailure(
  status: number,
  diagnostics: DiagnosticView[],
  errorText: string | null,
): SendFailure {
  const needsSettings = needsSettingsOf(diagnostics);
  switch (status) {
    case 409:
      return {
        kind: 'conflict',
        message: 'The chat changed since it was loaded.',
        errorText,
        diagnostics,
        needsSettings: false,
      };
    case 502:
      return {
        kind: 'backend',
        message: 'The backend could not answer this message.',
        errorText,
        diagnostics,
        needsSettings,
      };
    case 422:
      return {
        kind: 'validation',
        message: 'The message was rejected.',
        errorText,
        diagnostics,
        needsSettings: false,
      };
    case 400:
      return {
        kind: 'invalid',
        message: 'The send request was not valid.',
        errorText,
        diagnostics,
        needsSettings,
      };
    case 404:
      return {
        kind: 'missing',
        message: 'This chat no longer exists in the workspace.',
        errorText,
        diagnostics,
        needsSettings: false,
      };
    default:
      return {
        kind: 'network',
        message: 'The request could not reach the server.',
        errorText,
        diagnostics,
        needsSettings: false,
      };
  }
}

function roleOf(role: string): ChatRole {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }
  return 'system';
}
