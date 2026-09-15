import type { Diagnostic } from '../domain/diagnostics.js';
import type { MessageRole, ToolCall } from '../domain/transcript.js';

export interface NormalizedExchangeMessage {
  role: MessageRole;
  text: string;
}

export interface NormalizedExchangeRequest {
  messages: NormalizedExchangeMessage[];
}

// A streamed delta is either committed assistant text ("message") or ephemeral
// reasoning ("thought"). Thoughts stay out of the assistant text; the backend
// records them separately in BackendExchange.thought so the UI can show the
// reasoning trace collapsed under the committed reply.
export type DeltaKind = 'message' | 'thought';

export type DeltaSink = (text: string, kind: DeltaKind) => void;

export interface BackendExchange {
  text: string;
  toolCalls: ToolCall[];
  model: string | null;
  provider: string | null;
  backendSession: string | null;
  usage: Record<string, unknown> | null;
  thought: string | null;
}

export type BackendSendResult =
  | { ok: true; exchange: BackendExchange }
  | { ok: false; diagnostics: Diagnostic[] };

export interface ChatBackend {
  id: string;
  type: 'openai' | 'opencode' | 'agent';
  send(request: NormalizedExchangeRequest): Promise<BackendSendResult>;
}
