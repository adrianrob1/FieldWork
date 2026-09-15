import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { diagnostic } from '../domain/diagnostics.js';
import type { ToolCall } from '../domain/transcript.js';
import { spawning } from './command.js';
import type { AgentBackendConfig } from './config.js';
import type {
  BackendExchange,
  BackendSendResult,
  DeltaKind,
  DeltaSink,
  NormalizedExchangeRequest,
} from './types.js';

export interface AcpSession {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  setNotificationHandler(
    handler: (method: string, params: unknown) => void,
  ): void;
  close(): void;
}

export interface AcpTransport {
  connect(
    command: string,
    args: string[],
    options: { cwd: string | undefined },
  ): Promise<AcpSession>;
}

export interface AcpSendOptions {
  session?: string | undefined;
  cwd?: string | undefined;
  onDelta?: DeltaSink | undefined;
  signal?: AbortSignal | undefined;
}

const METHOD_NOT_FOUND = -32601;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export const childProcessAcpTransport: AcpTransport = {
  connect(command, args, options) {
    return new Promise((resolve, reject) => {
      const { file, argsPrefix } = spawning(command, args);
      const child = spawn(file, argsPrefix.length > 0 ? argsPrefix : args, {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(argsPrefix.length > 0 ? { windowsVerbatimArguments: true } : {}),
      });
      const pending = new Map<string, PendingRequest>();
      let nextId = 1;
      let stderr = '';
      let stdoutBuffer = '';
      let settled = false;
      let closed = false;
      let notificationHandler:
        ((method: string, params: unknown) => void) | null = null;

      child.stdin?.on('error', () => {});
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBuffer += chunk;
        let newline = stdoutBuffer.indexOf('\n');
        while (newline !== -1) {
          const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
          stdoutBuffer = stdoutBuffer.slice(newline + 1);
          if (line.trim().length > 0) handleLine(line);
          newline = stdoutBuffer.indexOf('\n');
        }
      });
      child.on('spawn', () => {
        if (settled) return;
        settled = true;
        resolve(session);
      });
      child.on('error', (error: Error) => {
        const detail = `Could not run command '${command}': ${error.message}`;
        settleConnect(() => reject(new Error(detail)));
        rejectPending(new Error(detail));
      });
      child.on('close', (code: number | null) => {
        if (stdoutBuffer.trim().length > 0) {
          handleLine(stdoutBuffer.replace(/\r$/, ''));
        }
        stdoutBuffer = '';
        const detail = `Command '${command}' for the ACP session exited with code ${String(code)}${stderr.trim().length > 0 ? `: ${excerpt(stderr)}` : ''}`;
        settleConnect(() => reject(new Error(detail)));
        rejectPending(new Error(detail));
      });

      function settleConnect(fail: () => void): void {
        closed = true;
        if (settled) return;
        settled = true;
        fail();
      }

      function rejectPending(error: Error): void {
        for (const entry of pending.values()) {
          entry.reject(new Error(error.message));
        }
        pending.clear();
      }

      function writeMessage(message: Record<string, unknown>): void {
        child.stdin?.write(`${JSON.stringify(message)}\n`);
      }

      function handleLine(line: string): void {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message)) return;
        const id = message.id;
        if (
          (typeof id === 'number' || typeof id === 'string') &&
          (message.result !== undefined || message.error !== undefined)
        ) {
          const key = typeof id === 'number' ? String(id) : id;
          const entry = pending.get(key);
          if (entry === undefined) return;
          pending.delete(key);
          if (isRecord(message.error)) {
            const failure = new Error(
              `The ACP request '${entry.method}' failed with code ${String(message.error.code)}: ${typeof message.error.message === 'string' ? message.error.message : 'unknown'}`,
            );
            (failure as { code?: unknown }).code = message.error.code;
            entry.reject(failure);
          } else {
            entry.resolve(message.result);
          }
          return;
        }
        if (typeof message.method === 'string' && id !== undefined) {
          writeMessage({
            jsonrpc: '2.0',
            id,
            error: {
              code: METHOD_NOT_FOUND,
              message: `Method not found: ${message.method}`,
            },
          });
          return;
        }
        if (typeof message.method === 'string') {
          notificationHandler?.(message.method, message.params);
        }
      }

      const session: AcpSession = {
        request(method: string, params: unknown): Promise<unknown> {
          return new Promise((resolve, reject) => {
            if (closed) {
              reject(new Error('The ACP session is already closed.'));
              return;
            }
            const id = nextId;
            nextId += 1;
            pending.set(String(id), { method, resolve, reject });
            writeMessage({ jsonrpc: '2.0', id, method, params });
          });
        },
        notify(method: string, params: unknown): void {
          if (closed) return;
          writeMessage({ jsonrpc: '2.0', method, params });
        },
        setNotificationHandler(
          handler: (method: string, params: unknown) => void,
        ): void {
          notificationHandler = handler;
        },
        close(): void {
          if (closed) return;
          closed = true;
          child.kill();
          child.stdin?.end();
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          rejectPending(
            new Error('The ACP session closed before the exchange finished.'),
          );
        },
      };
    });
  },
};

export function buildAcpPrompt(
  request: NormalizedExchangeRequest,
  resumed: boolean,
): string | null {
  const messages = request.messages;
  const last = messages.at(-1);
  if (last === undefined) return null;
  if (resumed || messages.length === 1) return last.text;
  return messages
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n\n');
}

export interface AcpDeltaEmitter {
  accept(params: unknown): void;
}

export function createAcpDeltaEmitter(onDelta: DeltaSink): AcpDeltaEmitter {
  // Messages and thoughts are independent streams: each groups its chunks by
  // messageId and inserts a blank line between distinct messages of its kind.
  // Leading whitespace-only chunks, which harnesses such as Codex emit before
  // the first visible reasoning, are dropped so the stream starts clean.
  const streams: Record<
    DeltaKind,
    { messageId: string | null; started: boolean }
  > = {
    message: { messageId: null, started: false },
    thought: { messageId: null, started: false },
  };
  return {
    accept(params: unknown): void {
      const update = sessionUpdateOf(params);
      if (update === null) return;
      const kind = chunkKind(update.sessionUpdate);
      if (kind === null) return;
      const text = agentChunkText(update);
      if (text === null || text.length === 0) return;
      const id = typeof update.messageId === 'string' ? update.messageId : null;
      const stream = streams[kind];
      if (!stream.started) {
        const visible = text.trimStart();
        if (visible.length === 0) return;
        stream.started = true;
        stream.messageId = id;
        onDelta(visible, kind);
        return;
      }
      if (id !== stream.messageId) onDelta('\n\n', kind);
      onDelta(text, kind);
      stream.messageId = id;
    },
  };
}

function chunkKind(sessionUpdate: unknown): DeltaKind | null {
  if (sessionUpdate === 'agent_message_chunk') return 'message';
  if (sessionUpdate === 'agent_thought_chunk') return 'thought';
  return null;
}

export function acpExchangeFromUpdates(
  updates: unknown[],
  backendSession: string,
): BackendExchange {
  const messageChunks: { messageId: string | null; text: string }[] = [];
  const thoughtChunks: { messageId: string | null; text: string }[] = [];
  const toolCalls: ToolCall[] = [];
  for (const params of updates) {
    const update = sessionUpdateOf(params);
    if (update === null) continue;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk') {
      const text = agentChunkText(update);
      if (text === null || text.length === 0) continue;
      const messageId =
        typeof update.messageId === 'string' ? update.messageId : null;
      const buckets =
        kind === 'agent_message_chunk' ? messageChunks : thoughtChunks;
      const bucket = buckets.find((entry) => entry.messageId === messageId);
      if (bucket === undefined) {
        buckets.push({ messageId, text });
      } else {
        bucket.text += text;
      }
      continue;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      applyToolCallUpdate(toolCalls, update);
    }
  }
  return {
    text: messageChunks.map((entry) => entry.text).join('\n\n'),
    toolCalls,
    model: null,
    provider: 'acp',
    backendSession,
    usage: null,
    thought: joinedChunks(thoughtChunks),
  };
}

// Reasoning buckets join like message buckets, but each bucket is trimmed and
// empty buckets drop out, so whitespace-only lead-ins never reach the record.
function joinedChunks(
  chunks: { messageId: string | null; text: string }[],
): string | null {
  const parts = chunks
    .map((entry) => entry.text.trim())
    .filter((text) => text.length > 0);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export async function sendAcpExchange(
  config: AgentBackendConfig,
  request: NormalizedExchangeRequest,
  transport: AcpTransport,
  options: AcpSendOptions = {},
): Promise<BackendSendResult> {
  const cwd = options.cwd ?? process.cwd();
  let session: AcpSession | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session?.close();
  }, config.timeoutMs);
  // A client disconnect closes the session, which kills the child process and
  // rejects any pending request so the exchange unwinds promptly.
  const onAbort = (): void => {
    session?.close();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    try {
      session = await transport.connect(config.command, config.args, { cwd });
    } catch (error) {
      throw new Error(
        `Could not start command '${config.command}' for backend '${config.name}': ${errorMessage(error)}`,
      );
    }
    if (timedOut) {
      throw new Error(
        `Request to backend '${config.name}' timed out after ${config.timeoutMs}ms.`,
      );
    }
    if (options.signal?.aborted === true) {
      session?.close();
      throw new Error('The ACP exchange was cancelled.');
    }

    const updates: unknown[] = [];
    let collecting = false;
    const deltaEmitter =
      options.onDelta === undefined
        ? null
        : createAcpDeltaEmitter(options.onDelta);
    session.setNotificationHandler((method: string, params: unknown) => {
      if (!collecting || method !== 'session/update') return;
      updates.push(params);
      deltaEmitter?.accept(params);
    });

    try {
      await session.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: { name: 'fieldwork', version: fieldworkVersion() },
      });
    } catch (error) {
      throw new Error(
        `The ACP initialize handshake with backend '${config.name}' failed: ${errorMessage(error)}`,
      );
    }
    session.notify('notifications/initialized', {});

    const loaded = await loadAcpSession(session, options.session, cwd);
    let backendSession = loaded;
    if (backendSession === null) {
      let created: unknown;
      try {
        created = await session.request('session/new', {
          cwd,
          mcpServers: [],
        });
      } catch (error) {
        throw new Error(
          `Creating an ACP session with backend '${config.name}' failed: ${errorMessage(error)}`,
        );
      }
      backendSession = sessionIdOf(created);
      if (backendSession === null) {
        throw new Error(
          `Backend '${config.name}' did not return a session id from session/new.`,
        );
      }
    }

    if (config.model !== undefined && config.model !== '') {
      try {
        await session.request('session/set_model', {
          sessionId: backendSession,
          modelId: config.model,
        });
      } catch (error) {
        // A harness without the model extension answers method not found;
        // its own model choice then applies. Any other refusal is a real
        // configuration error and must surface instead of silently using a
        // different model.
        if (!isMethodNotFound(error)) {
          throw new Error(
            `Setting model '${config.model}' on backend '${config.name}' failed: ${errorMessage(error)}`,
          );
        }
      }
    }

    const prompt = buildAcpPrompt(request, loaded !== null);
    if (prompt === null) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.request_failed',
            'error',
            `Backend '${config.name}' requires at least one message.`,
          ),
        ],
      };
    }
    collecting = true;
    try {
      await session.request('session/prompt', {
        sessionId: backendSession,
        prompt: [{ type: 'text', text: prompt }],
      });
    } catch (error) {
      throw new Error(
        `The ACP prompt turn with backend '${config.name}' failed: ${errorMessage(error)}`,
      );
    } finally {
      collecting = false;
    }

    const exchange = acpExchangeFromUpdates(updates, backendSession);
    if (exchange.text.trim().length === 0 && exchange.toolCalls.length === 0) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.empty_response',
            'error',
            `Backend '${config.name}' produced neither assistant text nor tool calls.`,
          ),
        ],
      };
    }
    return { ok: true, exchange };
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            config.name,
            'backend.request_failed',
            'error',
            `Request to backend '${config.name}' timed out after ${config.timeoutMs}ms.`,
          ),
        ],
      };
    }
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.request_failed',
          'error',
          errorMessage(error),
        ),
      ],
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    session?.close();
  }
}

async function loadAcpSession(
  session: AcpSession,
  sessionId: string | undefined,
  cwd: string,
): Promise<string | null> {
  if (sessionId === undefined) return null;
  try {
    await session.request('session/load', { sessionId, cwd, mcpServers: [] });
    return sessionId;
  } catch {
    return null;
  }
}

export interface AcpModelOption {
  id: string;
  name: string | null;
  description: string | null;
}

export type AcpModelListResult =
  { ok: true; models: AcpModelOption[] } | { ok: false; message: string };

// Asks a harness which models it offers by opening a short-lived session and
// reading the model list from the session/new result. Harnesses that report
// none answer an empty list, which keeps the picker usable as a plain text
// field.
export async function listAcpModels(
  config: AgentBackendConfig,
  transport: AcpTransport,
  options: { cwd?: string | undefined } = {},
): Promise<AcpModelListResult> {
  const cwd = options.cwd ?? process.cwd();
  let session: AcpSession | null = null;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    session?.close();
  }, config.timeoutMs);
  try {
    try {
      session = await transport.connect(config.command, config.args, { cwd });
    } catch (error) {
      throw new Error(
        `Could not start command '${config.command}': ${errorMessage(error)}`,
      );
    }
    if (timedOut) {
      throw new Error(
        `Listing models from command '${config.command}' timed out after ${config.timeoutMs}ms.`,
      );
    }
    try {
      await session.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
        },
        clientInfo: { name: 'fieldwork', version: fieldworkVersion() },
      });
    } catch (error) {
      throw new Error(
        `The ACP initialize handshake failed: ${errorMessage(error)}`,
      );
    }
    session.notify('notifications/initialized', {});
    let created: unknown;
    try {
      created = await session.request('session/new', {
        cwd,
        mcpServers: [],
      });
    } catch (error) {
      throw new Error(
        `Creating a session to list models failed: ${errorMessage(error)}`,
      );
    }
    return { ok: true, models: acpModelOptionsOf(created) };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  } finally {
    clearTimeout(timer);
    session?.close();
  }
}

// Two shapes cover the harnesses in the wild: Codex-style agents report
// `models.availableModels` on session/new, while OpenCode reports a
// `configOptions` entry with id "model" whose options carry the model list.
// Both normalize to the same picker entries, de-duplicated by id.
function acpModelOptionsOf(result: unknown): AcpModelOption[] {
  if (!isRecord(result)) return [];
  const options: AcpModelOption[] = [];
  const seen = new Set<string>();
  const push = (
    id: string,
    name: string | null,
    description: string | null,
  ): void => {
    if (id === '' || seen.has(id)) return;
    seen.add(id);
    options.push({ id, name, description });
  };
  if (isRecord(result.models) && Array.isArray(result.models.availableModels)) {
    for (const entry of result.models.availableModels) {
      if (!isRecord(entry) || typeof entry.modelId !== 'string') continue;
      push(
        entry.modelId,
        typeof entry.name === 'string' && entry.name !== '' ? entry.name : null,
        typeof entry.description === 'string' && entry.description !== ''
          ? entry.description
          : null,
      );
    }
  }
  if (Array.isArray(result.configOptions)) {
    for (const entry of result.configOptions) {
      if (
        !isRecord(entry) ||
        entry.id !== 'model' ||
        !Array.isArray(entry.options)
      ) {
        continue;
      }
      for (const option of entry.options) {
        if (!isRecord(option) || typeof option.value !== 'string') continue;
        push(
          option.value,
          typeof option.name === 'string' && option.name !== ''
            ? option.name
            : null,
          null,
        );
      }
    }
  }
  return options;
}

function isMethodNotFound(error: unknown): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === METHOD_NOT_FOUND
  ) {
    return true;
  }
  return (
    error instanceof Error &&
    error.message.includes(`code ${String(METHOD_NOT_FOUND)}`)
  );
}

function sessionUpdateOf(params: unknown): Record<string, unknown> | null {
  if (!isRecord(params) || !isRecord(params.update)) return null;
  const update = params.update;
  return typeof update.sessionUpdate === 'string' ? update : null;
}

function agentChunkText(update: Record<string, unknown>): string | null {
  if (typeof update.raw_content === 'string') return update.raw_content;
  const content = update.content;
  if (
    isRecord(content) &&
    content.type === 'text' &&
    typeof content.text === 'string'
  ) {
    return content.text;
  }
  const chunk = update.content_item_chunk;
  if (
    isRecord(chunk) &&
    chunk.type === 'text' &&
    typeof chunk.text === 'string'
  ) {
    return chunk.text;
  }
  return null;
}

function applyToolCallUpdate(
  toolCalls: ToolCall[],
  update: Record<string, unknown>,
): void {
  const toolCallId = update.toolCallId;
  if (typeof toolCallId !== 'string') return;
  const title = update.title;
  let call = toolCalls.find((entry) => entry.id === toolCallId);
  if (call === undefined) {
    call = {
      id: toolCallId,
      name: typeof title === 'string' ? title : toolCallId,
      arguments: {},
    };
    toolCalls.push(call);
  } else if (typeof title === 'string') {
    call.name = title;
  }
  const result = toolCallResult(update);
  if (result !== null) {
    call.result = result;
  }
}

function toolCallResult(update: Record<string, unknown>): string | null {
  const content = update.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const entry of content) {
      if (!isRecord(entry)) continue;
      if (
        isRecord(entry.content) &&
        entry.content.type === 'text' &&
        typeof entry.content.text === 'string'
      ) {
        texts.push(entry.content.text);
      } else if (entry.type === 'text' && typeof entry.text === 'string') {
        texts.push(entry.text);
      }
    }
    if (texts.length > 0) return texts.join('\n');
  }
  const rawOutput = update.rawOutput;
  if (typeof rawOutput === 'string') return rawOutput;
  if (rawOutput !== undefined && rawOutput !== null) {
    return JSON.stringify(rawOutput);
  }
  return null;
}

function sessionIdOf(result: unknown): string | null {
  if (!isRecord(result)) return null;
  return typeof result.sessionId === 'string' ? result.sessionId : null;
}

function fieldworkVersion(): string {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package.json', import.meta.url)),
        'utf8',
      ),
    );
    if (isRecord(parsed) && typeof parsed.version === 'string') {
      return parsed.version;
    }
  } catch {
    // an unreadable package.json still lets the handshake proceed
  }
  return '0.0.0';
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
