import { describe, expect, it } from 'vitest';

import {
  isContentHash,
  parseChatListQuery,
  parseContextScope,
  requiredQueryParam,
} from '../../src/server/api.js';
import {
  chatIdFromTitle,
  parseChatCreatePayload,
  parseChatMembershipPayload,
  parseChatPromotePayload,
  parseChatSendPayload,
} from '../../src/server/chatApi.js';
import {
  parseBackendAddPayload,
  parseBackendNamePayload,
  parseBackendTestPayload,
  parseBackendUpdatePayload,
} from '../../src/server/backendsApi.js';
import { escapeHtml } from '../../src/server/html.js';
import {
  isJsonContentType,
  isSameOrigin,
  matchRoute,
} from '../../src/server/server.js';

describe('matchRoute', () => {
  it('matches the dashboard', () => {
    expect(matchRoute('/')).toEqual({
      area: 'page',
      name: 'dashboard',
      params: {},
    });
  });

  it('matches page routes with and without parameters', () => {
    expect(matchRoute('/projects')).toEqual({
      area: 'page',
      name: 'projects',
      params: {},
    });
    expect(matchRoute('/projects/project_evon')).toEqual({
      area: 'page',
      name: 'project',
      params: { id: 'project_evon' },
    });
    expect(matchRoute('/chats')).toEqual({
      area: 'page',
      name: 'chats',
      params: {},
    });
    expect(matchRoute('/chats/chat_alpha')).toEqual({
      area: 'page',
      name: 'chat',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/inbox')?.name).toBe('inbox');
    expect(matchRoute('/search')?.name).toBe('search');
    expect(matchRoute('/context')?.name).toBe('context');
    expect(matchRoute('/tasks')?.name).toBe('tasks');
  });

  it('matches API routes', () => {
    expect(matchRoute('/api/workspace')).toEqual({
      area: 'api',
      name: 'workspace',
      params: {},
    });
    expect(matchRoute('/api/projects')).toEqual({
      area: 'api',
      name: 'projects',
      params: {},
    });
    expect(matchRoute('/api/projects/project_evon')).toEqual({
      area: 'api',
      name: 'project',
      params: { id: 'project_evon' },
    });
    expect(matchRoute('/api/chats/chat_alpha')).toEqual({
      area: 'api',
      name: 'chat',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/api/inbox')?.area).toBe('api');
    expect(matchRoute('/api/search')?.name).toBe('search');
    expect(matchRoute('/api/context')?.name).toBe('context');
    expect(matchRoute('/api/file')).toEqual({
      area: 'api',
      name: 'file',
      params: {},
    });
    expect(matchRoute('/api/edit/frontmatter')).toEqual({
      area: 'api',
      name: 'edit-frontmatter',
      params: {},
    });
    expect(matchRoute('/api/edit/body')).toEqual({
      area: 'api',
      name: 'edit-body',
      params: {},
    });
  });

  it('matches the edit page route', () => {
    expect(matchRoute('/edit')).toEqual({
      area: 'page',
      name: 'edit',
      params: {},
    });
  });

  it('matches the new chat page before the chat id parameter', () => {
    expect(matchRoute('/chats/new')).toEqual({
      area: 'page',
      name: 'chat-new',
      params: {},
    });
    expect(matchRoute('/chats/chat_alpha')).toEqual({
      area: 'page',
      name: 'chat',
      params: { id: 'chat_alpha' },
    });
  });

  it('matches the settings page route', () => {
    expect(matchRoute('/settings')).toEqual({
      area: 'page',
      name: 'settings',
      params: {},
    });
  });

  it('tolerates a trailing slash', () => {
    expect(matchRoute('/projects/')).toEqual({
      area: 'page',
      name: 'projects',
      params: {},
    });
    expect(matchRoute('/api/projects/project_evon/')).toEqual({
      area: 'api',
      name: 'project',
      params: { id: 'project_evon' },
    });
  });

  it('returns null for unknown routes', () => {
    expect(matchRoute('/nope')).toBeNull();
    expect(matchRoute('/api/nope')).toBeNull();
    expect(matchRoute('/api')).toBeNull();
    expect(matchRoute('/projects/a/b')).toBeNull();
    expect(matchRoute('/api/chats/chat_a/extra')).toBeNull();
  });

  it('matches the chat mutation routes with raw and URL-encoded ids', () => {
    expect(matchRoute('/api/chats/chat_alpha/messages')).toEqual({
      area: 'api',
      name: 'chat-messages',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/api/chats/chat%20alpha/messages')).toEqual({
      area: 'api',
      name: 'chat-messages',
      params: { id: 'chat%20alpha' },
    });
    expect(matchRoute('/api/chats/chat_alpha/attach')).toEqual({
      area: 'api',
      name: 'chat-attach',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/api/chats/chat_alpha/detach')).toEqual({
      area: 'api',
      name: 'chat-detach',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/api/chats/chat_alpha/promote')).toEqual({
      area: 'api',
      name: 'chat-promote',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoute('/api/chats/chat_alpha/nope')).toBeNull();
  });

  it('matches the backends routes', () => {
    expect(matchRoute('/api/backends')).toEqual({
      area: 'api',
      name: 'backends',
      params: {},
    });
    expect(matchRoute('/api/backends/add')).toEqual({
      area: 'api',
      name: 'backends-add',
      params: {},
    });
    expect(matchRoute('/api/backends/update')).toEqual({
      area: 'api',
      name: 'backends-update',
      params: {},
    });
    expect(matchRoute('/api/backends/remove')).toEqual({
      area: 'api',
      name: 'backends-remove',
      params: {},
    });
    expect(matchRoute('/api/backends/default')).toEqual({
      area: 'api',
      name: 'backends-default',
      params: {},
    });
    expect(matchRoute('/api/backends/test')).toEqual({
      area: 'api',
      name: 'backends-test',
      params: {},
    });
    expect(matchRoute('/api/backends/other')).toBeNull();
  });
});

describe('requiredQueryParam', () => {
  it('returns null for missing, empty, or blank values', () => {
    expect(requiredQueryParam(new URLSearchParams(), 'q')).toBeNull();
    expect(requiredQueryParam(new URLSearchParams('q='), 'q')).toBeNull();
    expect(requiredQueryParam(new URLSearchParams('q=%20%20'), 'q')).toBeNull();
  });

  it('trims present values', () => {
    expect(requiredQueryParam(new URLSearchParams('q=+posterior+'), 'q')).toBe(
      'posterior',
    );
  });
});

describe('parseChatListQuery', () => {
  it('defaults to the all view', () => {
    expect(parseChatListQuery(new URLSearchParams())).toEqual({
      ok: true,
      filter: { kind: 'all' },
    });
  });

  it('parses the unassigned view', () => {
    const parsed = parseChatListQuery(new URLSearchParams('view=unassigned'));
    expect(parsed).toEqual({ ok: true, filter: { kind: 'unassigned' } });
  });

  it('parses the project view with its identifier', () => {
    const parsed = parseChatListQuery(
      new URLSearchParams('view=project&project=project_evon'),
    );
    expect(parsed).toEqual({
      ok: true,
      filter: { kind: 'project', projectId: 'project_evon' },
    });
  });

  it('rejects the project view without a project identifier', () => {
    const parsed = parseChatListQuery(new URLSearchParams('view=project'));
    expect(parsed.ok).toBe(false);
  });

  it('rejects an unknown view', () => {
    const parsed = parseChatListQuery(new URLSearchParams('view=bogus'));
    expect(parsed.ok).toBe(false);
  });
});

describe('parseContextScope', () => {
  it('defaults to the global scope', () => {
    expect(parseContextScope(new URLSearchParams())).toEqual({
      ok: true,
      scope: { kind: 'global' },
    });
  });

  it('parses project and chat scopes', () => {
    expect(
      parseContextScope(new URLSearchParams('project=project_evon')),
    ).toEqual({
      ok: true,
      scope: { kind: 'project', projectId: 'project_evon' },
    });
    expect(parseContextScope(new URLSearchParams('chat=chat_alpha'))).toEqual({
      ok: true,
      scope: { kind: 'chat', chatId: 'chat_alpha' },
    });
  });

  it('rejects combining project and chat', () => {
    const parsed = parseContextScope(
      new URLSearchParams('project=project_evon&chat=chat_alpha'),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe('isSameOrigin', () => {
  it('accepts the printed origin with case and whitespace differences', () => {
    expect(isSameOrigin('http://127.0.0.1:1774', 'http://127.0.0.1:1774')).toBe(
      true,
    );
    expect(isSameOrigin('HTTP://LOCALHOST:1774', 'http://localhost:1774')).toBe(
      true,
    );
    expect(
      isSameOrigin('  http://127.0.0.1:1774  ', 'http://127.0.0.1:1774'),
    ).toBe(true);
  });

  it('rejects foreign origins, opaque origins, and unknown servers', () => {
    expect(
      isSameOrigin('https://attacker.example', 'http://127.0.0.1:1774'),
    ).toBe(false);
    expect(
      isSameOrigin('https://127.0.0.1:1774', 'http://127.0.0.1:1774'),
    ).toBe(false);
    expect(isSameOrigin('http://localhost:1774', 'http://127.0.0.1:1774')).toBe(
      false,
    );
    expect(isSameOrigin('http://127.0.0.1:1775', 'http://127.0.0.1:1774')).toBe(
      false,
    );
    expect(isSameOrigin('null', 'http://127.0.0.1:1774')).toBe(false);
    expect(isSameOrigin('http://127.0.0.1:1774', null)).toBe(false);
  });
});

describe('isJsonContentType', () => {
  it('accepts application/json with case and charset variations', () => {
    expect(isJsonContentType('application/json')).toBe(true);
    expect(isJsonContentType('APPLICATION/JSON')).toBe(true);
    expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
    expect(isJsonContentType('application/json;charset=UTF-8')).toBe(true);
    expect(isJsonContentType('application/json; charset="utf-8"')).toBe(true);
  });

  it('rejects missing headers and non-JSON media types', () => {
    expect(isJsonContentType(undefined)).toBe(false);
    expect(isJsonContentType('text/plain')).toBe(false);
    expect(isJsonContentType('text/plain; charset=UTF-8')).toBe(false);
    expect(isJsonContentType('application/json; charset')).toBe(false);
    expect(isJsonContentType('application/json;')).toBe(false);
    expect(isJsonContentType('text/json')).toBe(false);
  });
});

describe('isContentHash', () => {
  it('accepts 64 hex characters in either case', () => {
    expect(isContentHash('ab'.repeat(32))).toBe(true);
    expect(isContentHash('AB'.repeat(32))).toBe(true);
    expect(isContentHash('0123456789abcdef'.repeat(4))).toBe(true);
  });

  it('rejects other shapes and non-strings', () => {
    expect(isContentHash('ab'.repeat(31) + 'a')).toBe(false);
    expect(isContentHash('z'.repeat(64))).toBe(false);
    expect(isContentHash('')).toBe(false);
    expect(isContentHash(null)).toBe(false);
    expect(isContentHash(undefined)).toBe(false);
    expect(isContentHash(42)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes markup-significant characters', () => {
    expect(escapeHtml(`<script>alert('x' & "y")</script>`)).toBe(
      '&lt;script&gt;alert(&#39;x&#39; &amp; &quot;y&quot;)&lt;/script&gt;',
    );
  });

  it('leaves plain text unchanged', () => {
    expect(escapeHtml('posterior updates, phase 2')).toBe(
      'posterior updates, phase 2',
    );
  });
});

describe('chatIdFromTitle', () => {
  it('slugs plain titles into stable ids', () => {
    expect(chatIdFromTitle('Gradient Notes', [])).toBe('gradient_notes');
    expect(chatIdFromTitle('Hello', [])).toBe('hello');
    expect(chatIdFromTitle('Éclair Count', [])).toBe('clair_count');
  });

  it('prefixes invalid or empty slugs', () => {
    expect(chatIdFromTitle('123 Convicts', [])).toBe('chat_123_convicts');
    expect(chatIdFromTitle('###', [])).toBe('chat');
    expect(chatIdFromTitle('', [])).toBe('chat');
  });

  it('appends uniqueness suffixes against existing chat ids', () => {
    expect(chatIdFromTitle('Hello', ['hello'])).toBe('hello_2');
    expect(chatIdFromTitle('Hello', ['hello', 'hello_2'])).toBe('hello_3');
    expect(chatIdFromTitle('###', ['chat', 'chat_2'])).toBe('chat_3');
  });

  it('ignores ids of other kinds when generating', () => {
    expect(chatIdFromTitle('Hello', ['project_hello'])).toBe('hello');
  });
});

describe('parseChatCreatePayload', () => {
  it('accepts a minimal create with only a title', () => {
    expect(parseChatCreatePayload({ title: 'Notes' })).toEqual({
      ok: true,
      input: {
        title: 'Notes',
        id: undefined,
        topics: undefined,
        projects: undefined,
        message: undefined,
        at: undefined,
      },
    });
  });

  it('accepts the full create shape', () => {
    const parsed = parseChatCreatePayload({
      title: 'Notes',
      id: 'chat_notes',
      topics: ['optimization'],
      projects: ['project_evon'],
      message: 'First question.',
      at: '2026-09-10',
    });
    expect(parsed).toEqual({
      ok: true,
      input: {
        title: 'Notes',
        id: 'chat_notes',
        topics: ['optimization'],
        projects: ['project_evon'],
        message: 'First question.',
        at: '2026-09-10',
      },
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseChatCreatePayload('nope').ok).toBe(false);
    expect(parseChatCreatePayload({}).ok).toBe(false);
    expect(parseChatCreatePayload({ title: 7 }).ok).toBe(false);
    expect(parseChatCreatePayload({ title: 'T', id: 7 }).ok).toBe(false);
    expect(parseChatCreatePayload({ title: 'T', topics: 'x' }).ok).toBe(false);
    expect(parseChatCreatePayload({ title: 'T', projects: 'x' }).ok).toBe(
      false,
    );
    expect(parseChatCreatePayload({ title: 'T', message: 7 }).ok).toBe(false);
    expect(parseChatCreatePayload({ title: 'T', at: 7 }).ok).toBe(false);
  });
});

describe('parseChatSendPayload', () => {
  it('accepts a message with an optional backend and hash', () => {
    expect(
      parseChatSendPayload({
        message: 'Hello',
        backend: 'stub-model',
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: {
        message: 'Hello',
        backend: 'stub-model',
        expectedHash: 'ab'.repeat(32),
      },
    });
    expect(parseChatSendPayload({ message: 'Hello' })).toEqual({
      ok: true,
      input: { message: 'Hello', backend: null, expectedHash: null },
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseChatSendPayload('nope').ok).toBe(false);
    expect(parseChatSendPayload({}).ok).toBe(false);
    expect(parseChatSendPayload({ message: 7 }).ok).toBe(false);
    expect(parseChatSendPayload({ message: 'm', backend: 7 }).ok).toBe(false);
  });
});

describe('parseChatMembershipPayload', () => {
  it('accepts a project id', () => {
    expect(parseChatMembershipPayload({ projectId: 'project_evon' })).toEqual({
      ok: true,
      input: { projectId: 'project_evon' },
    });
  });

  it('rejects missing or malformed project ids', () => {
    expect(parseChatMembershipPayload('nope').ok).toBe(false);
    expect(parseChatMembershipPayload({}).ok).toBe(false);
    expect(parseChatMembershipPayload({ projectId: '' }).ok).toBe(false);
    expect(parseChatMembershipPayload({ projectId: 7 }).ok).toBe(false);
  });
});

describe('parseChatPromotePayload', () => {
  it('accepts an id and title with an optional directory', () => {
    expect(
      parseChatPromotePayload({
        id: 'project_notes',
        title: 'Notes',
        directory: 'notes-area',
      }),
    ).toEqual({
      ok: true,
      input: {
        id: 'project_notes',
        title: 'Notes',
        directory: 'notes-area',
      },
    });
    expect(
      parseChatPromotePayload({ id: 'project_notes', title: 'Notes' }),
    ).toEqual({
      ok: true,
      input: { id: 'project_notes', title: 'Notes', directory: undefined },
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseChatPromotePayload('nope').ok).toBe(false);
    expect(parseChatPromotePayload({}).ok).toBe(false);
    expect(parseChatPromotePayload({ id: 'x' }).ok).toBe(false);
    expect(
      parseChatPromotePayload({ id: 'x', title: 'Notes', directory: 7 }).ok,
    ).toBe(false);
  });
});

describe('parseBackendAddPayload', () => {
  it('accepts a name, type, and config with a hash', () => {
    expect(
      parseBackendAddPayload({
        name: 'stub-model',
        type: 'openai',
        config: { model: 'test-model' },
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: {
        name: 'stub-model',
        type: 'openai',
        config: { model: 'test-model' },
        expectedHash: 'ab'.repeat(32),
      },
    });
  });

  it('treats a missing config as empty and rejects non-object configs', () => {
    expect(
      parseBackendAddPayload({
        name: 'stub-model',
        type: 'opencode',
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: {
        name: 'stub-model',
        type: 'opencode',
        config: {},
        expectedHash: 'ab'.repeat(32),
      },
    });
    expect(
      parseBackendAddPayload({ name: 's', type: 'openai', config: 'x' }).ok,
    ).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(parseBackendAddPayload('nope').ok).toBe(false);
    expect(parseBackendAddPayload({}).ok).toBe(false);
    expect(parseBackendAddPayload({ name: 's' }).ok).toBe(false);
    expect(parseBackendAddPayload({ name: 's', type: 'openai' }).ok).toBe(true);
    expect(
      parseBackendAddPayload({ name: '', type: 'openai', config: {} }).ok,
    ).toBe(false);
    expect(parseBackendAddPayload({ name: 's', type: '', config: {} }).ok).toBe(
      false,
    );
  });
});

describe('parseBackendUpdatePayload', () => {
  it('accepts a name and config and defaults the config to empty', () => {
    expect(
      parseBackendUpdatePayload({
        name: 'stub-model',
        config: { model: 'next' },
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: {
        name: 'stub-model',
        config: { model: 'next' },
        expectedHash: 'ab'.repeat(32),
      },
    });
    expect(
      parseBackendUpdatePayload({
        name: 'stub-model',
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: { name: 'stub-model', config: {}, expectedHash: 'ab'.repeat(32) },
    });
  });

  it('rejects malformed payloads', () => {
    expect(parseBackendUpdatePayload('nope').ok).toBe(false);
    expect(parseBackendUpdatePayload({ config: {} }).ok).toBe(false);
    expect(parseBackendUpdatePayload({ name: 's', config: 'x' }).ok).toBe(
      false,
    );
  });
});

describe('parseBackendNamePayload', () => {
  it('accepts a name with a hash', () => {
    expect(
      parseBackendNamePayload({
        name: 'stub-model',
        expectedHash: 'ab'.repeat(32),
      }),
    ).toEqual({
      ok: true,
      input: { name: 'stub-model', expectedHash: 'ab'.repeat(32) },
    });
  });

  it('rejects missing names', () => {
    expect(parseBackendNamePayload('nope').ok).toBe(false);
    expect(parseBackendNamePayload({}).ok).toBe(false);
    expect(parseBackendNamePayload({ name: '' }).ok).toBe(false);
  });
});

describe('parseBackendTestPayload', () => {
  it('accepts a name', () => {
    expect(parseBackendTestPayload({ name: 'stub-model' })).toEqual({
      ok: true,
      input: { name: 'stub-model' },
    });
  });

  it('rejects missing names', () => {
    expect(parseBackendTestPayload('nope').ok).toBe(false);
    expect(parseBackendTestPayload({}).ok).toBe(false);
  });
});
