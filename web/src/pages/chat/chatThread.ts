import type { ChatMessageView } from '../../shared/types.js';

// Pure transcript model for the chat page. Everything here is fetch-free so the
// windowing, metadata parsing, and scroll-anchor math can be unit tested; the
// React hook in useChatThread.ts wires these to the live API.

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ToolCallView {
  id: string;
  name: string;
  arguments: unknown;
  result: string | null;
}

export interface AttachmentView {
  id: string | null;
  path: string | null;
  kind: string;
  label: string;
  title: string | null;
}

export interface ChatMessage {
  index: number;
  role: ChatRole;
  text: string;
  ts: string | null;
  model: string | null;
  session: string | null;
  // Reasoning the backend streamed before the reply, recorded in the message
  // metadata; null means the assistant turn produced no recorded thought.
  thought: string | null;
  // null means the metadata carried no tool_calls key at all; [] means an
  // explicit empty list (rendered as "no tool calls").
  toolCalls: ToolCallView[] | null;
  attachments: AttachmentView[];
  metadata: Record<string, unknown> | null;
}

export interface ChatWindow {
  messages: ChatMessage[];
  hasEarlier: boolean;
  earlierCursor: string | null;
}

export interface ChatDetail extends ChatWindow {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  projects: string[];
  topics: string[];
  provider: string | null;
  model: string | null;
  links: string[];
  path: string;
  contentHash: string | null;
}

export interface ThreadState {
  messages: ChatMessage[];
  hasEarlier: boolean;
  earlierCursor: string | null;
  oldestLoadedIndex: number | null;
}

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
}

export interface ScrollAnchor {
  scrollTop: number;
  scrollHeight: number;
}

export interface ToolCallCapSummary {
  shown: string[];
  hiddenCount: number;
  text: string;
}

export const THREAD_PAGE_SIZE = 14;

// The mockup caps a tool list at first, …, last once it exceeds two entries.
export const TOOL_CALL_CAP = 2;

export function initialWindowState(): ThreadState {
  return {
    messages: [],
    hasEarlier: false,
    earlierCursor: null,
    oldestLoadedIndex: null,
  };
}

export function chatWindowRoute(chatId: string, before: string | null): string {
  const params = new URLSearchParams({ limit: String(THREAD_PAGE_SIZE) });
  if (before !== null) params.set('before', before);
  return `/api/chats/${encodeURIComponent(chatId)}?${params.toString()}`;
}

// The absolute transcript index of the first message in a window. The server
// reports `earlierCursor` as the start index of the window it just returned, so
// when more remains that value is the window's first index; otherwise the
// window reaches the beginning of the transcript and starts at zero.
export function windowBaseIndex(
  hasEarlier: boolean,
  earlierCursor: string | null,
): number {
  if (!hasEarlier || earlierCursor === null) return 0;
  const parsed = Number(earlierCursor);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function reduceInitialLoad(detail: ChatDetail): ThreadState {
  const messages = detail.messages;
  return {
    messages,
    hasEarlier: detail.hasEarlier,
    earlierCursor: detail.earlierCursor,
    oldestLoadedIndex: messages[0]?.index ?? null,
  };
}

export function reducePrepend(
  state: ThreadState,
  detail: ChatDetail,
): ThreadState {
  const messages = mergeMessages(detail.messages, state.messages);
  return {
    messages,
    hasEarlier: detail.hasEarlier,
    earlierCursor: detail.earlierCursor,
    oldestLoadedIndex: messages[0]?.index ?? null,
  };
}

// Dedupe by absolute index and keep ascending order, so a repeated prepend
// never duplicates a turn.
export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const byIndex = new Map<number, ChatMessage>();
  for (const message of existing) byIndex.set(message.index, message);
  for (const message of incoming) byIndex.set(message.index, message);
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

export function captureScrollAnchor(scroll: ScrollMetrics): ScrollAnchor {
  return { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight };
}

// "At bottom" for auto-stick is deliberately generous: anything within this
// many pixels of the maximum counts, so a rounded scroll position or a slightly
// grown composer still sticks.
export const THREAD_STICK_TOLERANCE = 48;

// A snapshot of the appendable content at one render. `firstIndex` distinguishes
// a prepend (older turns inserted above) from an append, so the Load-earlier
// anchor math is never fought by the auto-stick.
export interface ThreadAppendSnapshot {
  messageCount: number;
  firstIndex: number | null;
  lastIndex: number | null;
  streamLength: number;
}

export function threadAppendSnapshot(
  messages: readonly { index: number }[],
  streamLength: number,
): ThreadAppendSnapshot {
  return {
    messageCount: messages.length,
    firstIndex: messages[0]?.index ?? null,
    lastIndex: messages[messages.length - 1]?.index ?? null,
    streamLength,
  };
}

// The scroll state machine for the thread. Returns true when the viewport
// should jump to the bottom after this transition:
//   - a just-sent message always wins, even while scrolled up;
//   - a prepend (older turns inserted above) never sticks;
//   - an append or streaming growth sticks only when the reader was at bottom.
// `atBottom` must be the value captured before the DOM grew.
export function stickAfterAppend(
  prev: ThreadAppendSnapshot,
  next: ThreadAppendSnapshot,
  atBottom: boolean,
  justSent: boolean,
): boolean {
  if (justSent) return true;
  if (
    prev.firstIndex !== null &&
    next.firstIndex !== null &&
    next.firstIndex < prev.firstIndex
  ) {
    return false;
  }
  const appended =
    next.messageCount > prev.messageCount ||
    (prev.lastIndex !== null &&
      next.lastIndex !== null &&
      next.lastIndex > prev.lastIndex) ||
    next.streamLength > prev.streamLength;
  return appended && atBottom;
}

// Keep the same content at the top after older turns are inserted above it.
export function scrollTopAfterPrepend(
  anchor: ScrollAnchor,
  nextScrollHeight: number,
): number {
  const delta = nextScrollHeight - anchor.scrollHeight;
  const next = anchor.scrollTop + delta;
  return next < 0 ? 0 : next;
}

// The streaming bubble never grows past the thread viewport: its scrollable
// content is capped at the scroller's client height minus the bubble header,
// with a sane floor so a very short viewport still shows a usable bubble.
export const STREAM_BUBBLE_MIN_HEIGHT = 160;

export function streamBubbleMaxHeight(
  scrollerClientHeight: number,
  headerHeight: number,
): number {
  const available = scrollerClientHeight - headerHeight;
  return Math.max(
    STREAM_BUBBLE_MIN_HEIGHT,
    Number.isFinite(available) ? Math.round(available) : 0,
  );
}

export function toolCallCapSummary(
  names: readonly string[],
  cap: number = TOOL_CALL_CAP,
): ToolCallCapSummary {
  const clean = names.filter((name) => name !== '');
  const count = clean.length;
  if (count === 0) {
    return { shown: [], hiddenCount: 0, text: 'no tool calls' };
  }
  const label = `${String(count)} ${count === 1 ? 'tool call' : 'tool calls'}`;
  if (count <= cap) {
    return {
      shown: [...clean],
      hiddenCount: 0,
      text: `${label} · ${clean.join(', ')}`,
    };
  }
  const first = clean[0] ?? '';
  const last = clean[count - 1] ?? '';
  return {
    shown: [first, last],
    hiddenCount: count - 2,
    text: `${label} · ${first}, …, ${last}`,
  };
}

export function toolCallNames(message: ChatMessage): string[] {
  return (message.toolCalls ?? []).map((call) => call.name).filter(Boolean);
}

// The elapsed-time microcopy shown at the top of a streaming bubble. Whole
// seconds below a minute; minutes and seconds at or above 60s.
export function workingLabelFor(elapsedMs: number): string {
  const safe = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  const totalSeconds = Math.floor(safe / 1000);
  if (totalSeconds < 60) return `Working for ${String(totalSeconds)}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `Working for ${String(minutes)}m ${String(seconds)}s`;
}

export function formatMessageTime(ts: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(ts);
  if (match !== null && match[1] !== undefined && match[2] !== undefined) {
    return `${match[1]}:${match[2]}`;
  }
  return ts;
}

export function messageMetaParts(message: ChatMessage): string[] {
  const parts: string[] = [];
  if (message.ts !== null) parts.push(formatMessageTime(message.ts));
  if (message.model !== null) parts.push(message.model);
  if (message.session !== null) parts.push(`session ${message.session}`);
  return parts;
}

export function roleOf(role: string): ChatRole {
  if (role === 'user' || role === 'assistant' || role === 'system') {
    return role;
  }
  return 'system';
}

export function attachmentBadge(kind: string): string {
  if (kind === 'task') return 'TASK';
  if (kind === 'summary') return 'SUM';
  if (kind === 'chat') return 'CHAT';
  if (kind === 'resource') return 'MD';
  return 'FILE';
}

export function attachmentFallbackLabel(
  kind: string,
  id: string | null,
): string {
  if (kind !== '' && id !== null) return `${kind} ${id}`;
  if (id !== null) return id;
  if (kind !== '') return kind;
  return 'attachment';
}

export function timestampOf(
  metadata: Record<string, unknown> | null,
): string | null {
  if (metadata === null) return null;
  const at = metadata.at;
  if (typeof at === 'string') return at;
  if (at instanceof Date && !Number.isNaN(at.valueOf())) {
    return at.toISOString();
  }
  return null;
}

export function toolCallsOf(
  metadata: Record<string, unknown> | null,
): ToolCallView[] | null {
  if (metadata === null) return null;
  const raw = metadata.tool_calls;
  if (!Array.isArray(raw)) return null;
  const calls: ToolCallView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : '';
    if (name === '') continue;
    calls.push({
      id: typeof entry.id === 'string' ? entry.id : '',
      name,
      arguments: entry.arguments,
      result: typeof entry.result === 'string' ? entry.result : null,
    });
  }
  return calls;
}

export function attachmentsOf(
  metadata: Record<string, unknown> | null,
): AttachmentView[] {
  if (metadata === null) return [];
  const raw = metadata.attachments;
  if (!Array.isArray(raw)) return [];
  const attachments: AttachmentView[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : null;
    const path = typeof entry.path === 'string' ? entry.path : null;
    if (id === null && path === null) continue;
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    const title = typeof entry.title === 'string' ? entry.title : null;
    const label =
      typeof entry.label === 'string' && entry.label !== ''
        ? entry.label
        : (title ?? attachmentFallbackLabel(kind, id));
    attachments.push({ id, path, kind, label, title });
  }
  return attachments;
}

export function toChatMessage(
  message: ChatMessageView,
  index: number,
): ChatMessage {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  return {
    index,
    role: roleOf(message.role),
    text: message.text,
    ts: timestampOf(metadata),
    model: textFieldOf(metadata, 'model'),
    session: textFieldOf(metadata, 'session'),
    thought: textFieldOf(metadata, 'thought'),
    toolCalls: toolCallsOf(metadata),
    attachments: attachmentsOf(metadata),
    metadata,
  };
}

function toChatMessageAt(value: unknown, index: number): ChatMessage | null {
  if (!isRecord(value)) return null;
  const role = typeof value.role === 'string' ? value.role : 'system';
  const text = typeof value.text === 'string' ? value.text : '';
  const metadata = isRecord(value.metadata) ? value.metadata : null;
  return toChatMessage({ role, text, metadata }, index);
}

export function parseChatDetail(data: unknown): ChatDetail | null {
  if (!isRecord(data)) return null;
  const id = stringOrNull(data.id);
  if (id === null) return null;
  const hasEarlier = data.hasEarlier === true;
  const earlierCursor = stringOrNull(data.earlierCursor);
  const base = windowBaseIndex(hasEarlier, earlierCursor);
  const rawMessages = Array.isArray(data.messages) ? data.messages : [];
  const messages: ChatMessage[] = [];
  rawMessages.forEach((entry, offset) => {
    const message = toChatMessageAt(entry, base + offset);
    if (message !== null) messages.push(message);
  });
  return {
    id,
    title: stringOrNull(data.title) ?? '',
    created: stringOrNull(data.created),
    updated: stringOrNull(data.updated),
    projects: stringList(data.projects),
    topics: stringList(data.topics),
    provider: stringOrNull(data.provider),
    model: stringOrNull(data.model),
    links: stringList(data.links),
    path: stringOrNull(data.path) ?? '',
    contentHash: stringOrNull(data.contentHash),
    messages,
    hasEarlier,
    earlierCursor,
  };
}

function textFieldOf(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (metadata === null) return null;
  const value = metadata[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
