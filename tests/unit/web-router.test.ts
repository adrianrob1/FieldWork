import { describe, expect, it } from 'vitest';

import {
  bodyClassForRoute,
  isListRoute,
  matchRoutePath,
  navNameForRoute,
  parseRoute,
} from '../../web/src/shared/router.js';

describe('matchRoutePath', () => {
  it('matches the workspace root', () => {
    expect(matchRoutePath('/')).toEqual({ name: 'workspace', params: {} });
  });

  it('matches list and detail routes with parameters', () => {
    expect(matchRoutePath('/projects')).toEqual({
      name: 'projects',
      params: {},
    });
    expect(matchRoutePath('/projects/project_evon')).toEqual({
      name: 'project',
      params: { id: 'project_evon' },
    });
    expect(matchRoutePath('/chats')).toEqual({ name: 'chats', params: {} });
    expect(matchRoutePath('/chats/chat_alpha')).toEqual({
      name: 'chat',
      params: { id: 'chat_alpha' },
    });
    expect(matchRoutePath('/tasks')).toEqual({ name: 'tasks', params: {} });
    expect(matchRoutePath('/settings')).toEqual({
      name: 'settings',
      params: {},
    });
  });

  it('matches the new chat route before the chat id parameter', () => {
    expect(matchRoutePath('/chats/new')).toEqual({
      name: 'chat-new',
      params: {},
    });
    expect(matchRoutePath('/chats/chat_alpha')).toEqual({
      name: 'chat',
      params: { id: 'chat_alpha' },
    });
  });

  it('decodes URL-encoded parameters', () => {
    expect(matchRoutePath('/chats/chat%20alpha')).toEqual({
      name: 'chat',
      params: { id: 'chat alpha' },
    });
  });

  it('tolerates a trailing slash', () => {
    expect(matchRoutePath('/projects/')).toEqual({
      name: 'projects',
      params: {},
    });
  });

  it('returns null for unknown paths', () => {
    expect(matchRoutePath('/nope')).toBeNull();
    expect(matchRoutePath('/projects/a/b')).toBeNull();
    expect(matchRoutePath('/api/workspace')).toBeNull();
  });
});

describe('parseRoute', () => {
  it('exposes query parameters for search routes', () => {
    const route = parseRoute('/search', '?q=posterior&project=project_evon');
    expect(route.name).toBe('search');
    expect(route.query.get('q')).toBe('posterior');
    expect(route.query.get('project')).toBe('project_evon');
  });

  it('exposes the edit path and draft query parameters', () => {
    expect(
      parseRoute(
        '/edit',
        `?path=${encodeURIComponent('chats/a.md')}`,
      ).query.get('path'),
    ).toBe('chats/a.md');
    expect(parseRoute('/chats/new', '?draft=draft_1').query.get('draft')).toBe(
      'draft_1',
    );
  });

  it('falls back to not-found for unknown paths', () => {
    const route = parseRoute('/nope');
    expect(route.name).toBe('not-found');
    expect(route.params).toEqual({});
    expect(route.pathname).toBe('/nope');
  });

  it('no longer matches the removed context view', () => {
    expect(matchRoutePath('/context')).toBeNull();
    expect(parseRoute('/context').name).toBe('not-found');
  });

  it('normalizes a search string without the leading question mark', () => {
    expect(parseRoute('/search', 'q=x').query.get('q')).toBe('x');
  });
});

describe('route classification helpers', () => {
  it('marks the chats and tasks routes as list routes', () => {
    expect(isListRoute('chats')).toBe(true);
    expect(isListRoute('tasks')).toBe(true);
    expect(isListRoute('chat')).toBe(false);
  });

  it('maps routes to their navigation section', () => {
    expect(navNameForRoute('workspace')).toBe('overview');
    expect(navNameForRoute('project')).toBe('projects');
    expect(navNameForRoute('chat')).toBe('chats');
    expect(navNameForRoute('not-found')).toBeNull();
  });

  it('assigns the body class that drives single-pane mobile layout', () => {
    expect(bodyClassForRoute('chats')).toBe('chatlist');
    expect(bodyClassForRoute('chat')).toBe('chatpg');
    expect(bodyClassForRoute('chat-new')).toBe('ncpg');
    expect(bodyClassForRoute('edit')).toBe('editpg');
    expect(bodyClassForRoute('projects')).toBe('');
  });
});
