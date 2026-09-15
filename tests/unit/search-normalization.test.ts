import { describe, expect, it } from 'vitest';

import type { RepositoryMatch } from '../../src/index/repositories.js';
import {
  markTerms,
  mergeResults,
  queryTerms,
  repositoryEntriesFrom,
  type SearchResultEntry,
} from '../../src/search/lexical.js';

function workspaceEntry(path: string, title: string): SearchResultEntry {
  return {
    source: 'workspace',
    kind: 'chat',
    path,
    title,
    snippet: '[needle]',
    matchCount: 1,
  };
}

function repositoryEntry(
  path: string,
  repositoryId: string,
  matchCount: number,
): SearchResultEntry {
  return {
    source: 'repository',
    kind: 'repository',
    path,
    repositoryId,
    title: path,
    snippet: '[needle]',
    lineStart: 1,
    lineEnd: 1,
    matchCount,
  };
}

function match(
  repositoryId: string,
  path: string,
  line: number,
  text: string,
): RepositoryMatch {
  return { repositoryId, path, line, text };
}

describe('queryTerms', () => {
  it('splits a query on whitespace and drops empty terms', () => {
    expect(queryTerms('  posterior   rank ')).toEqual(['posterior', 'rank']);
    expect(queryTerms('posterior')).toEqual(['posterior']);
    expect(queryTerms('   ')).toEqual([]);
    expect(queryTerms('')).toEqual([]);
  });
});

describe('markTerms', () => {
  it('marks every case-insensitive term occurrence while keeping the original text', () => {
    expect(
      markTerms('Posterior checks and posterior updates', ['posterior']),
    ).toBe('[Posterior] checks and [posterior] updates');
  });

  it('marks several terms in one line', () => {
    expect(markTerms('scope needle', ['scope', 'needle'])).toBe(
      '[scope] [needle]',
    );
  });

  it('prefers the longest term when terms overlap', () => {
    expect(markTerms('the rankings table', ['rank', 'rankings'])).toBe(
      'the [rankings] table',
    );
  });

  it('escapes regular expression metacharacters in terms', () => {
    expect(markTerms('c++ and c++', ['c++'])).toBe('[c++] and [c++]');
  });

  it('returns the text unchanged without terms', () => {
    expect(markTerms('plain text', [])).toBe('plain text');
  });
});

describe('repositoryEntriesFrom', () => {
  it('aggregates per-line matches into one entry per file ordered by match count then path', () => {
    const entries = repositoryEntriesFrom(
      [
        match('repo_b', 'notes.md', 4, 'needle second file'),
        match('repo_b', 'notes.md', 9, 'needle again'),
        match('repo_a', 'zeta.md', 2, 'needle first repo'),
        match('repo_a', 'alpha.md', 1, 'Needle capital'),
        match('repo_a', 'alpha.md', 5, 'needle lower'),
        match('repo_c', 'alpha.md', 3, 'needle third repo'),
      ],
      ['needle'],
    );

    expect(entries.map((entry) => entry.repositoryId)).toEqual([
      'repo_a',
      'repo_b',
      'repo_c',
      'repo_a',
    ]);
    expect(entries.map((entry) => entry.path)).toEqual([
      'alpha.md',
      'notes.md',
      'alpha.md',
      'zeta.md',
    ]);
    expect(entries[0]).toMatchObject({
      source: 'repository',
      kind: 'repository',
      repositoryId: 'repo_a',
      path: 'alpha.md',
      title: 'alpha',
      snippet: '[Needle] capital',
      lineStart: 1,
      lineEnd: 1,
      matchCount: 2,
    });
    expect(entries[1]).toMatchObject({
      repositoryId: 'repo_b',
      path: 'notes.md',
      lineStart: 4,
      matchCount: 2,
    });
    expect(entries[2]).toMatchObject({
      repositoryId: 'repo_c',
      path: 'alpha.md',
      lineStart: 3,
      matchCount: 1,
    });
    expect(entries[3]).toMatchObject({
      repositoryId: 'repo_a',
      path: 'zeta.md',
      lineStart: 2,
      matchCount: 1,
    });
    expect(entries.every((entry) => entry.objectId === undefined)).toBe(true);
  });

  it('returns no entries without matches', () => {
    expect(repositoryEntriesFrom([], ['needle'])).toEqual([]);
  });
});

describe('mergeResults', () => {
  const workspace = [workspaceEntry('a.md', 'A'), workspaceEntry('b.md', 'B')];
  const repository = [
    repositoryEntry('x.txt', 'repo', 3),
    repositoryEntry('y.txt', 'repo', 1),
  ];

  it('places every workspace entry before repository entries', () => {
    const page = mergeResults(workspace, repository);
    expect(page.results.map((entry) => entry.source)).toEqual([
      'workspace',
      'workspace',
      'repository',
      'repository',
    ]);
  });

  it('returns the full list with default limit and offset', () => {
    const page = mergeResults(workspace, repository);
    expect(page).toEqual({
      results: [...workspace, ...repository],
      totalResults: 4,
      returnedResults: 4,
      limit: 50,
      offset: 0,
      hasMore: false,
    });
  });

  it('slices a page and reports whether more results exist', () => {
    const page = mergeResults(workspace, repository, 2, 1);
    expect(page.results).toEqual([workspace[1], repository[0]]);
    expect(page.returnedResults).toBe(2);
    expect(page.totalResults).toBe(4);
    expect(page.limit).toBe(2);
    expect(page.offset).toBe(1);
    expect(page.hasMore).toBe(true);

    const tail = mergeResults(workspace, repository, 2, 3);
    expect(tail.results).toEqual([repository[1]]);
    expect(tail.hasMore).toBe(false);
  });

  it('returns an empty page when the offset is past the end', () => {
    const page = mergeResults(workspace, repository, 10, 10);
    expect(page.results).toEqual([]);
    expect(page.returnedResults).toBe(0);
    expect(page.totalResults).toBe(4);
    expect(page.hasMore).toBe(false);
  });

  it('clamps the limit to 1..200 and the offset to non-negative integers', () => {
    expect(mergeResults(workspace, repository, 0).limit).toBe(1);
    expect(mergeResults(workspace, repository, 500).limit).toBe(200);
    expect(mergeResults(workspace, repository, -3).limit).toBe(1);
    expect(mergeResults(workspace, repository, 50, -4).offset).toBe(0);
    expect(mergeResults(workspace, repository, 4.7).limit).toBe(4);
    expect(mergeResults(workspace, repository, 50, 2.9).offset).toBe(2);
    expect(mergeResults(workspace, repository, Number.NaN).limit).toBe(50);
  });
});
