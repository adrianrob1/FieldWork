import {
  createNdjsonLineParser,
  isTerminalNdjsonEvent,
  type NdjsonEvent,
} from './ndjson.js';
import { parseDiagnostics, currentHashOf, errorTextOf } from './responses.js';
import type { DiagnosticView } from './types.js';

export type {
  NdjsonCreated,
  NdjsonDelta,
  NdjsonDone,
  NdjsonError,
  NdjsonEvent,
} from './ndjson.js';

export interface ApiFailure {
  status: number;
  errorText: string | null;
  diagnostics: DiagnosticView[];
  currentHash: string | null;
  body: unknown;
}

export type ApiOutcome<T> =
  { ok: true; data: T } | { ok: false; failure: ApiFailure };

export function failureOf(status: number, body: unknown): ApiFailure {
  return {
    status,
    errorText: errorTextOf(body),
    diagnostics: parseDiagnostics(body),
    currentHash: currentHashOf(body),
    body,
  };
}

export interface GetJsonOptions {
  // Skip both the cached response and the single-flight coalescing map and
  // force a fresh network read. Use for conflict-resolution reloads, where the
  // cache may still hold the pre-conflict body.
  bypassCache?: boolean;
}

// Module-level GET cache. Every entry holds the in-flight (or settled) promise
// for one URL, so concurrent identical reads coalesce into a single fetch and
// later reads reuse the response until a write invalidates it.
const getCache = new Map<string, Promise<ApiOutcome<unknown>>>();
let cacheGeneration = 0;

// Drop cached GET responses. Any successful write invalidates the entire cache
// (simple, predictable, and wrong on the safe side). A prefix scopes the drop
// for callers that know only part of their reads changed.
export function invalidateGetCache(prefix?: string): void {
  cacheGeneration += 1;
  if (prefix === undefined) {
    getCache.clear();
    return;
  }
  for (const route of [...getCache.keys()]) {
    if (route.startsWith(prefix)) getCache.delete(route);
  }
}

export function getJson<T>(
  route: string,
  options?: GetJsonOptions,
): Promise<ApiOutcome<T>> {
  if (options?.bypassCache !== true) {
    const hit = getCache.get(route);
    if (hit !== undefined) return hit as Promise<ApiOutcome<T>>;
  }
  const generation = cacheGeneration;
  const request: Promise<ApiOutcome<T>> = requestJson<T>(route).then(
    (outcome) => {
      if (generation !== cacheGeneration) {
        // A write landed while this read was in flight; never cache the stale
        // response.
        if (getCache.get(route) === request) getCache.delete(route);
        return outcome;
      }
      if (outcome.ok) {
        getCache.set(route, request);
      } else {
        if (getCache.get(route) === request) getCache.delete(route);
      }
      return outcome;
    },
  );
  getCache.set(route, request);
  return request;
}

export async function postJson<T>(
  route: string,
  payload: unknown,
): Promise<ApiOutcome<T>> {
  const outcome = await requestJson<T>(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (outcome.ok) invalidateGetCache();
  return outcome;
}

export interface StreamFallback {
  status: number;
  body: unknown;
}

export interface StreamHandlers {
  event: (event: NdjsonEvent) => void;
  // Called instead of `event` when the response is not an NDJSON stream: a
  // non-2xx validation envelope or a server that ignored the Accept header.
  fallbackJson: (fallback: StreamFallback) => void;
}

export interface StreamRequest {
  promise: Promise<void>;
  signal: AbortSignal;
  abort: () => void;
}

// POST that asks for an NDJSON reply. Every line is parsed and handed to
// `handlers.event`; a non-NDJSON response (validation failure, 409, or an old
// server) is handed to `handlers.fallbackJson` as the plain JSON envelope. A
// stream that closes without a done or error event is reported as a synthetic
// terminal error so callers never hang waiting.
export function postStream(
  route: string,
  payload: unknown,
  handlers: StreamHandlers,
): StreamRequest {
  const controller = new AbortController();
  const promise = (async (): Promise<void> => {
    let invalidate = false;
    try {
      let response: Response;
      try {
        response = await fetch(route, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/x-ndjson',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch {
        handlers.fallbackJson({ status: 0, body: null });
        return;
      }
      // A write completed server-side; drop cached reads. A failed request
      // (validation/409/network) leaves the cache untouched.
      invalidate = response.ok;
      await handleStreamResponse(response, handlers);
    } finally {
      if (invalidate) invalidateGetCache();
    }
  })();
  return {
    promise,
    signal: controller.signal,
    abort: () => {
      controller.abort();
    },
  };
}

async function handleStreamResponse(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/x-ndjson')) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    handlers.fallbackJson({ status: response.status, body });
    return;
  }
  if (response.body === null) {
    handlers.event(brokenStreamError());
    return;
  }
  let terminal = false;
  const emit = (event: NdjsonEvent): void => {
    if (isTerminalNdjsonEvent(event)) terminal = true;
    handlers.event(event);
  };
  const parser = createNdjsonLineParser({
    event: emit,
    broken: () => {
      if (terminal) return;
      terminal = true;
      handlers.event(brokenStreamError());
    },
  });
  const reader = response.body.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (result.value !== undefined) parser.push(result.value);
    }
    parser.end();
  } catch {
    if (!terminal) {
      terminal = true;
      handlers.event(brokenStreamError());
    }
  } finally {
    reader.releaseLock();
  }
}

function brokenStreamError(): NdjsonEvent {
  return {
    type: 'error',
    status: 0,
    errorText: 'The reply stream ended before the backend finished.',
    diagnostics: [],
  };
}

async function requestJson<T>(
  route: string,
  init?: RequestInit,
): Promise<ApiOutcome<T>> {
  let response: Response;
  try {
    response = await fetch(route, init);
  } catch {
    return {
      ok: false,
      failure: {
        status: 0,
        errorText: null,
        diagnostics: [],
        currentHash: null,
        body: null,
      },
    };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok) return { ok: true, data: body as T };
  return { ok: false, failure: failureOf(response.status, body) };
}
