import { describe, expect, it } from 'vitest';

import {
  chatFilterCounts,
  chatFilterTabActive,
  chatListViewUrl,
  draftRoute,
  filterTabLabel,
  mobileDraftMediaQuery,
  projectOptionsOf,
  projectTitlesOf,
  toProjectOptionItems,
  type ChatFilterView,
} from '../../web/src/pages/chats/chatListModel.js';

describe('chatListViewUrl', () => {
  it('maps the default view to the all endpoint', () => {
    expect(chatListViewUrl({ kind: 'all' })).toBe('/api/chats?view=all');
  });

  it('maps the unassigned view', () => {
    expect(chatListViewUrl({ kind: 'unassigned' })).toBe(
      '/api/chats?view=unassigned',
    );
  });

  it('maps a project view and encodes the id', () => {
    expect(chatListViewUrl({ kind: 'project', projectId: 'project_a b' })).toBe(
      '/api/chats?view=project&project=project_a%20b',
    );
  });
});

describe('chatFilterTabActive', () => {
  const all: ChatFilterView = { kind: 'all' };
  const unassigned: ChatFilterView = { kind: 'unassigned' };
  const project: ChatFilterView = { kind: 'project', projectId: 'p1' };

  it('marks only the matching tab', () => {
    expect(chatFilterTabActive(all, 'all')).toBe(true);
    expect(chatFilterTabActive(all, 'unassigned')).toBe(false);
    expect(chatFilterTabActive(all, 'project')).toBe(false);
    expect(chatFilterTabActive(unassigned, 'unassigned')).toBe(true);
    expect(chatFilterTabActive(unassigned, 'all')).toBe(false);
    expect(chatFilterTabActive(project, 'project')).toBe(true);
    expect(chatFilterTabActive(project, 'all')).toBe(false);
  });
});

describe('draftRoute', () => {
  it('stays on /chats on desktop and opens the dedicated route on mobile', () => {
    expect(draftRoute('draft_abc', false)).toBe('/chats?draft=draft_abc');
    expect(draftRoute('draft_abc', true)).toBe('/chats/new?draft=draft_abc');
  });

  it('encodes the draft id', () => {
    expect(draftRoute('draft a/b', false)).toBe('/chats?draft=draft%20a%2Fb');
  });

  it('exposes the mobile media query used at click time', () => {
    expect(mobileDraftMediaQuery).toBe('(max-width: 719px)');
  });
});

describe('filterTabLabel', () => {
  it('shows the live count on each tab', () => {
    expect(filterTabLabel('all', 3)).toBe('All · 3');
    expect(filterTabLabel('unassigned', 1)).toBe('Unassigned · 1');
    expect(filterTabLabel('unassigned', 0)).toBe('Unassigned · 0');
  });
});

describe('chatFilterCounts', () => {
  it('maps each view fetch to its live tab count', () => {
    expect(
      chatFilterCounts({ all: ['a', 'b', 'c'], unassigned: ['c'] }),
    ).toEqual({ all: 3, unassigned: 1 });
  });

  it('reports zero while a view has no entries', () => {
    expect(chatFilterCounts({ all: [], unassigned: [] })).toEqual({
      all: 0,
      unassigned: 0,
    });
  });
});

describe('project options', () => {
  const payload = {
    chats: [],
    projects: [
      { id: 'project_evon', title: 'Evolutionary optimization' },
      { id: 'project_soap_bubbles', title: 'SOAP-Bubbles' },
      { id: 'project_untitled', title: '' },
    ],
  };

  it('maps the API project list to dropdown options', () => {
    expect(projectOptionsOf(payload)).toEqual([
      { id: 'project_evon', label: 'Evolutionary optimization' },
      { id: 'project_soap_bubbles', label: 'SOAP-Bubbles' },
      { id: 'project_untitled', label: 'project_untitled' },
    ]);
  });

  it('maps ids to titles for row tags', () => {
    const titles = projectTitlesOf(payload);
    expect(titles.get('project_evon')).toBe('Evolutionary optimization');
    expect(titles.get('project_untitled')).toBe('project_untitled');
  });

  it('tolerates a missing project list', () => {
    expect(projectOptionsOf({ chats: [] })).toEqual([]);
    expect(projectOptionsOf(null)).toEqual([]);
  });

  it('converts options to control items', () => {
    expect(toProjectOptionItems([{ id: 'p1', label: 'One' }])).toEqual([
      { id: 'p1', label: 'One' },
    ]);
  });
});
