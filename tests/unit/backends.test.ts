import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  findBackend,
  resolveBackends,
  type BackendsResolution,
} from '../../src/backends/config.js';
import {
  sendOpenAiExchange,
  type OpenAiTransport,
} from '../../src/backends/openai.js';
import {
  buildOpencodeArgs,
  buildOpencodeMessage,
  sendOpencodeExchange,
  type SpawnOutcome,
  type SpawnTransport,
} from '../../src/backends/opencode.js';
import type {
  NormalizedExchangeRequest,
  OpenAiBackendConfig,
  OpencodeBackendConfig,
} from '../../src/index.js';
import {
  chatFileName,
  chatTitleSlug,
  todayDate,
} from '../../src/operations/start.js';
import {
  parseTranscript,
  serializeChatMessage,
} from '../../src/files/transcript.js';

const openAiConfig: OpenAiBackendConfig = {
  type: 'openai',
  name: 'research-model',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6',
  apiKeyEnv: 'FIELDWORK_TEST_KEY',
  timeoutMs: 5000,
};

const opencodeConfig: OpencodeBackendConfig = {
  type: 'opencode',
  name: 'local-agent',
  model: 'anthropic/claude-sonnet-4-5',
  command: 'opencode',
  args: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('backends settings resolution', () => {
  it('resolves valid settings into typed entries with defaults', () => {
    const resolution = resolveBackends('workspace.yml', {
      backends: {
        default: 'research-model',
        entries: {
          'research-model': { type: 'openai', model: 'gpt-5.6' },
          'local-agent': { type: 'opencode' },
        },
      },
    });

    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.defaultName).toBe('research-model');
    expect(resolution.entries).toEqual([
      {
        type: 'opencode',
        name: 'local-agent',
        model: undefined,
        command: 'opencode',
        args: [],
      },
      {
        type: 'openai',
        name: 'research-model',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6',
        apiKeyEnv: undefined,
        timeoutMs: 120000,
      },
    ]);
  });

  it('reports schema diagnostics with field paths for an invalid entry', () => {
    const resolution = resolveBackends('workspace.yml', {
      backends: {
        entries: {
          broken: { type: 'openai' },
        },
      },
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.diagnostics).toHaveLength(1);
    expect(resolution.diagnostics[0]?.code).toBe('backend.schema');
    expect(resolution.diagnostics[0]?.file).toBe('workspace.yml');
    expect(resolution.diagnostics[0]?.fieldPath).toContain('backends.entries');
  });

  it('reports an unknown default backend as unconfigured', () => {
    const resolution = resolveBackends('workspace.yml', {
      backends: { default: 'ghost', entries: {} },
    });

    expect(resolution.defaultName).toBe('ghost');
    expect(resolution.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.unconfigured',
    ]);
    const lookup = findBackend(resolution, undefined);
    expect(lookup.backend).toBeNull();
    expect(lookup.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.unconfigured',
    ]);
  });

  it('fails lookup without any configured backends', () => {
    const resolution = resolveBackends('workspace.yml', null);

    expect(resolution.entries).toEqual([]);
    expect(resolution.defaultName).toBeNull();
    const lookup = findBackend(resolution, undefined);
    expect(lookup.backend).toBeNull();
    expect(lookup.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.unconfigured',
    ]);
  });

  it('finds an explicit backend and reports unknown names', () => {
    const resolution: BackendsResolution = {
      file: 'workspace.yml',
      defaultName: 'research-model',
      entries: [
        {
          type: 'openai',
          name: 'research-model',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-5.6',
          apiKeyEnv: undefined,
          timeoutMs: 120000,
        },
      ],
      diagnostics: [],
    };

    expect(findBackend(resolution, 'research-model').backend?.type).toBe(
      'openai',
    );
    const missing = findBackend(resolution, 'other-model');
    expect(missing.backend).toBeNull();
    expect(missing.diagnostics.map((entry) => entry.code)).toEqual([
      'backend.unconfigured',
    ]);
  });
});

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function captureFetch(
  status: number,
  body: string,
): { transport: OpenAiTransport; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const transport: OpenAiTransport = {
    fetch: ((url: string, init?: RequestInit) => {
      requests.push({ url, init: init ?? {} });
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
  return { transport, requests };
}

const cannedCompletion = JSON.stringify({
  model: 'gpt-5.6',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'Fresh answer.',
        tool_calls: [
          {
            id: 'call_lookup',
            type: 'function',
            function: { name: 'calendar_lookup', arguments: '{"week":36}' },
          },
        ],
      },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
});

describe('sendOpenAiExchange', () => {
  const request: NormalizedExchangeRequest = {
    messages: [
      { role: 'system', text: 'Be concise.' },
      { role: 'user', text: 'First question.' },
      { role: 'assistant', text: 'First answer.' },
      { role: 'tool', text: 'Tool output.' },
      { role: 'user', text: 'Second question.' },
    ],
  };

  it('builds the request from transcript roles and normalizes the response', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const { transport, requests } = captureFetch(200, cannedCompletion);

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
    const init = requests[0]?.init;
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer secret-key');
    const rawBody = init?.body;
    expect(typeof rawBody).toBe('string');
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : '') as {
      model: string;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('gpt-5.6');
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be concise.' },
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: 'First answer.' },
      { role: 'user', content: 'Tool output.' },
      { role: 'user', content: 'Second question.' },
    ]);

    if (result.ok) {
      expect(result.exchange).toEqual({
        text: 'Fresh answer.',
        toolCalls: [
          {
            id: 'call_lookup',
            name: 'calendar_lookup',
            arguments: '{"week":36}',
          },
        ],
        model: 'gpt-5.6',
        provider: 'openai-compatible',
        backendSession: null,
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        thought: null,
      });
    }
  });

  it('sends without an authorization header when no api key env is configured', async () => {
    const { transport, requests } = captureFetch(200, cannedCompletion);

    const result = await sendOpenAiExchange(
      { ...openAiConfig, apiKeyEnv: undefined },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('refuses to send when the configured api key env is unset', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', '');
    const { transport, requests } = captureFetch(200, cannedCompletion);

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.api_key_missing',
      ]);
      expect(result.diagnostics[0]?.message).not.toContain('secret-key');
    }
  });

  it('reports http status errors with a body excerpt and no secrets', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const { transport } = captureFetch(401, '{"error":"bad key"}');

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.http_status',
      ]);
      expect(result.diagnostics[0]?.message).toContain('401');
      expect(result.diagnostics[0]?.message).toContain('bad key');
      expect(result.diagnostics[0]?.message).not.toContain('secret-key');
      expect(result.diagnostics[0]?.file).toBe('research-model');
    }
  });

  it('reports malformed JSON responses as request failures', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const { transport } = captureFetch(200, '<html>not json</html>');

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
    }
  });

  it('rejects an empty object response with no text or tool calls', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const { transport } = captureFetch(200, '{}');

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.empty_response',
      ]);
      expect(result.diagnostics[0]?.message).toContain('research-model');
    }
  });

  it('rejects responses with missing choices or blank content', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const missingChoices = captureFetch(
      200,
      JSON.stringify({ model: 'gpt-5.6', usage: { total_tokens: 3 } }),
    );
    const missing = await sendOpenAiExchange(
      openAiConfig,
      request,
      missingChoices.transport,
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.diagnostics[0]?.code).toBe('backend.empty_response');
    }

    const emptyContent = captureFetch(
      200,
      JSON.stringify({
        model: 'gpt-5.6',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const empty = await sendOpenAiExchange(
      openAiConfig,
      request,
      emptyContent.transport,
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.diagnostics[0]?.code).toBe('backend.empty_response');
    }

    const blankContent = captureFetch(
      200,
      JSON.stringify({
        model: 'gpt-5.6',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '   \n\t' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const blank = await sendOpenAiExchange(
      openAiConfig,
      request,
      blankContent.transport,
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.diagnostics[0]?.code).toBe('backend.empty_response');
    }
  });

  it('accepts empty content when the response carries a tool call', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const { transport } = captureFetch(
      200,
      JSON.stringify({
        model: 'gpt-5.6',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'call_lookup',
                  type: 'function',
                  function: {
                    name: 'calendar_lookup',
                    arguments: '{"week":36}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );

    const result = await sendOpenAiExchange(openAiConfig, request, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('');
      expect(result.exchange.toolCalls).toEqual([
        {
          id: 'call_lookup',
          name: 'calendar_lookup',
          arguments: '{"week":36}',
        },
      ]);
    }
  });

  it('aborts the request after the configured timeout', async () => {
    vi.stubEnv('FIELDWORK_TEST_KEY', 'secret-key');
    const transport: OpenAiTransport = {
      fetch: (async (_url: string, init?: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            );
          });
        });
      }) as typeof fetch,
    };

    const result = await sendOpenAiExchange(
      { ...openAiConfig, timeoutMs: 20 },
      request,
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('backend.request_failed');
      expect(result.diagnostics[0]?.message).toContain('timed out');
    }
  });
});

const sessionEvents = [
  JSON.stringify({
    type: 'step_start',
    sessionID: 'ses_test_1',
    part: { type: 'step-start' },
  }),
  JSON.stringify({
    type: 'text',
    sessionID: 'ses_test_1',
    part: { type: 'text', text: 'Fake reply.' },
  }),
  JSON.stringify({
    type: 'tool_use',
    sessionID: 'ses_test_1',
    part: {
      type: 'tool',
      tool: 'bash',
      callID: 'bash:0',
      state: {
        status: 'completed',
        input: { command: 'echo hi' },
        output: 'hi',
      },
    },
  }),
  JSON.stringify({
    type: 'step_finish',
    sessionID: 'ses_test_1',
    part: {
      type: 'step-finish',
      tokens: { total: 42, input: 20, output: 22 },
      cost: 0,
    },
  }),
].join('\n');

function spawnTransport(outcomes: SpawnOutcome[]): {
  transport: SpawnTransport;
  calls: { command: string; args: string[] }[];
} {
  const calls: { command: string; args: string[] }[] = [];
  const transport: SpawnTransport = (command, args) => {
    calls.push({ command, args });
    const outcome = outcomes[calls.length - 1];
    if (outcome === undefined) {
      return Promise.reject(new Error('unexpected spawn call'));
    }
    return Promise.resolve(outcome);
  };
  return { transport, calls };
}

describe('sendOpencodeExchange', () => {
  it('builds the CLI arguments from the config and session', () => {
    expect(buildOpencodeArgs(opencodeConfig, 'Hello', undefined)).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'anthropic/claude-sonnet-4-5',
      'Hello',
    ]);
    expect(buildOpencodeArgs(opencodeConfig, 'Hello', 'ses_test_1')).toEqual([
      'run',
      '--format',
      'json',
      '-m',
      'anthropic/claude-sonnet-4-5',
      '-s',
      'ses_test_1',
      'Hello',
    ]);
    expect(
      buildOpencodeArgs(
        {
          ...opencodeConfig,
          model: undefined,
          command: 'node',
          args: ['agent.mjs'],
        },
        'Hello',
        undefined,
      ),
    ).toEqual(['agent.mjs', 'run', '--format', 'json', 'Hello']);
  });

  it('builds the message text with and without a session', () => {
    const single: NormalizedExchangeRequest = {
      messages: [{ role: 'user', text: 'Hello.' }],
    };
    expect(buildOpencodeMessage(single, undefined)).toBe('Hello.');
    expect(buildOpencodeMessage(single, 'ses_test_1')).toBe('Hello.');

    const history: NormalizedExchangeRequest = {
      messages: [
        { role: 'user', text: 'First.' },
        { role: 'assistant', text: 'Answer.' },
        { role: 'user', text: 'Second.' },
      ],
    };
    expect(buildOpencodeMessage(history, 'ses_test_1')).toBe('Second.');
    expect(buildOpencodeMessage(history, undefined)).toBe(
      'user: First.\n\nassistant: Answer.\n\nuser: Second.',
    );
    expect(buildOpencodeMessage({ messages: [] }, undefined)).toBeNull();
  });

  it('normalizes JSON events into an exchange', async () => {
    const { transport, calls } = spawnTransport([
      { code: 0, stdout: sessionEvents, stderr: '', spawnError: null },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    expect(calls[0]?.args[calls[0].args.length - 1]).toBe('Hello.');
    if (result.ok) {
      expect(result.exchange.text).toBe('Fake reply.');
      expect(result.exchange.toolCalls).toEqual([
        {
          id: 'bash:0',
          name: 'bash',
          arguments: { command: 'echo hi' },
          result: 'hi',
        },
      ]);
      expect(result.exchange.model).toBe('anthropic/claude-sonnet-4-5');
      expect(result.exchange.provider).toBe('opencode');
      expect(result.exchange.backendSession).toBe('ses_test_1');
      expect(result.exchange.usage).toEqual({
        total: 42,
        input: 20,
        output: 22,
        cost: 0,
      });
    }
  });

  it('drops whitespace-only text parts from the exchange text', async () => {
    // Reasoning models emit whitespace-only text parts while they think; the
    // reply itself arrives as whole parts.
    const noisyEvents = [
      JSON.stringify({
        type: 'step_start',
        sessionID: 'ses_test_1',
        part: { type: 'step-start' },
      }),
      ...Array.from({ length: 12 }, () =>
        JSON.stringify({
          type: 'text',
          sessionID: 'ses_test_1',
          part: { type: 'text', text: '\n\n' },
        }),
      ),
      JSON.stringify({
        type: 'text',
        sessionID: 'ses_test_1',
        part: { type: 'text', text: 'The ball costs $0.05.' },
      }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_test_1',
        part: { type: 'step-finish' },
      }),
    ].join('\n');
    const { transport } = spawnTransport([
      { code: 0, stdout: noisyEvents, stderr: '', spawnError: null },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('The ball costs $0.05.');
    }
  });

  it('reports spawn failures and non-zero exits', async () => {
    const spawnFailure = spawnTransport([
      {
        code: null,
        stdout: '',
        stderr: '',
        spawnError: 'spawn opencode ENOENT',
      },
    ]);
    const failed = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      spawnFailure.transport,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.diagnostics[0]?.code).toBe('backend.request_failed');
      expect(failed.diagnostics[0]?.message).toContain('ENOENT');
    }

    const exitFailure = spawnTransport([
      {
        code: 1,
        stdout: '',
        stderr: 'Error: model not found',
        spawnError: null,
      },
    ]);
    const exited = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      exitFailure.transport,
    );
    expect(exited.ok).toBe(false);
    if (!exited.ok) {
      expect(exited.diagnostics[0]?.code).toBe('backend.command_failed');
      expect(exited.diagnostics[0]?.message).toContain('model not found');
    }
  });

  it('reports stdout without JSON events as a request failure', async () => {
    const { transport } = spawnTransport([
      { code: 0, stdout: 'plain reply\n', stderr: '', spawnError: null },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('backend.request_failed');
    }
  });

  it('rejects parsed events with no text or tool calls', async () => {
    const { transport } = spawnTransport([
      {
        code: 0,
        stdout: [
          JSON.stringify({
            type: 'step_start',
            sessionID: 'ses_test_1',
            part: { type: 'step-start' },
          }),
          JSON.stringify({
            type: 'step_finish',
            sessionID: 'ses_test_1',
            part: {
              type: 'step-finish',
              tokens: { total: 42, input: 20, output: 22 },
              cost: 0,
            },
          }),
        ].join('\n'),
        stderr: '',
        spawnError: null,
      },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.empty_response',
      ]);
      expect(result.diagnostics[0]?.message).toContain('local-agent');
    }
  });

  it('accepts tool-use events without any text parts', async () => {
    const { transport } = spawnTransport([
      {
        code: 0,
        stdout: JSON.stringify({
          type: 'tool_use',
          sessionID: 'ses_test_1',
          part: {
            type: 'tool',
            tool: 'bash',
            callID: 'bash:0',
            state: {
              status: 'completed',
              input: { command: 'echo hi' },
              output: 'hi',
            },
          },
        }),
        stderr: '',
        spawnError: null,
      },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('');
      expect(result.exchange.toolCalls).toEqual([
        {
          id: 'bash:0',
          name: 'bash',
          arguments: { command: 'echo hi' },
          result: 'hi',
        },
      ]);
    }
  });

  it('retries without the session when the CLI reports an unknown session', async () => {
    const { transport, calls } = spawnTransport([
      {
        code: 1,
        stdout: '',
        stderr: 'Error: Session not found',
        spawnError: null,
      },
      { code: 0, stdout: sessionEvents, stderr: '', spawnError: null },
    ]);

    const result = await sendOpencodeExchange(
      opencodeConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
      { session: 'ses_stale' },
    );

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain('ses_stale');
    expect(calls[1]?.args).not.toContain('ses_stale');
    expect(calls[1]?.args).not.toContain('-s');
  });
});

describe('chat start naming', () => {
  it('slugs titles like the sample workspace', () => {
    expect(chatTitleSlug('Rank diagnostics')).toBe('rank-diagnostics');
    expect(chatTitleSlug('Lab meeting agenda')).toBe('lab-meeting-agenda');
    expect(chatTitleSlug('  Odd -- Title!! ')).toBe('odd-title');
    expect(chatTitleSlug('!!!')).toBe('');
  });

  it('derives the chat file name from a date and title', () => {
    expect(chatFileName('Rank diagnostics', '2026-09-02')).toBe(
      '2026-09-02-rank-diagnostics.md',
    );
    expect(chatFileName('!!!', '2026-09-02')).toBeNull();
  });

  it('formats the current local date', () => {
    expect(todayDate(new Date(2026, 8, 2, 10, 30))).toBe('2026-09-02');
    expect(todayDate(new Date(2026, 10, 5, 1, 15))).toBe('2026-11-05');
  });
});

describe('continue-chat serialization', () => {
  it('appends a user and assistant block that reparses cleanly', () => {
    const user = serializeChatMessage({
      role: 'user',
      text: 'Second question.',
    });
    const assistant = serializeChatMessage({
      role: 'assistant',
      text: 'Fresh answer.',
      metadata: {
        provider: 'openai-compatible',
        model: 'gpt-5.6',
        backend: 'research-model',
        at: '2026-09-10T10:00:00Z',
        usage: { prompt_tokens: 12 },
      },
    });
    const body = 'Intro.\n\n' + user + assistant;

    const parsed = parseTranscript(body, 'chat.md');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.preamble).toBe('Intro.\n\n');
    expect(parsed.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(parsed.messages[1]?.metadata).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-5.6',
      backend: 'research-model',
      at: '2026-09-10T10:00:00Z',
      usage: { prompt_tokens: 12 },
    });
  });
});
