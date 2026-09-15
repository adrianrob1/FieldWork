import { describe, expect, it } from 'vitest';

import {
  attachmentFallbackLabel,
  captureScrollAnchor,
  chatWindowRoute,
  formatMessageTime,
  initialWindowState,
  mergeMessages,
  messageMetaParts,
  parseChatDetail,
  reduceInitialLoad,
  reducePrepend,
  scrollTopAfterPrepend,
  stickAfterAppend,
  STREAM_BUBBLE_MIN_HEIGHT,
  streamBubbleMaxHeight,
  threadAppendSnapshot,
  toChatMessage,
  toolCallCapSummary,
  windowBaseIndex,
  workingLabelFor,
  type ChatMessage,
} from '../../web/src/pages/chat/chatThread.js';
import {
  parseBodyEditResult,
  parseEditableFile,
  unknownKeysText,
} from '../../web/src/pages/chat/attachmentEditor.js';

const hash = 'ab'.repeat(32);

function message(
  index: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    index,
    role: 'assistant',
    text: `turn ${String(index)}`,
    ts: null,
    model: null,
    session: null,
    toolCalls: null,
    attachments: [],
    metadata: null,
    ...overrides,
  };
}

describe('windowBaseIndex', () => {
  it('anchors at zero when the window reaches the start', () => {
    expect(windowBaseIndex(false, null)).toBe(0);
    expect(windowBaseIndex(false, '7')).toBe(0);
  });

  it('uses the earlier cursor as the first index while more remains', () => {
    expect(windowBaseIndex(true, '5')).toBe(5);
    expect(windowBaseIndex(true, null)).toBe(0);
    expect(windowBaseIndex(true, 'nope')).toBe(0);
    expect(windowBaseIndex(true, '-2')).toBe(0);
  });
});

describe('parseChatDetail', () => {
  const data = {
    id: 'chat_lab_agenda',
    title: 'Lab meeting agenda',
    created: '2026-09-10',
    updated: null,
    projects: ['project_evon'],
    topics: ['topic_preconditioning'],
    provider: 'openai',
    model: 'gpt-5.6',
    links: [],
    path: 'chats/2026-09-10-lab-agenda.md',
    contentHash: hash,
    hasEarlier: true,
    earlierCursor: '5',
    messages: [
      {
        role: 'user',
        text: 'Draft the agenda.',
        metadata: { at: '2026-09-10T09:29:00Z' },
      },
      {
        role: 'assistant',
        text: 'Here is the draft.',
        metadata: {
          at: '2026-09-10T09:30:00Z',
          model: 'gpt-5.6',
          session: 'resumed',
          tool_calls: [
            { id: 'call_1', name: 'context_bundle', arguments: 'x' },
            {
              id: 'call_2',
              name: 'transcript_read',
              arguments: {},
              result: 'ok',
            },
          ],
          attachments: [
            { id: 'resource_soap_scaling', label: 'Scaling notes' },
            { path: 'projects/x/y.md', title: 'Surrogate notes' },
            { id: 'resource_b', kind: 'resource' },
          ],
        },
      },
    ],
  };

  it('maps the transcript window into indexed view messages', () => {
    const detail = parseChatDetail(data);
    expect(detail).not.toBeNull();
    expect(detail?.messages[0]?.index).toBe(5);
    expect(detail?.messages[1]?.index).toBe(6);
    expect(detail?.messages[0]?.role).toBe('user');
    expect(detail?.messages[0]?.ts).toBe('2026-09-10T09:29:00Z');
    expect(detail?.messages[1]?.toolCalls?.length).toBe(2);
    expect(detail?.messages[1]?.session).toBe('resumed');
    expect(detail?.messages[1]?.model).toBe('gpt-5.6');
  });

  it('labels attachments without exposing file paths', () => {
    const detail = parseChatDetail(data);
    const attachments = detail?.messages[1]?.attachments ?? [];
    expect(attachments[0]?.label).toBe('Scaling notes');
    expect(attachments[1]?.label).toBe('Surrogate notes');
    expect(attachments[2]?.label).toBe('resource resource_b');
    expect(attachments.every((entry) => !entry.label.includes('/'))).toBe(true);
  });

  it('distinguishes an absent tool_calls key from an empty list', () => {
    const absent = toChatMessage(
      {
        role: 'assistant',
        text: 'a',
        metadata: { at: '2026-09-10T09:31:00Z' },
      },
      0,
    );
    const empty = toChatMessage(
      {
        role: 'assistant',
        text: 'b',
        metadata: { at: '2026-09-10T09:31:00Z', tool_calls: [] },
      },
      1,
    );
    expect(absent.toolCalls).toBeNull();
    expect(empty.toolCalls).toEqual([]);
  });

  it('exposes a recorded thought and treats a blank one as absent', () => {
    const withThought = toChatMessage(
      {
        role: 'assistant',
        text: 'a',
        metadata: { at: '2026-09-10T09:31:00Z', thought: 'Internal trace.' },
      },
      0,
    );
    const withoutThought = toChatMessage(
      {
        role: 'assistant',
        text: 'b',
        metadata: { at: '2026-09-10T09:31:00Z' },
      },
      1,
    );
    const blankThought = toChatMessage(
      {
        role: 'assistant',
        text: 'c',
        metadata: { at: '2026-09-10T09:31:00Z', thought: '' },
      },
      2,
    );
    expect(withThought.thought).toBe('Internal trace.');
    expect(withoutThought.thought).toBeNull();
    expect(blankThought.thought).toBeNull();
  });

  it('rejects unreadable payloads', () => {
    expect(parseChatDetail(null)).toBeNull();
    expect(parseChatDetail({ title: 'no id' })).toBeNull();
  });
});

describe('reduceInitialLoad', () => {
  it('records the oldest loaded index and earlier cursor', () => {
    const detail = parseChatDetail({
      id: 'chat_x',
      messages: [{ role: 'user', text: 'a', metadata: null }],
      hasEarlier: false,
    });
    expect(detail).not.toBeNull();
    if (detail === null) return;
    const state = reduceInitialLoad(detail);
    expect(state.messages.length).toBe(1);
    expect(state.oldestLoadedIndex).toBe(0);
    expect(state.hasEarlier).toBe(false);
  });

  it('starts empty', () => {
    expect(initialWindowState()).toEqual({
      messages: [],
      hasEarlier: false,
      earlierCursor: null,
      oldestLoadedIndex: null,
    });
  });
});

describe('mergeMessages', () => {
  it('dedupes by index and keeps ascending order', () => {
    const existing = [message(3), message(4)];
    const incoming = [message(1), message(2), message(3, { text: 'updated' })];
    const merged = mergeMessages(existing, incoming);
    expect(merged.map((entry) => entry.index)).toEqual([1, 2, 3, 4]);
    expect(merged[2]?.text).toBe('updated');
  });
});

describe('reducePrepend', () => {
  it('prepends older turns and tracks the new oldest index', () => {
    const current = {
      messages: [message(8), message(9)],
      hasEarlier: true,
      earlierCursor: '8',
      oldestLoadedIndex: 8,
    };
    const detail = parseChatDetail({
      id: 'chat_x',
      hasEarlier: true,
      earlierCursor: '6',
      messages: [
        { role: 'user', text: 'older', metadata: null },
        { role: 'assistant', text: 'older reply', metadata: null },
      ],
    });
    expect(detail).not.toBeNull();
    if (detail === null) return;
    const next = reducePrepend(current, detail);
    expect(next.messages.map((entry) => entry.index)).toEqual([6, 7, 8, 9]);
    expect(next.oldestLoadedIndex).toBe(6);
    expect(next.hasEarlier).toBe(true);
    expect(next.earlierCursor).toBe('6');
  });

  it('is idempotent when the same window is fetched twice', () => {
    const current = {
      messages: [message(1), message(2)],
      hasEarlier: true,
      earlierCursor: '1',
      oldestLoadedIndex: 1,
    };
    const detail = parseChatDetail({
      id: 'chat_x',
      hasEarlier: true,
      earlierCursor: '1',
      messages: [
        { role: 'user', text: 'one', metadata: null },
        { role: 'assistant', text: 'two', metadata: null },
      ],
    });
    if (detail === null) throw new Error('unreadable');
    const next = reducePrepend(current, detail);
    expect(next.messages.length).toBe(2);
    expect(next.oldestLoadedIndex).toBe(1);
  });
});

describe('scroll anchoring', () => {
  it('shifts scrollTop by the inserted height', () => {
    const anchor = captureScrollAnchor({ scrollTop: 200, scrollHeight: 1000 });
    expect(anchor).toEqual({ scrollTop: 200, scrollHeight: 1000 });
    expect(scrollTopAfterPrepend(anchor, 1400)).toBe(600);
    expect(scrollTopAfterPrepend(anchor, 700)).toBe(0);
    expect(scrollTopAfterPrepend(anchor, 900)).toBe(100);
  });
});

describe('stickAfterAppend', () => {
  const base = threadAppendSnapshot([message(0), message(1)], 0);

  it('sticks on an append only while the reader is at bottom', () => {
    const appended = threadAppendSnapshot(
      [message(0), message(1), message(2)],
      0,
    );
    expect(stickAfterAppend(base, appended, true, false)).toBe(true);
    expect(stickAfterAppend(base, appended, false, false)).toBe(false);
  });

  it('always sticks when the reader just sent, even while scrolled up', () => {
    const appended = threadAppendSnapshot(
      [message(0), message(1), message(2)],
      0,
    );
    expect(stickAfterAppend(base, appended, false, true)).toBe(true);
  });

  it('sticks as streamed content grows at the bottom', () => {
    const grown = threadAppendSnapshot([message(0), message(1)], 12);
    expect(stickAfterAppend(base, grown, true, false)).toBe(true);
    expect(stickAfterAppend(base, grown, false, false)).toBe(false);
  });

  it('never sticks or shifts on a prepend', () => {
    const prepended = threadAppendSnapshot(
      [message(-2), message(-1), message(0), message(1)],
      0,
    );
    expect(stickAfterAppend(base, prepended, true, false)).toBe(false);
    expect(stickAfterAppend(base, prepended, false, false)).toBe(false);
  });

  it('does nothing when the content is unchanged', () => {
    expect(stickAfterAppend(base, { ...base }, true, false)).toBe(false);
  });
});

describe('toolCallCapSummary', () => {
  it('renders a single call without capping', () => {
    expect(toolCallCapSummary(['calendar_lookup'])).toEqual({
      shown: ['calendar_lookup'],
      hiddenCount: 0,
      text: '1 tool call · calendar_lookup',
    });
  });

  it('renders two calls in full', () => {
    expect(toolCallCapSummary(['a', 'b'])).toEqual({
      shown: ['a', 'b'],
      hiddenCount: 0,
      text: '2 tool calls · a, b',
    });
  });

  it('caps a long list with first, ellipsis, last', () => {
    const summary = toolCallCapSummary([
      'context_bundle',
      'queue_status',
      'calendar_lookup',
      'transcript_read',
    ]);
    expect(summary.shown).toEqual(['context_bundle', 'transcript_read']);
    expect(summary.hiddenCount).toBe(2);
    expect(summary.text).toBe(
      '4 tool calls · context_bundle, …, transcript_read',
    );
  });

  it('labels an empty list', () => {
    expect(toolCallCapSummary([])).toEqual({
      shown: [],
      hiddenCount: 0,
      text: 'no tool calls',
    });
  });

  it('honors a custom cap', () => {
    const summary = toolCallCapSummary(['a', 'b', 'c'], 3);
    expect(summary.text).toBe('3 tool calls · a, b, c');
    expect(summary.hiddenCount).toBe(0);
  });
});

describe('meta helpers', () => {
  it('formats the wall-clock time recorded in the timestamp', () => {
    expect(formatMessageTime('2026-09-10T09:29:00Z')).toBe('09:29');
    expect(formatMessageTime('2026-09-10')).toBe('2026-09-10');
  });

  it('joins time, model, and session for the meta row', () => {
    expect(
      messageMetaParts(
        message(0, {
          ts: '2026-09-10T09:42:00Z',
          model: 'sonnet-4-5',
          session: 'resumed',
        }),
      ),
    ).toEqual(['09:42', 'sonnet-4-5', 'session resumed']);
    expect(messageMetaParts(message(0))).toEqual([]);
  });
});

describe('chatWindowRoute', () => {
  it('sets the limit and optional cursor', () => {
    expect(chatWindowRoute('chat_ab', null)).toBe(
      '/api/chats/chat_ab?limit=14',
    );
    expect(chatWindowRoute('chat ab', '5')).toBe(
      '/api/chats/chat%20ab?limit=14&before=5',
    );
  });
});

describe('workingLabelFor', () => {
  it('renders whole seconds below a minute and minutes at 60s', () => {
    expect(workingLabelFor(0)).toBe('Working for 0s');
    expect(workingLabelFor(999)).toBe('Working for 0s');
    expect(workingLabelFor(1000)).toBe('Working for 1s');
    expect(workingLabelFor(59999)).toBe('Working for 59s');
    expect(workingLabelFor(60000)).toBe('Working for 1m 0s');
    expect(workingLabelFor(61000)).toBe('Working for 1m 1s');
  });

  it('tolerates negative and non-finite input', () => {
    expect(workingLabelFor(-500)).toBe('Working for 0s');
    expect(workingLabelFor(Number.NaN)).toBe('Working for 0s');
  });
});

describe('attachmentFallbackLabel', () => {
  it('prefers kind plus id and never a path', () => {
    expect(attachmentFallbackLabel('resource', 'resource_x')).toBe(
      'resource resource_x',
    );
    expect(attachmentFallbackLabel('', 'resource_x')).toBe('resource_x');
    expect(attachmentFallbackLabel('task', null)).toBe('task');
    expect(attachmentFallbackLabel('', null)).toBe('attachment');
  });
});

describe('parseEditableFile', () => {
  it('parses the editable file view and its unknown keys', () => {
    const file = parseEditableFile({
      kind: 'resource',
      path: 'projects/x/scaling.md',
      metadata: {
        id: 'resource_soap_scaling',
        title: 'Scaling notes',
        calibration: 'preliminary',
      },
      unknownKeys: ['calibration'],
      body: '# Scaling notes\n',
      contentHash: hash,
      editableFields: [{ field: 'title', type: 'text' }],
    });
    expect(file?.kind).toBe('resource');
    expect(file?.unknownKeys).toEqual(['calibration']);
    expect(unknownKeysText(file?.metadata ?? {}, file?.unknownKeys ?? [])).toBe(
      'calibration: preliminary',
    );
    expect(unknownKeysText({}, [])).toBe('none');
  });

  it('parses a body edit result', () => {
    expect(parseBodyEditResult({ changed: true, contentHash: hash })).toEqual({
      changed: true,
      contentHash: hash,
    });
    expect(parseBodyEditResult({ changed: false })).toEqual({
      changed: false,
      contentHash: null,
    });
    expect(parseEditableFile(null)).toBeNull();
  });
});

describe('stream bubble cap', () => {
  it('caps at the scroller height minus the bubble header', () => {
    expect(streamBubbleMaxHeight(700, 40)).toBe(660);
    expect(streamBubbleMaxHeight(500, 36)).toBe(464);
  });

  it('never drops below the sane minimum', () => {
    expect(streamBubbleMaxHeight(120, 40)).toBe(STREAM_BUBBLE_MIN_HEIGHT);
    expect(streamBubbleMaxHeight(0, 0)).toBe(STREAM_BUBBLE_MIN_HEIGHT);
    expect(STREAM_BUBBLE_MIN_HEIGHT).toBeGreaterThanOrEqual(160);
  });

  it('rounds fractional measurements', () => {
    expect(streamBubbleMaxHeight(500.6, 40.2)).toBe(460);
  });
});
