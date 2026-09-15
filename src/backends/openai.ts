import { diagnostic } from '../domain/diagnostics.js';
import type { Diagnostic } from '../domain/diagnostics.js';
import type { MessageRole, ToolCall } from '../domain/transcript.js';
import type { OpenAiBackendConfig } from './config.js';
import type {
  BackendExchange,
  BackendSendResult,
  DeltaSink,
  NormalizedExchangeMessage,
  NormalizedExchangeRequest,
} from './types.js';

export interface OpenAiTransport {
  fetch: typeof fetch;
}

export interface OpenAiSendOptions {
  credential?: string | undefined;
  onDelta?: DeltaSink | undefined;
  signal?: AbortSignal | undefined;
}

interface OpenAiRequestMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAiCompletionResponse {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

const roleMapping: Record<MessageRole, OpenAiRequestMessage['role']> = {
  user: 'user',
  assistant: 'assistant',
  system: 'system',
  tool: 'user',
};

export async function sendOpenAiExchange(
  config: OpenAiBackendConfig,
  request: NormalizedExchangeRequest,
  transport: OpenAiTransport,
  options: OpenAiSendOptions = {},
): Promise<BackendSendResult> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const sessionCredential =
    options.credential !== undefined && options.credential !== ''
      ? options.credential
      : undefined;
  if (sessionCredential !== undefined) {
    headers.authorization = `Bearer ${sessionCredential}`;
  } else if (config.apiKeyEnv !== undefined) {
    const apiKey = process.env[config.apiKeyEnv];
    if (apiKey === undefined || apiKey === '') {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.api_key_missing',
            'error',
            `Environment variable '${config.apiKeyEnv}' is not set; cannot authenticate with backend '${config.name}'.`,
          ),
        ],
      };
    }
    headers.authorization = `Bearer ${apiKey}`;
  }

  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const streaming = options.onDelta !== undefined;
  const payload = {
    model: config.model,
    messages: request.messages.map(toRequestMessage),
    ...(streaming ? { stream: true } : {}),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  // Compose the timeout with the caller's cancel signal so a client disconnect
  // aborts the fetch.
  const onAbort = (): void => {
    controller.abort();
  };
  if (options.signal?.aborted === true) controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let response: Response;
  try {
    response = await transport.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    return {
      ok: false,
      diagnostics: [requestFailedDiagnostic(config, error, config.timeoutMs)],
    };
  }
  options.signal?.removeEventListener('abort', onAbort);

  if (streaming) {
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return consumeOpenAiStream(
      config,
      response,
      options.onDelta ?? (() => {}),
      {
        clear: () => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', onAbort);
        },
      },
    );
  }

  clearTimeout(timer);

  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.request_failed',
          'error',
          `Could not read the response from backend '${config.name}': ${errorMessage(error)}`,
        ),
      ],
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.http_status',
          'error',
          `Backend '${config.name}' returned HTTP ${response.status}: ${excerpt(bodyText)}`,
        ),
      ],
    };
  }

  let parsed: OpenAiCompletionResponse;
  try {
    parsed = JSON.parse(bodyText) as OpenAiCompletionResponse;
  } catch {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.request_failed',
          'error',
          `Backend '${config.name}' returned a response that is not valid JSON: ${excerpt(bodyText)}`,
        ),
      ],
    };
  }

  const exchange = exchangeOf(config, parsed);
  if (exchange.text.trim().length === 0 && exchange.toolCalls.length === 0) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.empty_response',
          'error',
          `Backend '${config.name}' returned neither assistant text nor tool calls.`,
        ),
      ],
    };
  }
  return { ok: true, exchange };
}

export interface SseParser {
  push(chunk: Uint8Array): void;
  end(): void;
}

export function createSseParser(onData: (data: string) => void): SseParser {
  const decoder = new TextDecoder();
  let buffer = '';
  const handleLine = (line: string): void => {
    if (line.startsWith(':')) return;
    if (!line.startsWith('data:')) return;
    let data = line.slice('data:'.length);
    if (data.startsWith(' ')) data = data.slice(1);
    onData(data);
  };
  return {
    push(chunk: Uint8Array): void {
      buffer += decoder.decode(chunk, { stream: true });
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    },
    end(): void {
      buffer += decoder.decode();
      if (buffer.length === 0) return;
      let line = buffer;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      buffer = '';
      if (line.length > 0) handleLine(line);
    },
  };
}

interface OpenAiStreamToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface OpenAiStreamState {
  text: string;
  thought: string;
  thoughtStarted: boolean;
  model: string | null;
  usage: Record<string, unknown> | null;
  toolCalls: Map<number, OpenAiStreamToolCall>;
}

async function consumeOpenAiStream(
  config: OpenAiBackendConfig,
  response: Response,
  onDelta: DeltaSink,
  timer: { clear: () => void },
): Promise<BackendSendResult> {
  try {
    if (!response.ok) {
      let bodyText = '';
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '';
      }
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.http_status',
            'error',
            `Backend '${config.name}' returned HTTP ${response.status}: ${excerpt(bodyText)}`,
          ),
        ],
      };
    }
    if (response.body === null) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.request_failed',
            'error',
            `Backend '${config.name}' returned no response body to stream.`,
          ),
        ],
      };
    }
    const state: OpenAiStreamState = {
      text: '',
      thought: '',
      thoughtStarted: false,
      model: null,
      usage: null,
      toolCalls: new Map(),
    };
    const parser = createSseParser((data) => {
      applyOpenAiStreamData(state, data, onDelta);
    });
    const reader = response.body.getReader();
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (result.value !== undefined) parser.push(result.value);
      }
      parser.end();
    } finally {
      reader.releaseLock();
    }
    const exchange = exchangeFromStreamState(config, state);
    if (exchange.text.trim().length === 0 && exchange.toolCalls.length === 0) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.empty_response',
            'error',
            `Backend '${config.name}' returned neither assistant text nor tool calls.`,
          ),
        ],
      };
    }
    return { ok: true, exchange };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [requestFailedDiagnostic(config, error, config.timeoutMs)],
    };
  } finally {
    timer.clear();
  }
}

function applyOpenAiStreamData(
  state: OpenAiStreamState,
  data: string,
  onDelta: DeltaSink,
): void {
  if (data === '[DONE]') return;
  if (data.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!isRecord(parsed)) return;
  if (typeof parsed.model === 'string') state.model = parsed.model;
  if (isRecord(parsed.usage)) state.usage = { ...parsed.usage };
  const choices = parsed.choices;
  if (!Array.isArray(choices)) return;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const delta = isRecord(choice.delta) ? choice.delta : null;
    if (delta === null) continue;
    // zhipu/deepseek stream the model's reasoning in `reasoning_content`; it is
    // forwarded as thought deltas and recorded separately on the exchange,
    // never folded into the final text. Leading whitespace-only reasoning is
    // dropped so the trace starts clean.
    const reasoning = delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      if (!state.thoughtStarted) {
        const visible = reasoning.trimStart();
        if (visible.length > 0) {
          state.thoughtStarted = true;
          state.thought += visible;
          onDelta(visible, 'thought');
        }
      } else {
        state.thought += reasoning;
        onDelta(reasoning, 'thought');
      }
    }
    const content = delta.content;
    if (typeof content === 'string' && content.length > 0) {
      state.text += content;
      onDelta(content, 'message');
    }
    collectStreamToolCalls(state.toolCalls, delta.tool_calls);
  }
}

function collectStreamToolCalls(
  toolCalls: Map<number, OpenAiStreamToolCall>,
  raw: unknown,
): void {
  if (!Array.isArray(raw)) return;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const index =
      typeof entry.index === 'number' ? entry.index : toolCalls.size;
    let call = toolCalls.get(index);
    if (call === undefined) {
      call = { id: '', name: '', arguments: '' };
      toolCalls.set(index, call);
    }
    if (typeof entry.id === 'string' && entry.id.length > 0) call.id = entry.id;
    const fn = isRecord(entry.function) ? entry.function : null;
    if (fn === null) continue;
    if (typeof fn.name === 'string' && fn.name.length > 0) call.name = fn.name;
    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
  }
}

function exchangeFromStreamState(
  config: OpenAiBackendConfig,
  state: OpenAiStreamState,
): BackendExchange {
  const toolCalls: ToolCall[] = [];
  for (const call of state.toolCalls.values()) {
    if (call.id.length === 0 || call.name.length === 0) continue;
    toolCalls.push({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  return {
    text: state.text,
    toolCalls,
    model: state.model,
    provider: 'openai-compatible',
    backendSession: null,
    usage: state.usage,
    thought: trimmedThought(state.thought),
  };
}

function trimmedThought(thought: string): string | null {
  const trimmed = thought.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRequestMessage(
  message: NormalizedExchangeMessage,
): OpenAiRequestMessage {
  return {
    role: roleMapping[message.role],
    content: message.text,
  };
}

function exchangeOf(
  config: OpenAiBackendConfig,
  response: OpenAiCompletionResponse,
): BackendExchange {
  const choice = firstChoice(response);
  const message = isRecord(choice?.message) ? choice.message : null;
  const content = message?.content;
  const text = typeof content === 'string' ? content : '';
  const reasoning = message?.reasoning_content;
  const thought =
    typeof reasoning === 'string' ? trimmedThought(reasoning) : null;
  const toolCalls: ToolCall[] = [];
  if (message !== null && Array.isArray(message.tool_calls)) {
    for (const entry of message.tool_calls) {
      if (!isRecord(entry)) continue;
      const fn = isRecord(entry.function) ? entry.function : null;
      const id = entry.id;
      const name = fn?.name;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      const rawArguments = fn?.arguments;
      const toolCall: ToolCall = {
        id,
        name,
        arguments:
          typeof rawArguments === 'string'
            ? rawArguments
            : rawArguments === undefined || rawArguments === null
              ? ''
              : JSON.stringify(rawArguments),
      };
      toolCalls.push(toolCall);
    }
  }
  return {
    text,
    toolCalls,
    model: typeof response.model === 'string' ? response.model : null,
    provider: 'openai-compatible',
    backendSession: null,
    usage: isRecord(response.usage) ? { ...response.usage } : null,
    thought,
  };
}

function firstChoice(
  response: OpenAiCompletionResponse,
): Record<string, unknown> | null {
  const choices = response.choices;
  if (!Array.isArray(choices)) return null;
  const first: unknown = choices[0];
  return isRecord(first) ? first : null;
}

function requestFailedDiagnostic(
  config: OpenAiBackendConfig,
  error: unknown,
  timeoutMs: number,
): Diagnostic {
  if (error instanceof Error && error.name === 'AbortError') {
    return diagnostic(
      config.name,
      'backend.request_failed',
      'error',
      `Request to backend '${config.name}' timed out after ${timeoutMs}ms.`,
    );
  }
  return diagnostic(
    config.name,
    'backend.request_failed',
    'error',
    `Request to backend '${config.name}' failed: ${errorMessage(error)}`,
  );
}

function excerpt(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
