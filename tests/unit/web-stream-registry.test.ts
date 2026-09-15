import { beforeEach, describe, expect, it } from 'vitest';

import {
  append,
  begin,
  clear,
  fail,
  finish,
  get,
  reset,
  setCancel,
  subscribe,
  text,
  thought,
} from '../../web/src/pages/chat/streamRegistry.js';

beforeEach(() => {
  reset();
});

describe('streamRegistry', () => {
  it('begins an entry and is idempotent per chat id', () => {
    const first = begin({
      chatId: 'chat_1',
      title: 'First',
      text: 'hello',
      draftId: 'draft_aaaaaaaaaaaa',
    });
    const second = begin({
      chatId: 'chat_1',
      title: 'Changed',
      text: 'changed',
      draftId: null,
    });
    expect(second).toBe(first);
    expect(get('chat_1')?.title).toBe('First');
    expect(get('chat_1')?.text).toBe('hello');
    expect(get('chat_1')?.draftId).toBe('draft_aaaaaaaaaaaa');
  });

  it('replaces a terminal entry so a retry can stream the same slug again', () => {
    begin({ chatId: 'chat_1', title: 'Old', text: 'old', draftId: null });
    fail('chat_1', {
      type: 'error',
      status: 502,
      errorText: 'down',
      diagnostics: [],
    });
    const retried = begin({
      chatId: 'chat_1',
      title: 'New',
      text: 'new',
      draftId: 'draft_bbbbbbbbbbbb',
    });
    expect(retried.title).toBe('New');
    expect(retried.text).toBe('new');
    expect(retried.error).toBeNull();
    expect(retried.chunks).toEqual([]);
    expect(get('chat_1')).toBe(retried);
  });

  it('accumulates deltas and notifies subscribers', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    let notifications = 0;
    const unsubscribe = subscribe('chat_1', () => {
      notifications += 1;
    });
    append('chat_1', 'Hel');
    append('chat_1', 'lo');
    const entry = get('chat_1');
    expect(entry).not.toBeNull();
    if (entry === null) throw new Error('expected entry');
    expect(text(entry)).toBe('Hello');
    expect(entry.chunks).toEqual(['Hel', 'lo']);
    expect(notifications).toBe(2);
    unsubscribe();
    append('chat_1', '!');
    expect(notifications).toBe(2);
  });

  it('accumulates thought text separately from message text', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    append('chat_1', 'Let me ');
    append('chat_1', 'reason.', 'thought');
    append('chat_1', 'The ');
    append('chat_1', 'answer.', 'message');
    const entry = get('chat_1');
    expect(entry).not.toBeNull();
    if (entry === null) throw new Error('expected entry');
    expect(text(entry)).toBe('Let me The answer.');
    expect(thought(entry)).toBe('reason.');
    expect(entry.chunks).toEqual(['Let me ', 'The ', 'answer.']);
    expect(entry.thoughts).toEqual(['reason.']);
  });

  it('drops thought text once the terminal entry is consumed', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    append('chat_1', 'thinking', 'thought');
    finish('chat_1', { chatId: 'chat_1' });
    const entry = get('chat_1');
    expect(thought(entry as NonNullable<typeof entry>)).toBe('thinking');
    // The provisional view consumes the entry; thoughts never persist.
    clear('chat_1');
    expect(get('chat_1')).toBeNull();
  });

  it('lets a late subscriber read the accumulated text', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    append('chat_1', 'one ');
    append('chat_1', 'two');
    let seen = '';
    const unsubscribe = subscribe('chat_1', () => {
      const entry = get('chat_1');
      seen = entry === null ? '' : text(entry);
    });
    const entry = get('chat_1');
    expect(entry).not.toBeNull();
    if (entry === null) throw new Error('expected entry');
    expect(text(entry)).toBe('one two');
    append('chat_1', ' three');
    expect(seen).toBe('one two three');
    unsubscribe();
  });

  it('marks done, notifies, and ignores later deltas', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    let notifications = 0;
    subscribe('chat_1', () => {
      notifications += 1;
    });
    finish('chat_1', { chatId: 'chat_1' });
    append('chat_1', 'late');
    const entry = get('chat_1');
    expect(entry?.done).toEqual({ chatId: 'chat_1' });
    expect(entry?.chunks).toEqual([]);
    expect(notifications).toBe(1);
  });

  it('marks a terminal error and preserves it for the provisional page', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: 'd1' });
    fail('chat_1', {
      type: 'error',
      status: 502,
      errorText: 'backend down',
      diagnostics: [],
    });
    const entry = get('chat_1');
    expect(entry?.error?.status).toBe(502);
    expect(entry?.done).toBeNull();
    expect(entry?.draftId).toBe('d1');
  });

  it('clears entries on consume and returns a no-op unsubscribe afterwards', () => {
    begin({ chatId: 'chat_1', title: 'T', text: 'ask', draftId: null });
    clear('chat_1');
    expect(get('chat_1')).toBeNull();
    const unsubscribe = subscribe('chat_1', () => undefined);
    expect(() => {
      unsubscribe();
    }).not.toThrow();
    append('chat_1', 'ignored');
    expect(get('chat_1')).toBeNull();
  });
});

describe('streamRegistry attachments', () => {
  it('carries the draft attachments onto the provisional entry', () => {
    const attachments = [
      {
        key: 'resource_scaling',
        id: 'resource_scaling',
        path: null,
        label: 'Scaling notes',
        kind: 'resource',
      },
    ];
    const entry = begin({
      chatId: 'chat_1',
      title: 'T',
      text: 'ask',
      attachments,
      draftId: null,
    });
    expect(entry.attachments).toEqual(attachments);
    expect(get('chat_1')?.attachments).toEqual(attachments);
  });

  it('defaults to no attachments and exposes a cancel handle', () => {
    const entry = begin({
      chatId: 'chat_1',
      title: 'T',
      text: 'ask',
      draftId: null,
    });
    expect(entry.attachments).toEqual([]);
    expect(entry.cancel).toBeNull();
    let cancelled = 0;
    setCancel('chat_1', () => {
      cancelled += 1;
    });
    get('chat_1')?.cancel?.();
    expect(cancelled).toBe(1);
  });
});
