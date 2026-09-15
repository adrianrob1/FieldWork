import { parseDiagnostics } from './responses.js';
import type { DiagnosticView } from './types.js';

// Wire types for the server's `application/x-ndjson` streaming replies. They
// mirror src/server/ndjson.ts but live here so the web bundle never imports
// server code. The parser below turns a byte stream into these events and, if
// the stream closes without a terminal, reports it as broken.

export type NdjsonDeltaKind = 'message' | 'thought';

export interface NdjsonDelta {
  type: 'delta';
  text: string;
  // Absent on the wire means "message"; old servers never send "thought".
  kind: NdjsonDeltaKind;
}

export interface NdjsonCreated {
  type: 'created';
  chat: unknown;
}

export interface NdjsonDone {
  type: 'done';
  result: unknown;
}

export interface NdjsonError {
  type: 'error';
  status: number;
  errorText: string | null;
  diagnostics: DiagnosticView[];
}

export type NdjsonEvent =
  NdjsonDelta | NdjsonCreated | NdjsonDone | NdjsonError;

// A `done` or `error` event ends the exchange; anything after it is ignored and
// a stream that never reaches one is treated as broken.
export function isTerminalNdjsonEvent(event: NdjsonEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}

export function parseNdjsonEvent(line: string): NdjsonEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  switch (value.type) {
    case 'delta':
      return typeof value.text === 'string'
        ? {
            type: 'delta',
            text: value.text,
            kind: value.kind === 'thought' ? 'thought' : 'message',
          }
        : null;
    case 'created':
      return { type: 'created', chat: value.chat };
    case 'done':
      return { type: 'done', result: value.result };
    case 'error':
      return {
        type: 'error',
        status: typeof value.status === 'number' ? value.status : 0,
        errorText: typeof value.errorText === 'string' ? value.errorText : null,
        diagnostics: parseDiagnostics({ diagnostics: value.diagnostics }),
      };
    default:
      return null;
  }
}

export interface NdjsonLineParserHandlers {
  event: (event: NdjsonEvent) => void;
  // Fired exactly once at end() when the stream closed before a done or error.
  broken: () => void;
}

export interface NdjsonLineParser {
  push(chunk: Uint8Array): void;
  end(): void;
}

// Streaming line splitter. Bytes are decoded with a TextDecoder held across
// chunks so a multi-byte character split across two reads is reassembled. Lines
// are separated by `\n`, `\r`, or `\r\n`; blank and unparseable lines are
// skipped defensively.
export function createNdjsonLineParser(
  handlers: NdjsonLineParserHandlers,
): NdjsonLineParser {
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = false;

  const processLine = (line: string): void => {
    const event = parseNdjsonEvent(line);
    if (event === null) return;
    if (isTerminalNdjsonEvent(event)) terminal = true;
    handlers.event(event);
  };

  const drain = (): void => {
    for (;;) {
      let index = -1;
      for (let cursor = 0; cursor < buffer.length; cursor += 1) {
        const char = buffer[cursor];
        if (char === '\n' || char === '\r') {
          index = cursor;
          break;
        }
      }
      if (index === -1) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      processLine(line);
    }
  };

  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      drain();
    },
    end(): void {
      buffer += decoder.decode();
      if (buffer.length > 0) {
        // A trailing line may arrive without its newline; flush it as-is.
        const line = buffer;
        buffer = '';
        processLine(line);
      }
      drain();
      if (!terminal) handlers.broken();
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
