import { describe, expect, it } from 'vitest';

import type { ChatMessageView } from '../../web/src/shared/types.js';
import {
  addOptimistic,
  atBottom,
  attachmentRefOf,
  buildComposerPayload,
  canRetrySend,
  composerSendReducer,
  composerShouldMinimize,
  distanceFromBottom,
  exchangedMessages,
  idleComposerSend,
  jumpDuration,
  jumpEase,
  jumpTarget,
  latestPillVisible,
  parseContentHashResponse,
  parseSendResponse,
  resolveOptimistic,
  stickyBarFromIntersection,
  textToRestoreAfterStop,
  type ComposerAttachment,
  type ComposerPayload,
} from '../../web/src/pages/chat/chatComposer.js';

const hash = 'ab'.repeat(32);

const attachment: ComposerAttachment = {
  key: 'resource_scaling',
  id: 'resource_scaling',
  path: null,
  label: 'Scaling notes',
  kind: 'resource',
};

const pathAttachment: ComposerAttachment = {
  key: 'chats/x.md',
  id: null,
  path: 'chats/x.md',
  label: 'x.md',
  kind: 'chat',
};

function payloadOf(
  built: ReturnType<typeof buildComposerPayload>,
): ComposerPayload {
  if (!built.ok) throw new Error('expected a payload');
  return built.payload;
}

describe('attachmentRefOf', () => {
  it('prefers the id and falls back to the path', () => {
    expect(attachmentRefOf(attachment)).toEqual({ id: 'resource_scaling' });
    expect(attachmentRefOf(pathAttachment)).toEqual({ path: 'chats/x.md' });
  });
});

describe('buildComposerPayload', () => {
  it('threads the hash and omits the backend by default', () => {
    expect(
      payloadOf(
        buildComposerPayload({
          message: 'Hello.',
          backend: null,
          contentHash: hash,
          attachments: [],
        }),
      ),
    ).toEqual({ message: 'Hello.', expectedHash: hash });
  });

  it('includes the selected backend and maps attachments to id/path refs', () => {
    expect(
      payloadOf(
        buildComposerPayload({
          message: 'Hello.',
          backend: 'local-agent',
          contentHash: hash,
          attachments: [attachment, pathAttachment],
        }),
      ),
    ).toEqual({
      message: 'Hello.',
      expectedHash: hash,
      backend: 'local-agent',
      attachments: [{ id: 'resource_scaling' }, { path: 'chats/x.md' }],
    });
  });

  it('refuses to build without a content hash', () => {
    expect(
      buildComposerPayload({
        message: 'Hello.',
        backend: null,
        contentHash: null,
        attachments: [],
      }),
    ).toEqual({ ok: false, reason: 'missing-hash' });
  });

  it('omits the attachments field when nothing is staged', () => {
    const payload = payloadOf(
      buildComposerPayload({
        message: 'Hello.',
        backend: null,
        contentHash: hash,
        attachments: [],
      }),
    );
    expect('attachments' in payload).toBe(false);
    expect('backend' in payload).toBe(false);
  });
});

describe('composerSendReducer', () => {
  const payload: ComposerPayload = { message: 'Hi.', expectedHash: hash };

  it('moves idle -> sending -> applied and clears the payload', () => {
    const sending = composerSendReducer(idleComposerSend, {
      type: 'send',
      payload,
    });
    expect(sending.status).toBe('sending');
    expect(sending.payload).toEqual(payload);
    const applied = composerSendReducer(sending, { type: 'applied' });
    expect(applied).toEqual({
      status: 'applied',
      payload: null,
      failure: null,
    });
  });

  it('keeps the payload on failure and retry re-sends it', () => {
    const sending = composerSendReducer(idleComposerSend, {
      type: 'send',
      payload,
    });
    const failure = {
      kind: 'backend' as const,
      message: 'The backend could not answer this message.',
      errorText: 'no backend',
      diagnostics: [],
      needsSettings: true,
    };
    const failed = composerSendReducer(sending, { type: 'failed', failure });
    expect(failed.status).toBe('failed');
    expect(failed.payload).toEqual(payload);
    expect(canRetrySend(failed)).toBe(true);
    const retried = composerSendReducer(failed, { type: 'retry' });
    expect(retried.status).toBe('sending');
    expect(retried.payload).toEqual(payload);
  });

  it('moves to conflict and back to sending on retry', () => {
    const sending = composerSendReducer(idleComposerSend, {
      type: 'send',
      payload,
    });
    const conflict = composerSendReducer(sending, { type: 'conflict' });
    expect(conflict.status).toBe('conflict');
    expect(conflict.payload).toEqual(payload);
    expect(canRetrySend(conflict)).toBe(true);
    expect(composerSendReducer(conflict, { type: 'retry' }).status).toBe(
      'sending',
    );
  });

  it('ignores retry without a payload and resets to idle', () => {
    expect(composerSendReducer(idleComposerSend, { type: 'retry' })).toEqual(
      idleComposerSend,
    );
    expect(
      composerSendReducer(
        { status: 'applied', payload: null, failure: null },
        { type: 'reset' },
      ),
    ).toEqual(idleComposerSend);
  });

  it('drops the payload on stop and a later send clears the note', () => {
    const sending = composerSendReducer(idleComposerSend, {
      type: 'send',
      payload,
    });
    const stopped = composerSendReducer(sending, { type: 'stopped' });
    expect(stopped).toEqual({
      status: 'stopped',
      payload: null,
      failure: null,
    });
    expect(canRetrySend(stopped)).toBe(false);
    expect(composerSendReducer(stopped, { type: 'send', payload }).status).toBe(
      'sending',
    );
  });
});

describe('optimistic turns', () => {
  it('adds a pending turn and resolves it away on settle', () => {
    const withPending = addOptimistic([], {
      id: 'o1',
      text: 'Hello.',
      attachments: [],
    });
    expect(withPending).toEqual([
      { id: 'o1', text: 'Hello.', attachments: [] },
    ]);
    expect(resolveOptimistic(withPending, 'o1')).toEqual([]);
  });

  it('carries the staged attachments onto the pending turn', () => {
    const withPending = addOptimistic([], {
      id: 'o1',
      text: 'Hello.',
      attachments: [attachment],
    });
    expect(withPending[0]?.attachments).toEqual([attachment]);
  });

  it('restores the typed text after a stop only when the input is empty', () => {
    expect(textToRestoreAfterStop('', 'Hello.')).toBe('Hello.');
    expect(textToRestoreAfterStop('   ', 'Hello.')).toBe('Hello.');
    expect(textToRestoreAfterStop('Drafting more', 'Hello.')).toBeNull();
  });

  it('replaces the pending turn with the committed exchange indexes', () => {
    const user: ChatMessageView = { role: 'user', text: 'Hi.', metadata: null };
    const assistant: ChatMessageView = {
      role: 'assistant',
      text: 'Hello.',
      metadata: null,
    };
    const exchanged = exchangedMessages({ user, assistant }, 7);
    expect(exchanged.map((message) => message.index)).toEqual([7, 8]);
    expect(exchanged.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
  });
});

describe('parseSendResponse', () => {
  it('reads the exchange and content hash', () => {
    const parsed = parseSendResponse({
      chatId: 'chat_1',
      contentHash: hash,
      exchange: {
        user: { role: 'user', text: 'Hi.', metadata: null },
        assistant: { role: 'assistant', text: 'Yo.', metadata: { model: 'm' } },
      },
    });
    expect(parsed?.contentHash).toBe(hash);
    expect(parsed?.exchange.assistant.text).toBe('Yo.');
  });

  it('rejects a response without a usable exchange', () => {
    expect(parseSendResponse(null)).toBeNull();
    expect(parseSendResponse({ exchange: {} })).toBeNull();
    expect(
      parseSendResponse({ exchange: { user: { role: 'user' } } }),
    ).toBeNull();
  });

  it('reads a content hash from a frontmatter edit result', () => {
    expect(parseContentHashResponse({ changed: true, contentHash: hash })).toBe(
      hash,
    );
    expect(parseContentHashResponse({ changed: false })).toBeNull();
  });
});

describe('composer visibility decisions', () => {
  it('minimizes only when scrolled away and unfocused', () => {
    expect(
      composerShouldMinimize({
        distanceFromBottom: 300,
        atBottom: false,
        focused: false,
      }),
    ).toBe(true);
    expect(
      composerShouldMinimize({
        distanceFromBottom: 300,
        atBottom: false,
        focused: true,
      }),
    ).toBe(false);
    expect(
      composerShouldMinimize({
        distanceFromBottom: 300,
        atBottom: true,
        focused: false,
      }),
    ).toBe(false);
    expect(
      composerShouldMinimize({
        distanceFromBottom: 20,
        atBottom: false,
        focused: false,
      }),
    ).toBe(false);
  });

  it('measures distance from the bottom and at-bottom tolerance', () => {
    const geometry = { scrollTop: 100, scrollHeight: 500, clientHeight: 300 };
    expect(distanceFromBottom(geometry)).toBe(100);
    expect(atBottom(geometry, 2)).toBe(false);
    expect(
      atBottom({ scrollTop: 200, scrollHeight: 500, clientHeight: 300 }),
    ).toBe(true);
  });

  it('shows the latest pill only beyond the distance threshold', () => {
    expect(latestPillVisible(100)).toBe(false);
    expect(latestPillVisible(261)).toBe(true);
  });

  it('shows the sticky bar once the header leaves the viewport', () => {
    expect(stickyBarFromIntersection({ isIntersecting: true })).toBe(false);
    expect(stickyBarFromIntersection({ isIntersecting: false })).toBe(true);
  });
});

describe('jump easing', () => {
  it('is an ease-out curve from 0 to 1', () => {
    expect(jumpEase(0)).toBe(0);
    expect(jumpEase(1)).toBe(1);
    expect(jumpEase(0.5)).toBeGreaterThan(0.5);
    expect(jumpEase(-1)).toBe(0);
    expect(jumpEase(2)).toBe(1);
  });

  it('is monotonic across the unit interval', () => {
    let previous = -1;
    for (let step = 0; step <= 20; step += 1) {
      const value = jumpEase(step / 20);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('clamps the duration and computes the target from geometry', () => {
    expect(jumpDuration(0)).toBe(240);
    expect(jumpDuration(10_000)).toBe(620);
    expect(
      jumpTarget({ scrollTop: 0, scrollHeight: 900, clientHeight: 400 }),
    ).toBe(500);
  });
});
