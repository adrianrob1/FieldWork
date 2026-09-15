import type { ServerResponse } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acpExchangeFromUpdates,
  createAcpDeltaEmitter,
} from '../../src/backends/acp.js';
import type { OpenAiBackendConfig } from '../../src/backends/config.js';
import {
  createSseParser,
  sendOpenAiExchange,
  type OpenAiTransport,
} from '../../src/backends/openai.js';
import { createOpencodeDeltaStream } from '../../src/backends/opencode.js';
import type { NormalizedExchangeRequest } from '../../src/backends/types.js';
import {
  acceptsNdjson,
  createNdjsonTransport,
} from '../../src/server/ndjson.js';

const openAiConfig: OpenAiBackendConfig = {
  type: 'openai',
  name: 'stream-model',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5.6',
  apiKeyEnv: undefined,
  timeoutMs: 5000,
};

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('createSseParser', () => {
  it('reassembles data lines across reads and ignores comments', () => {
    const payloads: string[] = [];
    const parser = createSseParser((data) => payloads.push(data));
    const encoder = new TextEncoder();
    parser.push(encoder.encode('data: {"a"'));
    parser.push(encoder.encode(':1}\n'));
    parser.push(encoder.encode(': keep-alive comment\n'));
    parser.push(encoder.encode('\n'));
    parser.push(encoder.encode('data: [DONE]\n'));
    parser.end();

    expect(payloads).toEqual(['{"a":1}', '[DONE]']);
  });

  it('decodes multi-byte characters split across reads', () => {
    const payloads: string[] = [];
    const parser = createSseParser((data) => payloads.push(data));
    const bytes = new TextEncoder().encode('data: {"text":"héllo 🌍"}\n');
    const middle = Math.floor(bytes.length / 2);
    parser.push(bytes.slice(0, middle));
    parser.push(bytes.slice(middle));
    parser.end();

    expect(payloads).toEqual(['{"text":"héllo 🌍"}']);
  });

  it('flushes a trailing data line without a newline', () => {
    const payloads: string[] = [];
    const parser = createSseParser((data) => payloads.push(data));
    parser.push(new TextEncoder().encode('data: tail'));
    parser.end();
    expect(payloads).toEqual(['tail']);
  });
});

describe('createOpencodeDeltaStream', () => {
  it('emits deltas for complete events and buffers partial lines', () => {
    const deltas: string[] = [];
    const stream = createOpencodeDeltaStream((text) => deltas.push(text));

    stream.push('{"type":"text","part":{"text":"Hel');
    stream.push('lo."}}\n{"type":"text","part":{"text":"World."}}\n');
    expect(deltas).toEqual(['Hello.', '\n\n', 'World.']);

    stream.push('{"type":"text","part":{"text":"Tail."}}');
    stream.flush();
    expect(deltas).toEqual(['Hello.', '\n\n', 'World.', '\n\n', 'Tail.']);
  });

  it('ignores non-text events and empty text', () => {
    const deltas: string[] = [];
    const stream = createOpencodeDeltaStream((text) => deltas.push(text));
    stream.push(
      [
        JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: '' } }),
        JSON.stringify({ type: 'tool_use', part: { tool: 'bash' } }),
        JSON.stringify({ type: 'text', part: { text: 'Answer.' } }),
      ].join('\n') + '\n',
    );
    stream.flush();
    expect(deltas).toEqual(['Answer.']);
  });

  it('drops whitespace-only text parts and their separators', () => {
    // Reasoning models stream whitespace-only parts while thinking; they must
    // not grow the bubble with invisible blank lines or insert separators.
    const deltas: string[] = [];
    const stream = createOpencodeDeltaStream((text) => deltas.push(text));
    stream.push(
      [
        ...Array.from({ length: 12 }, () =>
          JSON.stringify({
            type: 'text',
            part: { type: 'text', text: '\n\n' },
          }),
        ),
        JSON.stringify({
          type: 'text',
          part: { type: 'text', text: 'Hello.' },
        }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: '  \n ' } }),
        JSON.stringify({
          type: 'text',
          part: { type: 'text', text: 'World.' },
        }),
      ].join('\n') + '\n',
    );
    stream.flush();
    expect(deltas).toEqual(['Hello.', '\n\n', 'World.']);
  });
});

describe('createAcpDeltaEmitter', () => {
  it('maps message and thought chunks into independent grouped streams', () => {
    const deltas: { text: string; kind: string }[] = [];
    const emitter = createAcpDeltaEmitter((text, kind) => {
      deltas.push({ text, kind });
    });

    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'First ' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: 'hidden ' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: 'reasoning.' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't2',
        content: { type: 'text', text: 'Second thought.' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'message.' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        raw_content: 'Second.',
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm2',
        raw_content: '',
      },
    });

    const messageText = deltas
      .filter((entry) => entry.kind === 'message')
      .map((entry) => entry.text)
      .join('');
    const thoughtText = deltas
      .filter((entry) => entry.kind === 'thought')
      .map((entry) => entry.text)
      .join('');
    // A thought between two chunks of the same message neither splits the
    // message stream nor appears in it.
    expect(messageText).toBe('First message.\n\nSecond.');
    // Distinct thoughts of the same kind are separated by a blank line.
    expect(thoughtText).toBe('hidden reasoning.\n\nSecond thought.');
  });

  it('drops whitespace-only lead-in chunks before the first visible text', () => {
    const deltas: { text: string; kind: string }[] = [];
    const emitter = createAcpDeltaEmitter((text, kind) => {
      deltas.push({ text, kind });
    });

    // Codex opens its reasoning with chunks that hold only newlines.
    emitter.accept({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: '\n\n' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 't1',
        content: { type: 'text', text: '  \nClarifying the request' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '\n' },
      },
    });
    emitter.accept({
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'Answer.' },
      },
    });

    const messageText = deltas
      .filter((entry) => entry.kind === 'message')
      .map((entry) => entry.text)
      .join('');
    const thoughtText = deltas
      .filter((entry) => entry.kind === 'thought')
      .map((entry) => entry.text)
      .join('');
    expect(thoughtText).toBe('Clarifying the request');
    expect(messageText).toBe('Answer.');
  });

  it('keeps thought text out of the message text while recording it on the exchange', () => {
    const updates = [
      {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 't1',
          content: { type: 'text', text: '\n\nInternal reasoning.' },
        },
      },
      {
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'm1',
          content: { type: 'text', text: 'Answer only.' },
        },
      },
    ];
    const exchange = acpExchangeFromUpdates(updates, 'ses_thought');
    expect(exchange.text).toBe('Answer only.');
    expect(exchange.text).not.toContain('Internal reasoning.');
    expect(exchange.thought).toBe('Internal reasoning.');
  });

  it('joins recorded thought buckets without whitespace-only lead-ins', () => {
    const updates = [
      {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 't1',
          content: { type: 'text', text: '\n\nFirst thought ' },
        },
      },
      {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 't1',
          content: { type: 'text', text: 'continues.' },
        },
      },
      {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 't2',
          content: { type: 'text', text: '  \n\n  ' },
        },
      },
      {
        update: {
          sessionUpdate: 'agent_thought_chunk',
          messageId: 't2',
          content: { type: 'text', text: 'Second thought.\n\n' },
        },
      },
    ];
    const exchange = acpExchangeFromUpdates(updates, 'ses_thought');
    expect(exchange.thought).toBe(
      'First thought continues.\n\nSecond thought.',
    );
  });
});

describe('sendOpenAiExchange streaming', () => {
  const request: NormalizedExchangeRequest = {
    messages: [{ role: 'user', text: 'Hello.' }],
  };

  it('requests a stream and reports deltas that rebuild the final text', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const response = sseResponse([
      'data: {"model":"gpt-5.6","choices":[{"index":0,"delta":{"role":"assistant","content":"Fresh "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"streamed "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"answer."},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":19}}\n\n',
      'data: [DONE]\n\n',
    ]);
    const transport: OpenAiTransport = {
      fetch: ((url: string, init?: RequestInit) => {
        requests.push({ url, init: init ?? {} });
        return Promise.resolve(response);
      }) as typeof fetch,
    };

    const deltas: string[] = [];
    const result = await sendOpenAiExchange(openAiConfig, request, transport, {
      onDelta: (text) => deltas.push(text),
    });

    expect(result.ok).toBe(true);
    const body = JSON.parse(requests[0]?.init.body as string) as {
      stream?: boolean;
    };
    expect(body.stream).toBe(true);
    if (result.ok) {
      expect(deltas.join('')).toBe('Fresh streamed answer.');
      expect(result.exchange.text).toBe('Fresh streamed answer.');
      expect(result.exchange.model).toBe('gpt-5.6');
      expect(result.exchange.usage).toEqual({ total_tokens: 19 });
      expect(result.exchange.toolCalls).toEqual([]);
    }
  });

  it('forwards reasoning_content as thought and leaves content untouched', async () => {
    const response = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let me think "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"about it."}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"The answer."}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const transport: OpenAiTransport = {
      fetch: () => Promise.resolve(response),
    };

    const deltas: { text: string; kind: string }[] = [];
    const result = await sendOpenAiExchange(openAiConfig, request, transport, {
      onDelta: (text, kind) => deltas.push({ text, kind }),
    });

    expect(result.ok).toBe(true);
    expect(
      deltas
        .filter((entry) => entry.kind === 'thought')
        .map((entry) => entry.text)
        .join(''),
    ).toBe('Let me think about it.');
    expect(
      deltas
        .filter((entry) => entry.kind === 'message')
        .map((entry) => entry.text)
        .join(''),
    ).toBe('The answer.');
    if (result.ok) {
      // Reasoning never lands in the final text, but it is recorded on the
      // exchange so the UI can collapse it under the committed reply.
      expect(result.exchange.text).toBe('The answer.');
      expect(result.exchange.thought).toBe('Let me think about it.');
    }
  });

  it('drops whitespace-only reasoning lead-ins in the stream and the exchange', async () => {
    const response = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"\\n\\n"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"  Thinking hard "}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"now."}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"The answer."}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const transport: OpenAiTransport = {
      fetch: () => Promise.resolve(response),
    };

    const deltas: { text: string; kind: string }[] = [];
    const result = await sendOpenAiExchange(openAiConfig, request, transport, {
      onDelta: (text, kind) => deltas.push({ text, kind }),
    });

    expect(result.ok).toBe(true);
    const thoughtText = deltas
      .filter((entry) => entry.kind === 'thought')
      .map((entry) => entry.text)
      .join('');
    expect(thoughtText).toBe('Thinking hard now.');
    if (result.ok) {
      expect(result.exchange.thought).toBe('Thinking hard now.');
    }
  });

  it('records reasoning_content from a non-streaming completion', async () => {
    const transport: OpenAiTransport = {
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'gpt-5.6',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: 'Plain answer.',
                    reasoning_content: '\n\nSilent reasoning.  ',
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    };

    const result = await sendOpenAiExchange(openAiConfig, request, transport);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('Plain answer.');
      expect(result.exchange.thought).toBe('Silent reasoning.');
    }
  });

  it('accumulates streamed tool calls without breaking', async () => {
    const response = sseResponse([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"week\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"36}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const transport: OpenAiTransport = {
      fetch: () => Promise.resolve(response),
    };

    const deltas: string[] = [];
    const result = await sendOpenAiExchange(openAiConfig, request, transport, {
      onDelta: (text) => deltas.push(text),
    });

    expect(deltas).toEqual([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('');
      expect(result.exchange.toolCalls).toEqual([
        { id: 'call_1', name: 'lookup', arguments: '{"week":36}' },
      ]);
    }
  });

  it('keeps the non-stream request byte-identical without onDelta', async () => {
    const requests: { init: RequestInit }[] = [];
    const transport: OpenAiTransport = {
      fetch: ((_url: string, init?: RequestInit) => {
        requests.push({ init: init ?? {} });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              model: 'gpt-5.6',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Plain answer.' },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }) as typeof fetch,
    };

    const result = await sendOpenAiExchange(openAiConfig, request, transport);
    expect(result.ok).toBe(true);
    const body = JSON.parse(requests[0]?.init.body as string) as {
      stream?: boolean;
    };
    expect('stream' in body).toBe(false);
  });
});

describe('createNdjsonTransport', () => {
  function fakeResponse(): {
    response: ServerResponse;
    lines(): string[];
    head(): { status: number; headers: Record<string, string> } | null;
  } {
    const chunks: string[] = [];
    let head: { status: number; headers: Record<string, string> } | null = null;
    const fake = {
      writeHead(status: number, headers: Record<string, string>) {
        head = { status, headers };
        return fake;
      },
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end() {},
      on() {
        return fake;
      },
    };
    return {
      response: fake as unknown as ServerResponse,
      lines: () =>
        chunks
          .join('')
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as unknown),
      head: () => head,
    };
  }

  it('emits the documented event shapes and commits chunked headers once', () => {
    const fake = fakeResponse();
    const transport = createNdjsonTransport(fake.response);

    expect(transport.started).toBe(false);
    transport.created({
      chatId: 'c1',
      title: 'C',
      file: 'chats/c1.md',
      contentHash: null,
    });
    transport.delta('');
    transport.delta('Hello');
    transport.done({ chatId: 'c1' });
    transport.end();

    const head = fake.head();
    expect(head?.status).toBe(200);
    expect(head?.headers['content-type']).toBe(
      'application/x-ndjson; charset=utf-8',
    );
    expect(head?.headers['cache-control']).toBe('no-store');
    expect(head?.headers['transfer-encoding']).toBe('chunked');
    expect(fake.lines()).toEqual([
      {
        type: 'created',
        chat: {
          chatId: 'c1',
          title: 'C',
          file: 'chats/c1.md',
          contentHash: null,
        },
      },
      { type: 'delta', text: 'Hello' },
      { type: 'done', result: { chatId: 'c1' } },
    ]);
  });

  it('emits a failure event in the classified-send-failure shape', () => {
    const fake = fakeResponse();
    const transport = createNdjsonTransport(fake.response);
    transport.error(502, 'Backend failed.', [
      {
        code: 'backend.http_status',
        message: 'Backend failed.',
        severity: 'error',
      },
    ]);
    transport.end();

    expect(fake.lines()).toEqual([
      {
        type: 'error',
        status: 502,
        errorText: 'Backend failed.',
        diagnostics: [
          {
            code: 'backend.http_status',
            message: 'Backend failed.',
            severity: 'error',
          },
        ],
      },
    ]);
  });
});

describe('acceptsNdjson', () => {
  it('matches only an explicit ndjson media type', () => {
    expect(acceptsNdjson('application/x-ndjson')).toBe(true);
    expect(acceptsNdjson('text/plain, application/x-ndjson')).toBe(true);
    expect(acceptsNdjson('application/x-ndjson; q=1')).toBe(true);
    expect(acceptsNdjson('application/json')).toBe(false);
    expect(acceptsNdjson('*/*')).toBe(false);
    expect(acceptsNdjson(undefined)).toBe(false);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
