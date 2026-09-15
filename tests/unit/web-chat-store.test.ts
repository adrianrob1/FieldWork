import { describe, expect, it } from 'vitest';

import type { ChatView } from '../../web/src/shared/types.js';
import {
  assistantMetaSummary,
  buildSendPayload,
  classifySendFailure,
  ingestSendResponse,
  pendingTurn,
  toTurns,
  withExpectedHash,
} from '../../web/src/chat/store.js';

const view: ChatView = {
  id: 'chat_rank_diagnostics',
  title: 'Rank diagnostics',
  projects: ['project_evon'],
  topics: ['topic_preconditioning'],
  path: 'chats/2026-09-02-rank-diagnostics.md',
  contentHash: 'ab'.repeat(32),
  messages: [],
  hasEarlier: false,
};

describe('toTurns', () => {
  it('maps messages to stable turns by position', () => {
    const turns = toTurns([
      { role: 'user', text: 'First question.', metadata: null },
      {
        role: 'assistant',
        text: 'First answer.',
        metadata: { provider: 'local', model: 'sample-model' },
      },
      { role: 'system', text: 'Attached.', metadata: null },
    ]);
    expect(turns).toEqual([
      {
        id: 'turn-0',
        role: 'user',
        text: 'First question.',
        meta: null,
        optimistic: false,
      },
      {
        id: 'turn-1',
        role: 'assistant',
        text: 'First answer.',
        meta: 'local · sample-model',
        optimistic: false,
      },
      {
        id: 'turn-2',
        role: 'system',
        text: 'Attached.',
        meta: null,
        optimistic: false,
      },
    ]);
  });

  it('treats unknown roles as system messages', () => {
    const turns = toTurns([{ role: 'tool', text: 'Ran.', metadata: null }]);
    expect(turns[0]?.role).toBe('system');
    expect(turns[0]?.meta).toBeNull();
  });
});

describe('assistantMetaSummary', () => {
  it('joins provider, model, and session', () => {
    expect(
      assistantMetaSummary({
        provider: 'openai',
        model: 'gpt-5',
        session: 'ses_123',
      }),
    ).toBe('openai · gpt-5 · session ses_123');
  });

  it('falls back to the backend name and skips missing parts', () => {
    expect(assistantMetaSummary({ backend: 'stub-model' })).toBe('stub-model');
    expect(assistantMetaSummary({ model: 'sample-model' })).toBe(
      'sample-model',
    );
  });

  it('returns null without metadata or usable fields', () => {
    expect(assistantMetaSummary(null)).toBeNull();
    expect(assistantMetaSummary({})).toBeNull();
    expect(assistantMetaSummary({ provider: 7, model: '' })).toBeNull();
  });
});

describe('pendingTurn', () => {
  it('marks the optimistic user turn', () => {
    expect(pendingTurn('Hello.')).toEqual({
      id: 'turn-pending',
      role: 'user',
      text: 'Hello.',
      meta: null,
      optimistic: true,
    });
  });
});

describe('buildSendPayload', () => {
  it('threads the expected hash without a backend by default', () => {
    const built = buildSendPayload('Hello.', null, 'cd'.repeat(32));
    expect(built).toEqual({
      ok: true,
      payload: { message: 'Hello.', expectedHash: 'cd'.repeat(32) },
    });
  });

  it('includes the selected backend when one is chosen', () => {
    const built = buildSendPayload('Hello.', 'stub-model', 'cd'.repeat(32));
    expect(built).toEqual({
      ok: true,
      payload: {
        message: 'Hello.',
        backend: 'stub-model',
        expectedHash: 'cd'.repeat(32),
      },
    });
  });

  it('refuses to send without a content hash', () => {
    expect(buildSendPayload('Hello.', null, null)).toEqual({
      ok: false,
      reason: 'missing-hash',
    });
  });
});

describe('withExpectedHash', () => {
  it('threads the current content hash into an action payload', () => {
    expect(
      withExpectedHash({ projectId: 'project_evon' }, 'cd'.repeat(32)),
    ).toEqual({
      ok: true,
      payload: {
        projectId: 'project_evon',
        expectedHash: 'cd'.repeat(32),
      },
    });
  });

  it('refuses to act without a content hash', () => {
    expect(withExpectedHash({ projectId: 'project_evon' }, null)).toEqual({
      ok: false,
      reason: 'missing-hash',
    });
  });
});

describe('ingestSendResponse', () => {
  it('appends the committed exchange and updates the content hash', () => {
    const existing = [{ role: 'user', text: 'First.', metadata: null }];
    const exchange = {
      user: { role: 'user', text: 'Hello.', metadata: null },
      assistant: {
        role: 'assistant',
        text: 'Hi.',
        metadata: { provider: 'stub', model: 'sample-model' },
      },
    };
    const updated = ingestSendResponse(
      { ...view, messages: existing },
      { chatId: view.id, contentHash: 'ef'.repeat(32), exchange },
    );
    expect(updated.messages).toEqual([
      ...existing,
      exchange.user,
      exchange.assistant,
    ]);
    expect(updated.contentHash).toBe('ef'.repeat(32));
    expect(updated.id).toBe(view.id);
    expect(updated.path).toBe(view.path);
    expect(updated.projects).toBe(view.projects);
    expect(updated.hasEarlier).toBe(false);
  });
});

describe('classifySendFailure', () => {
  it('classifies 409 as a conflict with a reload affordance', () => {
    const failure = classifySendFailure(409, [], null);
    expect(failure.kind).toBe('conflict');
    expect(failure.message).toBe('The chat changed since it was loaded.');
    expect(failure.needsSettings).toBe(false);
  });

  it('classifies 502 as a backend failure and threads diagnostics', () => {
    const diagnostics = [
      {
        code: 'backend.failed',
        severity: 'error',
        file: '',
        fieldPath: null,
        message: 'The backend exited.',
        line: null,
        column: null,
      },
    ];
    const failure = classifySendFailure(502, diagnostics, null);
    expect(failure.kind).toBe('backend');
    expect(failure.diagnostics).toBe(diagnostics);
    expect(failure.needsSettings).toBe(false);
  });

  it('flags an unconfigured backend as a settings problem', () => {
    const diagnostics = [
      {
        code: 'backend.unconfigured',
        severity: 'error',
        file: '',
        fieldPath: null,
        message: 'No backend is configured.',
        line: null,
        column: null,
      },
    ];
    const failure = classifySendFailure(502, diagnostics, null);
    expect(failure.kind).toBe('backend');
    expect(failure.needsSettings).toBe(true);
  });

  it('classifies 422 as validation and 404 as missing', () => {
    expect(classifySendFailure(422, [], null).kind).toBe('validation');
    expect(classifySendFailure(404, [], null).kind).toBe('missing');
  });

  it('classifies transport failures as network errors', () => {
    const failure = classifySendFailure(0, [], null);
    expect(failure.kind).toBe('network');
    expect(failure.message).toBe('The request could not reach the server.');
  });
});
