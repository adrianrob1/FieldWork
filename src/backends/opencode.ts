import { spawn } from 'node:child_process';

import { diagnostic } from '../domain/diagnostics.js';
import type { ToolCall } from '../domain/transcript.js';
import { spawning } from './command.js';
import type { OpencodeBackendConfig } from './config.js';
import type {
  BackendExchange,
  BackendSendResult,
  DeltaSink,
  NormalizedExchangeRequest,
} from './types.js';

export interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError: string | null;
}

export interface SpawnCall {
  cwd: string;
  onStdoutChunk?: ((chunk: string) => void) | undefined;
  // Aborted by the caller (client disconnect). The transport kills the child.
  signal?: AbortSignal | undefined;
}

export type SpawnTransport = (
  command: string,
  args: string[],
  call: SpawnCall,
) => Promise<SpawnOutcome>;

export const childProcessSpawnTransport: SpawnTransport = (
  command,
  args,
  call,
) =>
  new Promise((resolve) => {
    const { file, argsPrefix } = spawning(command, args);
    const child = spawn(file, argsPrefix.length > 0 ? argsPrefix : args, {
      cwd: call.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(argsPrefix.length > 0 ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = '';
    let stderr = '';
    const killOnAbort = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    };
    call.signal?.addEventListener('abort', killOnAbort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      call.onStdoutChunk?.(text);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      call.signal?.removeEventListener('abort', killOnAbort);
      resolve({ code: null, stdout, stderr, spawnError: error.message });
    });
    child.on('close', (code: number | null) => {
      call.signal?.removeEventListener('abort', killOnAbort);
      resolve({ code, stdout, stderr, spawnError: null });
    });
    if (call.signal?.aborted === true) killOnAbort();
  });

export interface OpencodeSendOptions {
  session?: string | undefined;
  cwd?: string | undefined;
  onDelta?: DeltaSink | undefined;
  signal?: AbortSignal | undefined;
}

interface OpencodeEvent {
  type?: unknown;
  sessionID?: unknown;
  part?: unknown;
}

export async function sendOpencodeExchange(
  config: OpencodeBackendConfig,
  request: NormalizedExchangeRequest,
  transport: SpawnTransport,
  options: OpencodeSendOptions = {},
): Promise<BackendSendResult> {
  const session = options.session;
  const message = buildOpencodeMessage(request, session);
  if (message === null) {
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
  const deltaStream =
    options.onDelta === undefined
      ? null
      : createOpencodeDeltaStream(options.onDelta);
  const call: SpawnCall = {
    cwd: options.cwd ?? process.cwd(),
    signal: options.signal,
    ...(deltaStream === null
      ? {}
      : { onStdoutChunk: (chunk: string) => deltaStream.push(chunk) }),
  };

  let outcome = await transport(
    config.command,
    buildOpencodeArgs(config, message, session),
    call,
  );
  if (
    session !== undefined &&
    outcome.spawnError === null &&
    outcome.code !== 0 &&
    /session not found/i.test(outcome.stderr)
  ) {
    outcome = await transport(
      config.command,
      buildOpencodeArgs(config, message, undefined),
      call,
    );
  }
  deltaStream?.flush();

  if (outcome.spawnError !== null) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.request_failed',
          'error',
          `Could not start command '${config.command}' for backend '${config.name}': ${outcome.spawnError}`,
        ),
      ],
    };
  }
  if (outcome.code !== 0) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.command_failed',
          'error',
          `Command '${config.command}' for backend '${config.name}' exited with code ${String(outcome.code)}: ${excerpt(outcome.stderr)}`,
        ),
      ],
    };
  }

  const events = parseEvents(outcome.stdout);
  if (events === null) {
    return {
      ok: false,
      diagnostics: [
        diagnostic(
          config.name,
          'backend.request_failed',
          'error',
          `Command '${config.command}' for backend '${config.name}' did not emit JSON events: ${excerpt(outcome.stdout)}`,
        ),
      ],
    };
  }
  const exchange = exchangeOf(config, events, session ?? null);
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
}

export interface OpencodeDeltaStream {
  push(chunk: string): void;
  flush(): void;
}

export function createOpencodeDeltaStream(
  onDelta: DeltaSink,
): OpencodeDeltaStream {
  let buffer = '';
  let emittedAny = false;
  // Reasoning models emit whitespace-only text parts while they think; those
  // carry no visible content and must not grow the stream bubble (or the
  // separators between real parts). The '\n\n' separator between parts
  // already provides paragraph spacing.
  const emit = (text: string): void => {
    if (text.trim().length === 0) return;
    if (emittedAny) onDelta('\n\n', 'message');
    onDelta(text, 'message');
    emittedAny = true;
  };
  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type !== 'text') return;
    const part = isRecord(parsed.part) ? parsed.part : null;
    if (part === null || typeof part.text !== 'string') return;
    emit(part.text);
  };
  return {
    push(chunk: string): void {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    },
    flush(): void {
      if (buffer.length === 0) return;
      const line = buffer.replace(/\r$/, '');
      buffer = '';
      handleLine(line);
    },
  };
}

export function buildOpencodeArgs(
  config: OpencodeBackendConfig,
  message: string,
  session: string | undefined,
): string[] {
  const args = [...config.args, 'run', '--format', 'json'];
  if (config.model !== undefined) args.push('-m', config.model);
  if (session !== undefined) args.push('-s', session);
  args.push(message);
  return args;
}

export function buildOpencodeMessage(
  request: NormalizedExchangeRequest,
  session: string | undefined,
): string | null {
  const messages = request.messages;
  const last = messages[messages.length - 1];
  if (last === undefined) return null;
  if (session !== undefined || messages.length === 1) return last.text;
  return messages
    .map((message) => `${message.role}: ${message.text}`)
    .join('\n\n');
}

function exchangeOf(
  config: OpencodeBackendConfig,
  events: OpencodeEvent[],
  session: string | null,
): BackendExchange {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let backendSession = session;
  let usage: Record<string, unknown> | null = null;

  for (const event of events) {
    if (typeof event.sessionID === 'string') backendSession = event.sessionID;
    const part = isRecord(event.part) ? event.part : null;
    if (part === null) continue;
    if (event.type === 'text' && typeof part.text === 'string') {
      // Whitespace-only parts are reasoning-model noise; the serializer trims
      // the message ends, but a noise part between two real parts would still
      // stack extra blank lines into the stored text.
      if (part.text.trim().length > 0) texts.push(part.text);
    }
    if (event.type === 'tool_use') {
      const id = part.callID;
      const name = part.tool;
      const state = isRecord(part.state) ? part.state : null;
      if (typeof id !== 'string' || typeof name !== 'string') continue;
      const input = state?.input;
      const toolCall: ToolCall = {
        id,
        name,
        arguments: isRecord(input) ? { ...input } : {},
      };
      const output = state?.output;
      if (typeof output === 'string') {
        toolCall.result = output;
      }
      toolCalls.push(toolCall);
    }
    if (event.type === 'step_finish' && isRecord(part.tokens)) {
      usage = { ...part.tokens };
      if (part.cost !== undefined) usage.cost = part.cost;
    }
  }

  return {
    text: texts.join('\n\n'),
    toolCalls,
    model: config.model ?? null,
    provider: 'opencode',
    backendSession,
    usage,
    thought: null,
  };
}

function parseEvents(stdout: string): OpencodeEvent[] | null {
  const events: OpencodeEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      events.push(parsed);
    } catch {
      continue;
    }
  }
  return events.length > 0 ? events : null;
}

function excerpt(body: string): string {
  const compact = body.replace(/\s+/g, ' ').trim();
  return compact.length > 200 ? `${compact.slice(0, 200)}...` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
