import { classifySendFailure, type SendFailure } from '../../chat/store.js';
import type { ChatMessageView, DiagnosticView } from '../../shared/types.js';
import { toChatMessage, type ChatMessage } from './chatThread.js';

// Pure composer model for the chat page. Everything here is fetch-free so the
// payload builder, send reducer, and scroll decisions can be unit tested; the
// React hook in useChatComposer.ts wires these to the live API.

// A context file staged in the composer. The server accepts either an id or a
// path, so exactly one of them is set for every staged entry.
export interface ComposerAttachment {
  key: string;
  id: string | null;
  path: string | null;
  label: string;
  kind: string;
}

export interface ComposerAttachmentRef {
  id?: string | undefined;
  path?: string | undefined;
}

export interface ComposerPayload {
  message: string;
  expectedHash: string;
  backend?: string | undefined;
  attachments?: ComposerAttachmentRef[] | undefined;
}

export interface ComposerBuildInput {
  message: string;
  backend: string | null;
  contentHash: string | null;
  attachments: readonly ComposerAttachment[];
}

export type ComposerBuild =
  | { ok: true; payload: ComposerPayload }
  | { ok: false; reason: 'missing-hash' };

export function attachmentRefOf(
  entry: ComposerAttachment,
): ComposerAttachmentRef {
  if (entry.id !== null) return { id: entry.id };
  if (entry.path !== null) return { path: entry.path };
  return { id: entry.key };
}

// The backend field is omitted unless a per-turn backend is selected, so the
// workspace default keeps owning the turn. Attachments are omitted when empty.
export function buildComposerPayload(input: ComposerBuildInput): ComposerBuild {
  if (input.contentHash === null) return { ok: false, reason: 'missing-hash' };
  const payload: ComposerPayload = {
    message: input.message,
    expectedHash: input.contentHash,
  };
  if (input.backend !== null) payload.backend = input.backend;
  if (input.attachments.length > 0) {
    payload.attachments = input.attachments.map(attachmentRefOf);
  }
  return { ok: true, payload };
}

// ————— send lifecycle —————

export type ComposerSendStatus =
  'idle' | 'sending' | 'applied' | 'conflict' | 'failed' | 'stopped';

export interface ComposerSendState {
  status: ComposerSendStatus;
  payload: ComposerPayload | null;
  failure: SendFailure | null;
}

export const idleComposerSend: ComposerSendState = {
  status: 'idle',
  payload: null,
  failure: null,
};

export type ComposerSendAction =
  | { type: 'send'; payload: ComposerPayload }
  | { type: 'applied' }
  | { type: 'conflict'; failure?: SendFailure | null }
  | { type: 'failed'; failure: SendFailure }
  | { type: 'stopped' }
  | { type: 'retry' }
  | { type: 'reset' };

// idle -> sending -> (applied | conflict | failed | stopped). A retry moves a
// terminal failure/conflict back to sending with the same payload. A stop drops
// the payload: the server wrote nothing, so there is nothing to retry.
export function composerSendReducer(
  state: ComposerSendState,
  action: ComposerSendAction,
): ComposerSendState {
  switch (action.type) {
    case 'send':
      return { status: 'sending', payload: action.payload, failure: null };
    case 'applied':
      return { status: 'applied', payload: null, failure: null };
    case 'stopped':
      return { status: 'stopped', payload: null, failure: null };
    case 'conflict':
      return {
        status: 'conflict',
        payload: state.payload,
        failure: action.failure ?? null,
      };
    case 'failed':
      return {
        status: 'failed',
        payload: state.payload,
        failure: action.failure,
      };
    case 'retry':
      if (state.payload === null) return state;
      return { status: 'sending', payload: state.payload, failure: null };
    case 'reset':
      return idleComposerSend;
  }
}

// After a self-abort there is no error to show; the composer instead restores
// the typed text when the input is still empty and notes the stop inline.
export function textToRestoreAfterStop(
  currentMessage: string,
  sentMessage: string,
): string | null {
  return currentMessage.trim() === '' ? sentMessage : null;
}

export function canRetrySend(state: ComposerSendState): boolean {
  return (
    state.payload !== null &&
    (state.status === 'failed' || state.status === 'conflict')
  );
}

export function emptyFailure(
  errorText: string | null,
  diagnostics: readonly DiagnosticView[] = [],
  status = 0,
): SendFailure {
  return classifySendFailure(status, [...diagnostics], errorText);
}

// ————— optimistic turns —————

export interface ComposerOptimistic {
  id: string;
  text: string;
  attachments: readonly ComposerAttachment[];
}

export function addOptimistic(
  list: readonly ComposerOptimistic[],
  entry: ComposerOptimistic,
): ComposerOptimistic[] {
  return [...list, entry];
}

// On success the pending entry is replaced by the committed exchange; on a
// backend failure or conflict the pending entry is dropped so the thread does
// not keep a turn the server never wrote.
export function resolveOptimistic(
  list: readonly ComposerOptimistic[],
  id: string,
): ComposerOptimistic[] {
  return list.filter((entry) => entry.id !== id);
}

export function exchangedMessages(
  exchange: { user: ChatMessageView; assistant: ChatMessageView },
  baseIndex: number,
): ChatMessage[] {
  return [
    toChatMessage(exchange.user, baseIndex),
    toChatMessage(exchange.assistant, baseIndex + 1),
  ];
}

export interface SendResponse {
  chatId: string | null;
  contentHash: string | null;
  exchange: { user: ChatMessageView; assistant: ChatMessageView };
}

export function parseSendResponse(data: unknown): SendResponse | null {
  if (!isRecord(data) || !isRecord(data.exchange)) return null;
  const user = toMessageView(data.exchange.user);
  const assistant = toMessageView(data.exchange.assistant);
  if (user === null || assistant === null) return null;
  return {
    chatId: typeof data.chatId === 'string' ? data.chatId : null,
    contentHash: typeof data.contentHash === 'string' ? data.contentHash : null,
    exchange: { user, assistant },
  };
}

export function parseContentHashResponse(data: unknown): string | null {
  if (!isRecord(data)) return null;
  return typeof data.contentHash === 'string' ? data.contentHash : null;
}

function toMessageView(value: unknown): ChatMessageView | null {
  if (!isRecord(value)) return null;
  if (typeof value.role !== 'string' || typeof value.text !== 'string') {
    return null;
  }
  return {
    role: value.role,
    text: value.text,
    metadata: isRecord(value.metadata) ? value.metadata : null,
  };
}

// ————— composer mechanics —————

export const COMPOSER_MINIMIZE_DISTANCE = 140;
export const COMPOSER_LATEST_PILL_DISTANCE = 260;

export interface ComposerVisibilityInput {
  distanceFromBottom: number;
  atBottom: boolean;
  focused: boolean;
}

// The composer collapses to one line while the reader is away from the newest
// turn, and restores at the bottom or when the textarea takes focus.
export function composerShouldMinimize(
  input: ComposerVisibilityInput,
): boolean {
  if (input.focused) return false;
  if (input.atBottom) return false;
  return input.distanceFromBottom > COMPOSER_MINIMIZE_DISTANCE;
}

export interface ScrollGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromBottom(geometry: ScrollGeometry): number {
  return Math.max(
    0,
    geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight,
  );
}

export function atBottom(geometry: ScrollGeometry, tolerance = 2): boolean {
  return distanceFromBottom(geometry) <= tolerance;
}

export function latestPillVisible(distance: number): boolean {
  return distance > COMPOSER_LATEST_PILL_DISTANCE;
}

export function stickyBarFromIntersection(state: {
  isIntersecting: boolean;
}): boolean {
  return !state.isIntersecting;
}

// ————— jump-to-latest —————

// Cubic ease-out, the same curve the mockup drives by hand. Monotonic across
// [0, 1] with f(0) = 0 and f(1) = 1.
export function jumpEase(progress: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  return 1 - Math.pow(1 - p, 3);
}

// Native smooth scrolling is canceled when the composer resizes mid-travel, so
// the jump is driven frame by frame with this duration.
export function jumpDuration(distance: number): number {
  return Math.min(620, Math.max(240, Math.abs(distance) * 0.32));
}

export function jumpTarget(geometry: ScrollGeometry): number {
  return Math.max(0, geometry.scrollHeight - geometry.clientHeight);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
