import type { ServerResponse } from 'node:http';

import type { Diagnostic } from '../domain/diagnostics.js';

export const ndjsonContentType = 'application/x-ndjson; charset=utf-8';

// The HTTP response emits 'close' when the client connection goes away
// mid-stream (or after a normal end). Operations receive the signal and skip
// their transcript write when it is aborted.
export function createCancelSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on('close', () => {
    if (!controller.signal.aborted) controller.abort();
  });
  return controller.signal;
}

export function acceptsNdjson(accept: string | undefined): boolean {
  if (typeof accept !== 'string') return false;
  return accept.split(',').some((entry) => {
    const mediaType = (entry.split(';')[0] ?? '').trim().toLowerCase();
    return mediaType === 'application/x-ndjson';
  });
}

// `kind` is optional and defaults to "message" for old consumers. "thought" is
// ephemeral reasoning streamed for display only; it never reaches `done`.
export type NdjsonDeltaKind = 'message' | 'thought';

export type NdjsonEvent =
  | { type: 'delta'; text: string; kind?: NdjsonDeltaKind }
  | { type: 'created'; chat: unknown }
  | { type: 'done'; result: unknown }
  | {
      type: 'error';
      status: number;
      errorText: string | null;
      diagnostics: Diagnostic[];
    };

export interface NdjsonTransport {
  readonly started: boolean;
  start(): void;
  created(chat: unknown): void;
  delta(text: string, kind?: NdjsonDeltaKind): void;
  done(result: unknown): void;
  error(
    status: number,
    errorText: string | null,
    diagnostics: Diagnostic[],
  ): void;
  end(): void;
}

export function createNdjsonTransport(
  response: ServerResponse,
): NdjsonTransport {
  let started = false;
  let closed = false;
  response.on('error', () => {
    closed = true;
  });
  const start = (): void => {
    if (started || closed) return;
    started = true;
    try {
      response.writeHead(200, {
        'content-type': ndjsonContentType,
        'cache-control': 'no-store',
        'transfer-encoding': 'chunked',
      });
    } catch {
      closed = true;
    }
  };
  const write = (event: NdjsonEvent): void => {
    start();
    if (closed) return;
    try {
      response.write(`${JSON.stringify(event)}\n`);
    } catch {
      closed = true;
    }
  };
  return {
    get started() {
      return started;
    },
    start,
    created(chat: unknown): void {
      write({ type: 'created', chat });
    },
    delta(text: string, kind: NdjsonDeltaKind = 'message'): void {
      if (text.length === 0) return;
      write(
        kind === 'thought'
          ? { type: 'delta', text, kind }
          : { type: 'delta', text },
      );
    },
    done(result: unknown): void {
      write({ type: 'done', result });
    },
    error(
      status: number,
      errorText: string | null,
      diagnostics: Diagnostic[],
    ): void {
      write({ type: 'error', status, errorText, diagnostics });
    },
    end(): void {
      start();
      if (closed) return;
      closed = true;
      try {
        response.end();
      } catch {
        // the client disconnected; nothing left to flush
      }
    },
  };
}
