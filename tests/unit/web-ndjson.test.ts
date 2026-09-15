import { describe, expect, it } from 'vitest';

import {
  createNdjsonLineParser,
  isTerminalNdjsonEvent,
  parseNdjsonEvent,
  type NdjsonEvent,
} from '../../web/src/shared/ndjson.js';

const encoder = new TextEncoder();

interface Collected {
  events: NdjsonEvent[];
  broken: number;
}

function collect(): {
  parser: ReturnType<typeof createNdjsonLineParser>;
  state: Collected;
} {
  const state: Collected = { events: [], broken: 0 };
  const parser = createNdjsonLineParser({
    event: (event) => state.events.push(event),
    broken: () => {
      state.broken += 1;
    },
  });
  return { parser, state };
}

function deltaOf(event: NdjsonEvent | undefined): string | null {
  return event?.type === 'delta' ? event.text : null;
}

describe('parseNdjsonEvent', () => {
  it('parses delta, created, done, and error lines', () => {
    expect(parseNdjsonEvent('{"type":"delta","text":"hi"}')).toEqual({
      type: 'delta',
      text: 'hi',
      kind: 'message',
    });
    expect(
      parseNdjsonEvent('{"type":"delta","text":"hmm","kind":"thought"}'),
    ).toEqual({ type: 'delta', text: 'hmm', kind: 'thought' });
    // Unknown kinds fall back to the message default.
    expect(
      parseNdjsonEvent('{"type":"delta","text":"x","kind":"wat"}'),
    ).toEqual({ type: 'delta', text: 'x', kind: 'message' });
    expect(
      parseNdjsonEvent('{"type":"created","chat":{"chatId":"c1"}}'),
    ).toEqual({ type: 'created', chat: { chatId: 'c1' } });
    expect(parseNdjsonEvent('{"type":"done","result":{"ok":true}}')).toEqual({
      type: 'done',
      result: { ok: true },
    });
    const error = parseNdjsonEvent(
      '{"type":"error","status":502,"errorText":"nope","diagnostics":[{"code":"backend.x","severity":"error","file":"","fieldPath":null,"message":"boom","line":null,"column":null}]}',
    );
    expect(error?.type).toBe('error');
    if (error?.type !== 'error') throw new Error('expected error');
    expect(error.status).toBe(502);
    expect(error.errorText).toBe('nope');
    expect(error.diagnostics[0]?.code).toBe('backend.x');
  });

  it('skips blanks and malformed lines', () => {
    expect(parseNdjsonEvent('   ')).toBeNull();
    expect(parseNdjsonEvent('not json')).toBeNull();
    expect(parseNdjsonEvent('{"no":"type"}')).toBeNull();
    expect(parseNdjsonEvent('{"type":"delta"}')).toBeNull();
    expect(parseNdjsonEvent('{"type":"unknown"}')).toBeNull();
  });

  it('classifies done and error as terminal', () => {
    expect(isTerminalNdjsonEvent({ type: 'done', result: null })).toBe(true);
    expect(
      isTerminalNdjsonEvent({
        type: 'error',
        status: 0,
        errorText: null,
        diagnostics: [],
      }),
    ).toBe(true);
    expect(
      isTerminalNdjsonEvent({ type: 'delta', text: 'x', kind: 'message' }),
    ).toBe(false);
    expect(isTerminalNdjsonEvent({ type: 'created', chat: null })).toBe(false);
  });
});

describe('createNdjsonLineParser', () => {
  it('reassembles a multi-byte character split across chunks', () => {
    const line =
      '{"type":"delta","text":"h\u00e9llo \u4e16\u754c"}\n' +
      '{"type":"done","result":null}\n';
    const bytes = encoder.encode(line);
    const multibyte = encoder.encode('\u00e9');
    const split = bytes.indexOf(multibyte[0] ?? 0);
    expect(split).toBeGreaterThan(0);
    const { parser, state } = collect();
    parser.push(bytes.slice(0, split + 1));
    parser.push(bytes.slice(split + 1));
    parser.end();
    expect(state.broken).toBe(0);
    expect(deltaOf(state.events[0])).toBe('h\u00e9llo \u4e16\u754c');
    expect(state.events[1]?.type).toBe('done');
  });

  it('splits lines on LF, CRLF, and bare CR', () => {
    const { parser, state } = collect();
    parser.push(
      encoder.encode(
        '{"type":"delta","text":"a"}\r\n' +
          '{"type":"delta","text":"b"}\r' +
          '{"type":"delta","text":"c"}\n' +
          '{"type":"done","result":null}\n',
      ),
    );
    parser.end();
    expect(
      state.events
        .filter((event) => event.type === 'delta')
        .map((event) => deltaOf(event)),
    ).toEqual(['a', 'b', 'c']);
    expect(state.broken).toBe(0);
  });

  it('keeps a CRLF pair intact across a chunk boundary', () => {
    const { parser, state } = collect();
    parser.push(encoder.encode('{"type":"delta","text":"a"}\r'));
    parser.push(encoder.encode('\n{"type":"done","result":null}\n'));
    parser.end();
    expect(state.events.map((event) => event.type)).toEqual(['delta', 'done']);
    expect(state.broken).toBe(0);
  });

  it('synthesizes broken after a trailing partial line at close', () => {
    const { parser, state } = collect();
    parser.push(encoder.encode('{"type":"delta","text":"partial"}'));
    parser.end();
    expect(deltaOf(state.events[0])).toBe('partial');
    expect(state.broken).toBe(1);
  });

  it('does not report broken once a terminal event arrived', () => {
    const { parser, state } = collect();
    parser.push(
      encoder.encode(
        '{"type":"delta","text":"a"}\n{"type":"done","result":{}}\n',
      ),
    );
    parser.end();
    expect(state.broken).toBe(0);
  });

  it('ignores blank and bad lines and still reports broken without a terminal', () => {
    const { parser, state } = collect();
    parser.push(encoder.encode('\n\ngarbage\n{"type":"delta","text":"ok"}\n'));
    parser.end();
    expect(state.events).toHaveLength(1);
    expect(deltaOf(state.events[0])).toBe('ok');
    expect(state.broken).toBe(1);
  });
});
