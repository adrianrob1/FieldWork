import { describe, expect, it } from 'vitest';

import {
  appendResults,
  documentTarget,
  hitTarget,
  lineRangeLabel,
  matchLabel,
  parseSnippet,
  searchPagePath,
  searchRoute,
  searchStatus,
  showingLabel,
  toSearchData,
  type SearchData,
  type SearchResultEntry,
} from '../../web/src/pages/searchModel.js';

function entryOf(overrides: Partial<SearchResultEntry>): SearchResultEntry {
  return {
    source: 'workspace',
    kind: 'resource',
    path: 'projects/evon/context/posterior.md',
    objectId: null,
    repositoryId: null,
    title: 'posterior',
    snippet: 'the [posterior] predictive ranks',
    lineStart: 12,
    lineEnd: 30,
    matchCount: 3,
    ...overrides,
  };
}

function dataOf(overrides: Partial<SearchData>): SearchData {
  return {
    query: 'posterior',
    scope: { kind: 'workspace' },
    results: [],
    totalResults: 0,
    returnedResults: 0,
    limit: 50,
    offset: 0,
    hasMore: false,
    durationMs: 3,
    index: {
      path: '/tmp/index.sqlite',
      modifiedAt: new Date(2026, 8, 10, 9, 29, 58).toISOString(),
      counts: {
        files: 41,
        objects: 30,
        references: 12,
        repositories: 2,
        documents: 41,
      },
    },
    diagnostics: [],
    ...overrides,
  };
}

describe('parseSnippet', () => {
  it('splits multiple bracketed marks', () => {
    const segments = parseSnippet('a [posterior] b [ranks] c');
    expect(segments).toEqual([
      { text: 'a ', match: false },
      { text: 'posterior', match: true },
      { text: ' b ', match: false },
      { text: 'ranks', match: true },
      { text: ' c', match: false },
    ]);
  });

  it('treats html-looking marked content as inert text', () => {
    const segments = parseSnippet('x [<img src=x onerror=alert(1)>] y');
    expect(segments).toEqual([
      { text: 'x ', match: false },
      { text: '<img src=x onerror=alert(1)>', match: true },
      { text: ' y', match: false },
    ]);
  });

  it('parses tag-style marks too', () => {
    const segments = parseSnippet('a <mark>post</mark> b');
    expect(segments).toEqual([
      { text: 'a ', match: false },
      { text: 'post', match: true },
      { text: ' b', match: false },
    ]);
  });

  it('returns no segments for an empty snippet', () => {
    expect(parseSnippet('')).toEqual([]);
  });

  it('keeps an unmatched bracket as text', () => {
    expect(parseSnippet('array[0')).toEqual([
      { text: 'array[0', match: false },
    ]);
  });
});

describe('documentTarget and hitTarget', () => {
  it('routes chat hits to the chat page', () => {
    expect(documentTarget('chat', 'chat_rank', 'chats/x.md')).toEqual({
      navigable: true,
      to: '/chats/chat_rank',
    });
  });

  it('routes project hits to the project page', () => {
    expect(
      documentTarget('project', 'posterior-diagnostics', 'projects/x.md'),
    ).toEqual({
      navigable: true,
      to: '/projects/posterior-diagnostics',
    });
  });

  it('routes other workspace hits to the editor by encoded path', () => {
    expect(
      documentTarget('resource', null, 'projects/evon/context/posterior.md'),
    ).toEqual({
      navigable: true,
      to: `/edit?path=${encodeURIComponent('projects/evon/context/posterior.md')}`,
    });
  });

  it('marks repository hits as non-navigable', () => {
    const target = hitTarget(
      entryOf({
        source: 'repository',
        kind: 'repository',
        repositoryId: 'evon',
      }),
    );
    expect(target).toEqual({
      navigable: false,
      repositoryId: 'evon',
      path: 'projects/evon/context/posterior.md',
    });
  });
});

describe('labels', () => {
  it('formats line ranges and match counts', () => {
    expect(lineRangeLabel(entryOf({ lineStart: 12, lineEnd: 30 }))).toBe(
      'lines 12-30',
    );
    expect(lineRangeLabel(entryOf({ lineStart: 5, lineEnd: 5 }))).toBe(
      'line 5',
    );
    expect(lineRangeLabel(entryOf({ lineStart: null, lineEnd: null }))).toBe(
      '',
    );
    expect(matchLabel(1)).toBe('1 match');
    expect(matchLabel(3)).toBe('3 matches');
  });
});

describe('pagination', () => {
  it('appends the next page after the existing results', () => {
    const first = entryOf({ path: 'a' });
    const second = entryOf({ path: 'b' });
    expect(appendResults([first], [second])).toEqual([first, second]);
    expect(appendResults([first], [])).toEqual([first]);
  });

  it('shows the returned vs total counts', () => {
    expect(showingLabel(8, 5)).toBe('Showing 5 of 8 results');
  });
});

describe('searchStatus', () => {
  it('reports hits, duration, and index freshness', () => {
    const now = new Date(2026, 8, 10, 10, 0, 0);
    const view = searchStatus(
      dataOf({ totalResults: 8, returnedResults: 5, durationMs: 3 }),
      now,
    );
    expect(view.hitsLabel).toBe('8 hits in 41 documents');
    expect(view.durationLabel).toBe('3 ms');
    expect(view.indexLabel).toBe('index current as of 09:29:58');
  });

  it('falls back when the index is unknown', () => {
    const now = new Date(2026, 8, 10, 10, 0, 0);
    const view = searchStatus(
      dataOf({
        index: {
          path: '',
          modifiedAt: '1970-01-01T00:00:00.000Z',
          counts: null,
        },
      }),
      now,
    );
    expect(view.indexLabel).toBe('index freshness unknown');
  });
});

describe('toSearchData', () => {
  it('parses scope, results, and optional fields', () => {
    const data = toSearchData({
      query: 'posterior',
      scope: { kind: 'project', project: 'project_evon' },
      results: [
        {
          source: 'repository',
          kind: 'repository',
          path: 'repositories/evon/src/posterior.py',
          repositoryId: 'evon',
          title: 'posterior',
          snippet: 'def rank_[posterior](draws, ranks)',
          lineStart: 88,
          lineEnd: 120,
          matchCount: 2,
        },
      ],
      totalResults: 1,
      returnedResults: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
      durationMs: 4,
      index: { path: 'x', modifiedAt: '2026-09-10T09:29:58.000Z' },
      diagnostics: [],
    });
    expect(data.scope).toEqual({ kind: 'project', project: 'project_evon' });
    expect(data.results[0]?.source).toBe('repository');
    expect(data.results[0]?.objectId).toBeNull();
    expect(data.results[0]?.lineStart).toBe(88);
  });
});

describe('route builders', () => {
  it('encodes the query and project scope', () => {
    expect(searchRoute('rank diagnostics', 'project_evon', 0, 0)).toBe(
      '/api/search?q=rank+diagnostics&project=project_evon',
    );
    expect(searchRoute('posterior', null, 50, 50)).toBe(
      '/api/search?q=posterior&offset=50&limit=50',
    );
    expect(searchPagePath('posterior', null)).toBe('/search?q=posterior');
  });
});
