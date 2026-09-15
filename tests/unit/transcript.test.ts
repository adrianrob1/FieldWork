import { describe, expect, it } from 'vitest';

import {
  messageMetadataSchema,
  toolCallSchema,
  messageAttachmentSchema,
  attachmentReferenceSchema,
} from '../../src/domain/transcript.js';
import {
  parseTranscript,
  serializeChatMessage,
  serializeTranscript,
  windowMessages,
  type TranscriptMessage,
} from '../../src/files/transcript.js';

const canonicalTranscript = [
  'Planning thread for the weekly lab meeting.',
  '',
  '## user',
  '',
  'Please draft the agenda for Thursday lab meeting.',
  '',
  '## assistant',
  '',
  '```yaml',
  'provider: openai',
  'model: gpt-5.6',
  'at: 2026-09-10T09:30:00Z',
  'tool_calls:',
  '  - id: call_calendar_lookup',
  '    name: calendar_lookup',
  '    arguments: |',
  '      week: 2026-09-07',
  '    result: 2 open slots on Thursday',
  'attachments:',
  '  - id: resource_soap_scaling',
  '    label: Scaling notes',
  '```',
  '',
  'Here is the draft agenda.',
  '',
  '',
].join('\n');

describe('parseTranscript', () => {
  it('treats a body without message headings as a zero-message transcript', () => {
    const source = '# Notes\n\nNo messages here.\n';
    const result = parseTranscript(source, 'chat.md');

    expect(result.preamble).toBe(source);
    expect(result.messages).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('splits preamble and messages and reports heading locations', () => {
    const result = parseTranscript(canonicalTranscript, 'chat.md');

    expect(result.diagnostics).toEqual([]);
    expect(result.preamble).toBe(
      'Planning thread for the weekly lab meeting.\n\n',
    );
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.messages[0]?.headingLocation).toEqual({ line: 3, column: 1 });
    expect(result.messages[1]?.headingLocation).toEqual({ line: 7, column: 1 });
    expect(result.messages[0]?.text).toBe(
      'Please draft the agenda for Thursday lab meeting.',
    );
    expect(result.messages[1]?.text).toBe('Here is the draft agenda.');
  });

  it('accepts legacy capitalized headings case-insensitively', () => {
    const result = parseTranscript(
      '\n## User\n\nQuestion\n\n## ASSISTANT\n\nAnswer\n',
      'chat.md',
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(result.messages[0]?.text).toBe('Question');
  });

  it('parses tool calls and attachments from the metadata fence', () => {
    const result = parseTranscript(canonicalTranscript, 'chat.md');
    const assistant = result.messages[1];

    expect(assistant?.metadataRaw).toEqual(assistant?.metadata);
    expect(assistant?.metadata).toEqual({
      provider: 'openai',
      model: 'gpt-5.6',
      at: '2026-09-10T09:30:00Z',
      tool_calls: [
        {
          id: 'call_calendar_lookup',
          name: 'calendar_lookup',
          arguments: 'week: 2026-09-07\n',
          result: '2 open slots on Thursday',
        },
      ],
      attachments: [{ id: 'resource_soap_scaling', label: 'Scaling notes' }],
    });
  });

  it('keeps the message and text when metadata fails validation', () => {
    const source = [
      '## assistant',
      '',
      '```yaml',
      'at: yesterday',
      'attachments:',
      '  - label: Missing target',
      '```',
      '',
      'Body text stays readable.',
      '',
    ].join('\n');

    const result = parseTranscript(source, 'chat.md');
    const message = result.messages[0];

    expect(result.messages).toHaveLength(1);
    expect(message?.text).toBe('Body text stays readable.');
    expect(message?.metadata).toBeNull();
    expect(message?.metadataRaw).toEqual({
      at: 'yesterday',
      attachments: [{ label: 'Missing target' }],
    });
    expect(
      result.diagnostics.map((entry) => [entry.code, entry.severity]),
    ).toEqual([['transcript.metadata', 'error']]);
  });

  it('reports a diagnostic for an unclosed metadata fence but keeps the text', () => {
    const source =
      '## assistant\n\n```yaml\nprovider: openai\n\nText survives.\n';

    const result = parseTranscript(source, 'chat.md');
    const message = result.messages[0];

    expect(message?.text).toContain('```yaml');
    expect(message?.text).toContain('Text survives.');
    expect(message?.metadata).toBeNull();
    expect(message?.metadataRaw).toBeNull();
    expect(result.diagnostics[0]?.code).toBe('transcript.fence');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  it('treats a non-yaml fence after the heading as message text', () => {
    const source = '## user\n\n```json\n{"a": 1}\n```\n\nQuestion.\n';

    const result = parseTranscript(source, 'chat.md');

    expect(result.diagnostics).toEqual([]);
    expect(result.messages[0]?.metadata).toBeNull();
    expect(result.messages[0]?.text).toBe(
      '```json\n{"a": 1}\n```\n\nQuestion.',
    );
  });

  it('keeps level-2 headings inside message text without diagnostics', () => {
    const source = '## user\n\nText.\n\n## Other heading\n\nMore text.\n';

    const result = parseTranscript(source, 'chat.md');

    expect(result.diagnostics).toEqual([]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.text).toBe(
      'Text.\n\n## Other heading\n\nMore text.',
    );
  });

  it('allows level-3 headings inside message text', () => {
    const source = '## assistant\n\n### Detail\n\nText.\n';

    const result = parseTranscript(source, 'chat.md');

    expect(result.diagnostics).toEqual([]);
    expect(result.messages[0]?.text).toBe('### Detail\n\nText.');
  });
});

describe('serializeTranscript', () => {
  it('round-trips a canonical transcript byte for byte', () => {
    const result = parseTranscript(canonicalTranscript, 'chat.md');

    expect(serializeTranscript(result.preamble, result.messages)).toBe(
      canonicalTranscript,
    );
  });

  it('round-trips messages and preamble through a reparse', () => {
    const source = [
      'Preamble\n',
      '',
      '## User',
      '',
      'Question  ',
      '',
      '',
      '## assistant',
      '',
      'Answer.',
    ].join('\n');
    const parsed = parseTranscript(source, 'chat.md');
    const serialized = serializeTranscript(parsed.preamble, parsed.messages);
    const reparsed = parseTranscript(serialized, 'chat.md');

    expect(reparsed.preamble).toBe(parsed.preamble);
    expect(reparsed.messages.map(contentOf)).toEqual(
      parsed.messages.map(contentOf),
    );
    expect(serializeTranscript(reparsed.preamble, reparsed.messages)).toBe(
      serialized,
    );
  });

  it('is deterministic for equal inputs', () => {
    const message = {
      role: 'assistant' as const,
      text: 'Answer.',
      metadata: {
        provider: 'openai',
        usage: { input: 12, output: 4 },
        'x-retained': true,
      },
    };

    expect(serializeChatMessage(message)).toBe(serializeChatMessage(message));
    expect(serializeChatMessage(message)).toBe(
      [
        '## assistant',
        '',
        '```yaml',
        'provider: openai',
        'usage:',
        '  input: 12',
        '  output: 4',
        'x-retained: true',
        '```',
        '',
        'Answer.',
        '',
        '',
      ].join('\n'),
    );
  });

  it('emits the fence from metadata and preserves empty messages', () => {
    expect(serializeChatMessage({ role: 'user', text: '' })).toBe(
      '## user\n\n',
    );
    expect(serializeChatMessage({ role: 'tool', text: '\nTrimmed.\n\n' })).toBe(
      '## tool\n\nTrimmed.\n\n',
    );
    const fenced = serializeChatMessage({
      role: 'assistant',
      text: 'Answer.',
      metadata: { at: '2026-09-10' },
    });
    expect(fenced).toBe(
      '## assistant\n\n```yaml\nat: 2026-09-10\n```\n\nAnswer.\n\n',
    );
    expect(parseTranscript(fenced, 'chat.md').messages[0]?.metadata?.at).toBe(
      '2026-09-10',
    );
  });

  it('round-trips a serialized transcript of parsed invalid metadata', () => {
    const source = '## assistant\n\n```yaml\nat: yesterday\n```\n\nText.\n';
    const parsed = parseTranscript(source, 'chat.md');
    const serialized = serializeTranscript('', parsed.messages);
    const reparsed = parseTranscript(serialized, 'chat.md');

    expect(reparsed.messages).toEqual(parsed.messages);
    expect(reparsed.diagnostics.map((entry) => entry.code)).toEqual(
      parsed.diagnostics.map((entry) => entry.code),
    );
  });
});

describe('message text round-trip identities', () => {
  function expectRoundTrip(
    text: string,
    metadata: Record<string, unknown> | null = null,
    expectedMetadata: Record<string, unknown> | null = metadata,
  ): void {
    const serialized = serializeTranscript('', [
      { role: 'assistant', text, metadata: metadata ?? undefined },
    ]);
    const parsed = parseTranscript(serialized, 'chat.md');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]?.role).toBe('assistant');
    expect(parsed.messages[0]?.text).toBe(text);
    expect(parsed.messages[0]?.metadata).toEqual(expectedMetadata);
    const reserialized = serializeTranscript('', parsed.messages);
    expect(reserialized).toBe(serialized);
    expect(parseTranscript(reserialized, 'chat.md').messages[0]?.text).toBe(
      text,
    );
  }

  it('keeps a yaml fence that is not at the start of the text', () => {
    expectRoundTrip('Intro.\n\n```yaml\nkeep: true\n```\n\nOutro.', {
      at: '2026-09-10T10:00:00Z',
    });
  });

  it('keeps a text that starts with a non-yaml fence', () => {
    expectRoundTrip('```json\n{"a": 1}\n```\n\nBody.');
  });

  it('keeps a text that starts with a longer yaml fence', () => {
    expectRoundTrip('````yaml\nnot metadata\n````');
  });

  it('keeps a text that starts with an uppercase yaml info string', () => {
    expectRoundTrip('```YAML\nnot metadata\n```');
  });

  it('keeps heading-like text that is not a level-2 heading', () => {
    expectRoundTrip('### Level three\n\n##nospace\n\nBody.');
  });

  it('keeps an ordinary summary heading as plain text', () => {
    expectRoundTrip('## Summary\n\nplain');
  });

  it('escapes a full-line role heading and marks the message', () => {
    expectRoundTrip('Before.\n\n## user\n\nAfter.', null, {
      text_escaped: true,
    });
  });

  it('escapes role headings case-insensitively', () => {
    expectRoundTrip('## USER\n\n## Tool', null, { text_escaped: true });
  });

  it('escapes an embedded assistant heading between other lines', () => {
    expectRoundTrip(
      'One.\n\n## assistant\n\nTwo.\n\n## SYSTEM\n\nThree.',
      null,
      {
        text_escaped: true,
      },
    );
  });

  it('escapes a role heading as the only content', () => {
    expectRoundTrip('## user', null, { text_escaped: true });
  });

  it('escapes role headings in text with CRLF line endings', () => {
    expectRoundTrip('First.\r\n## user\r\nThird.', null, {
      text_escaped: true,
    });
  });

  it('escapes a role line inside a fenced block of the text', () => {
    expectRoundTrip('```md\n## user\n```', null, { text_escaped: true });
  });

  it('escapes and marks a text with both a role line and a yaml fence start', () => {
    expectRoundTrip('## user\n\n```yaml\na: 1\n```', null, {
      text_escaped: true,
    });
  });

  it('keeps a text that starts with a closed yaml fence via an empty metadata fence', () => {
    expectRoundTrip('```yaml\na: 1\n```\n\nBody.', null, {});
  });

  it('keeps a text that starts with an unclosed yaml fence via an empty metadata fence', () => {
    expectRoundTrip('```yaml\na: 1\n\nBody.', null, {});
  });

  it('keeps a text that starts with a yaml fence when metadata is present', () => {
    expectRoundTrip('```yaml\na: 1\n```\n\n## Summary\n\nDone.', {
      provider: 'openai',
      at: '2026-09-10T12:00:00Z',
    });
  });

  it('keeps literal escaped role lines that the writer never produced', () => {
    expectRoundTrip('\\## user');
    expectRoundTrip('\\\\## user');
  });

  it('round-trips a metadata-carrying message with every collision at once', () => {
    const metadata = { provider: 'openai', at: '2026-09-10T12:00:00Z' };
    expectRoundTrip(
      '```yaml\na: 1\n```\n\n## Summary\n\n## user\n\nDone.',
      metadata,
      { ...metadata, text_escaped: true },
    );
  });

  it('marks serialized heading-containing texts with text_escaped in the fence', () => {
    expect(
      serializeChatMessage({
        role: 'assistant',
        text: 'A.\n\n## user\n\nB.',
      }),
    ).toBe(
      [
        '## assistant',
        '',
        '```yaml',
        'text_escaped: true',
        '```',
        '',
        'A.',
        '',
        '\\## user',
        '',
        'B.',
        '',
        '',
      ].join('\n'),
    );
    expect(
      serializeChatMessage({
        role: 'assistant',
        text: '## USER',
        metadata: { provider: 'openai' },
      }),
    ).toBe(
      [
        '## assistant',
        '',
        '```yaml',
        'provider: openai',
        'text_escaped: true',
        '```',
        '',
        '\\## USER',
        '',
        '',
      ].join('\n'),
    );
  });

  it('emits an explicit empty metadata fence for fence-start text without metadata', () => {
    const serialized = serializeChatMessage({
      role: 'assistant',
      text: '```yaml\na: 1\n```\n\nBody.',
    });
    expect(serialized).toBe(
      [
        '## assistant',
        '',
        '```yaml',
        '{}',
        '```',
        '',
        '```yaml',
        'a: 1',
        '```',
        '',
        'Body.',
        '',
        '',
      ].join('\n'),
    );
  });

  it('parses v1 bodies without any new markers to the same messages', () => {
    const source = [
      'Planning notes.',
      '',
      '## user',
      '',
      'Summarize the experiment.',
      '',
      '## assistant',
      '',
      '```yaml',
      'provider: openai',
      'at: 2026-09-10T09:30:00Z',
      '```',
      '',
      '## Summary',
      '',
      'The experiment converged.',
      '',
      '',
    ].join('\n');

    const parsed = parseTranscript(source, 'chat.md');

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.messages.map(contentOf)).toEqual([
      {
        role: 'user',
        text: 'Summarize the experiment.',
        metadata: null,
        metadataRaw: null,
      },
      {
        role: 'assistant',
        text: '## Summary\n\nThe experiment converged.',
        metadata: { provider: 'openai', at: '2026-09-10T09:30:00Z' },
        metadataRaw: { provider: 'openai', at: '2026-09-10T09:30:00Z' },
      },
    ]);
    expect(serializeTranscript(parsed.preamble, parsed.messages)).toBe(source);
  });
});

describe('windowMessages', () => {
  function windowed(count: number, offset = 0): TranscriptMessage[] {
    return Array.from({ length: count }, (_, index) => ({
      role: 'user' as const,
      text: `m${offset + index}`,
      metadata: null,
      metadataRaw: null,
      headingLocation: { line: offset + index + 1, column: 1 },
    }));
  }

  it('returns an empty window for an empty transcript', () => {
    const result = windowMessages([]);

    expect(result.messages).toEqual([]);
    expect(result.hasEarlier).toBe(false);
    expect(result.earlierCursor).toBeUndefined();
  });

  it('returns every message when fewer than the default limit exist', () => {
    const messages = windowed(10);
    const result = windowMessages(messages);

    expect(result.messages).toEqual(messages);
    expect(result.hasEarlier).toBe(false);
    expect(result.earlierCursor).toBeUndefined();
  });

  it('returns every message when exactly the default limit exists', () => {
    const messages = windowed(50);
    const result = windowMessages(messages);

    expect(result.messages).toHaveLength(50);
    expect(result.hasEarlier).toBe(false);
    expect(result.earlierCursor).toBeUndefined();
  });

  it('returns the newest window by default and pages back to index zero', () => {
    const messages = windowed(60);
    const newest = windowMessages(messages);

    expect(newest.messages.map((message) => message.text)).toEqual(
      Array.from({ length: 50 }, (_, index) => `m${index + 10}`),
    );
    expect(newest.hasEarlier).toBe(true);
    expect(newest.earlierCursor).toBe('10');

    const earliest = windowMessages(messages, {
      before: newest.earlierCursor,
    });
    expect(earliest.messages.map((message) => message.text)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${index}`),
    );
    expect(earliest.hasEarlier).toBe(false);
    expect(earliest.earlierCursor).toBeUndefined();
  });

  it('pages explicit-limit windows back to the first message', () => {
    const messages = windowed(10);

    const newest = windowMessages(messages, { limit: 3 });
    expect(newest.messages.map((message) => message.text)).toEqual([
      'm7',
      'm8',
      'm9',
    ]);
    expect(newest.hasEarlier).toBe(true);
    expect(newest.earlierCursor).toBe('7');

    const middle = windowMessages(messages, {
      limit: 3,
      before: newest.earlierCursor,
    });
    expect(middle.messages.map((message) => message.text)).toEqual([
      'm4',
      'm5',
      'm6',
    ]);
    expect(middle.earlierCursor).toBe('4');

    const next = windowMessages(messages, {
      limit: 3,
      before: middle.earlierCursor,
    });
    expect(next.messages.map((message) => message.text)).toEqual([
      'm1',
      'm2',
      'm3',
    ]);
    expect(next.earlierCursor).toBe('1');

    const first = windowMessages(messages, {
      limit: 3,
      before: next.earlierCursor,
    });
    expect(first.messages.map((message) => message.text)).toEqual(['m0']);
    expect(first.hasEarlier).toBe(false);
    expect(first.earlierCursor).toBeUndefined();
  });

  it('treats an invalid before cursor as an empty window', () => {
    const messages = windowed(5);

    for (const before of ['abc', '-1', '1.5', '0', '']) {
      const result = windowMessages(messages, { before });
      expect(result.messages).toEqual([]);
      expect(result.hasEarlier).toBe(false);
      expect(result.earlierCursor).toBeUndefined();
    }
  });

  it('clamps a before cursor beyond the transcript to the newest window', () => {
    const messages = windowed(10);
    const result = windowMessages(messages, { limit: 3, before: '999' });

    expect(result.messages.map((message) => message.text)).toEqual([
      'm7',
      'm8',
      'm9',
    ]);
    expect(result.earlierCursor).toBe('7');
  });

  it('clamps the limit between 1 and 200', () => {
    const messages = windowed(5);

    expect(windowMessages(messages, { limit: 0 }).messages).toHaveLength(1);
    expect(windowMessages(messages, { limit: -3 }).messages).toHaveLength(1);

    const many = windowed(205);
    const capped = windowMessages(many, { limit: 500 });
    expect(capped.messages).toHaveLength(200);
    expect(capped.hasEarlier).toBe(true);
    expect(capped.earlierCursor).toBe('5');
  });

  it('returns slices of the original message objects', () => {
    const messages = windowed(10);
    const result = windowMessages(messages, { limit: 3 });

    expect(result.messages[0]).toBe(messages[7]);
    expect(result.messages[2]).toBe(messages[9]);
  });
});

describe('message metadata schemas', () => {
  it('keeps unknown keys and rejects invalid values', () => {
    const parsed = messageMetadataSchema.parse({
      provider: 'openai',
      backend: 'research-model',
      'x-note': 'kept',
    });
    expect(parsed['x-note']).toBe('kept');

    expect(
      messageMetadataSchema.safeParse({ context: ['NOT_AN_ID'] }).success,
    ).toBe(false);
    expect(toolCallSchema.safeParse({ id: 'a', name: 'b' }).success).toBe(
      false,
    );
    expect(
      messageAttachmentSchema.safeParse({ label: 'no target' }).success,
    ).toBe(false);
    expect(
      messageAttachmentSchema.safeParse({ id: 'resource_one' }).success,
    ).toBe(true);
    expect(
      messageAttachmentSchema.safeParse({ path: 'notes/a.md' }).success,
    ).toBe(true);
  });

  it('keeps stored attachments backward compatible and extensible', () => {
    expect(
      messageAttachmentSchema.safeParse({
        id: 'resource_one',
        label: 'Notes',
      }).success,
    ).toBe(true);
    expect(
      messageAttachmentSchema.safeParse({
        id: 'resource_one',
        path: 'notes/a.md',
        label: 'Notes',
        mime: 'text/markdown',
        kind: 'resource',
        title: 'Notes',
        size: 120,
      }).success,
    ).toBe(true);
    expect(
      messageAttachmentSchema.safeParse({
        path: 'notes/a.md',
        kind: 'resource',
      }).success,
    ).toBe(true);
  });

  it('accepts exactly one of id or path for attachment references', () => {
    expect(attachmentReferenceSchema.safeParse({}).success).toBe(false);
    expect(
      attachmentReferenceSchema.safeParse({ id: 'resource_one' }).success,
    ).toBe(true);
    expect(
      attachmentReferenceSchema.safeParse({ path: 'notes/a.md' }).success,
    ).toBe(true);
    expect(
      attachmentReferenceSchema.safeParse({
        id: 'resource_one',
        path: 'notes/a.md',
      }).success,
    ).toBe(false);
    expect(
      attachmentReferenceSchema.safeParse({ id: 'NOT_AN_ID' }).success,
    ).toBe(false);
  });

  it('accepts arguments as a string or a record', () => {
    expect(
      toolCallSchema.safeParse({ id: 'a', name: 'b', arguments: 'raw' })
        .success,
    ).toBe(true);
    expect(
      toolCallSchema.safeParse({ id: 'a', name: 'b', arguments: { k: 1 } })
        .success,
    ).toBe(true);
    expect(
      toolCallSchema.safeParse({ id: 'a', name: 'b', arguments: 12 }).success,
    ).toBe(false);
  });
});

function contentOf(message: TranscriptMessage): unknown {
  return {
    role: message.role,
    text: message.text,
    metadata: message.metadata,
    metadataRaw: message.metadataRaw,
  };
}
