import type { NdjsonDeltaKind, NdjsonError } from '../../shared/ndjson.js';
import type { ComposerAttachment } from './chatComposer.js';

// Module-level handoff for a streaming draft submit. The submit request is
// owned by the new-chat screen, but the user is navigated to the chat route as
// soon as the server reports `created`. This registry lets the chat page render
// the provisional turn while the same request keeps appending deltas, then
// consume the finished entry and fall back to a normal transcript load.

export interface StreamEntry {
  chatId: string;
  title: string;
  // The user's submitted message, rendered as the pending user block.
  text: string;
  // The draft's staged attachments at submit time, rendered as chips on the
  // pending user block. Display-only: they never persist from here.
  attachments: readonly ComposerAttachment[];
  // The stored draft id, used for the back-to-draft path on a terminal error.
  draftId: string | null;
  // Assistant message deltas in arrival order; join for the growing bubble text.
  chunks: string[];
  // Ephemeral reasoning deltas in arrival order while streaming. The committed
  // exchange re-records the trace in the assistant message metadata, so these
  // copies are dropped when the entry is cleared.
  thoughts: string[];
  // null until the terminal `done` event arrives, then the result payload.
  done: unknown;
  error: NdjsonError | null;
  // Wall-clock time the stream began, anchoring the "Working for …" timer.
  startedAt: number;
  // Set once the owning submit exposes its transport handle, so the provisional
  // chat view can cancel the still-running draft submit.
  cancel: (() => void) | null;
  listeners: Set<() => void>;
}

export interface BeginStreamInput {
  chatId: string;
  title: string;
  text: string;
  attachments?: readonly ComposerAttachment[] | undefined;
  draftId: string | null;
}

const entries = new Map<string, StreamEntry>();

export function begin(input: BeginStreamInput): StreamEntry {
  const existing = entries.get(input.chatId);
  // A live entry owns the id; a terminal one (done or error) is replaced so a
  // retry of the same draft can stream into the same slug again.
  if (
    existing !== undefined &&
    existing.done === null &&
    existing.error === null
  ) {
    return existing;
  }
  const entry: StreamEntry = {
    chatId: input.chatId,
    title: input.title,
    text: input.text,
    attachments: input.attachments ?? [],
    draftId: input.draftId,
    chunks: [],
    thoughts: [],
    done: null,
    error: null,
    startedAt: Date.now(),
    cancel: null,
    listeners: new Set(),
  };
  entries.set(input.chatId, entry);
  return entry;
}

export function setCancel(chatId: string, cancel: () => void): void {
  const entry = entries.get(chatId);
  if (entry === undefined) return;
  entry.cancel = cancel;
}

export function append(
  chatId: string,
  delta: string,
  kind: NdjsonDeltaKind = 'message',
): void {
  const entry = entries.get(chatId);
  if (entry === undefined || entry.done !== null || entry.error !== null) {
    return;
  }
  if (kind === 'thought') {
    entry.thoughts.push(delta);
  } else {
    entry.chunks.push(delta);
  }
  notify(entry);
}

export function finish(chatId: string, result: unknown): void {
  const entry = entries.get(chatId);
  if (entry === undefined) return;
  entry.done = result;
  notify(entry);
}

export function fail(chatId: string, error: NdjsonError): void {
  const entry = entries.get(chatId);
  if (entry === undefined) return;
  entry.error = error;
  notify(entry);
}

export function subscribe(chatId: string, listener: () => void): () => void {
  const entry = entries.get(chatId);
  if (entry === undefined) return () => undefined;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}

export function get(chatId: string): StreamEntry | null {
  return entries.get(chatId) ?? null;
}

export function clear(chatId: string): void {
  entries.delete(chatId);
}

export function text(entry: StreamEntry): string {
  return entry.chunks.join('');
}

export function thought(entry: StreamEntry): string {
  return entry.thoughts.join('');
}

export function reset(): void {
  entries.clear();
}

function notify(entry: StreamEntry): void {
  for (const listener of [...entry.listeners]) listener();
}
