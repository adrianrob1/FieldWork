import { describe, expect, it } from 'vitest';

import {
  MAX_BRANCHES,
  MAX_CONTEXT_FILES,
  MIN_BRANCH_SCORE,
  scoreBranches,
  selectBranches,
  type BranchCandidate,
} from '../../src/search/routing.js';

function candidate(overrides: Partial<BranchCandidate>): BranchCandidate {
  return {
    id: 'summary_base',
    title: 'Base summary',
    path: 'summaries/base.md',
    kind: 'project',
    project: 'project_base',
    keywords: [],
    topics: [],
    ftsRank: null,
    ...overrides,
  };
}

describe('scoreBranches', () => {
  it('orders exact id above exact title above keyword above FTS-only', () => {
    const branches = scoreBranches('posterior', [
      candidate({ id: 'summary_fts', ftsRank: -0.25 }),
      candidate({ id: 'summary_keyword', keywords: ['posterior'] }),
      candidate({ id: 'summary_title', title: 'Posterior' }),
      candidate({ id: 'posterior' }),
    ]);

    expect(branches.map((branch) => branch.id)).toEqual([
      'posterior',
      'summary_title',
      'summary_keyword',
      'summary_fts',
    ]);
    expect(branches[0]?.score.exactId).toBe(100);
    expect(branches[1]?.score.exactTitle).toBe(60);
    expect(branches[2]?.score.keywords).toBe(20);
    expect(branches[2]?.score.keywordMatches).toEqual(['posterior']);
    expect(branches[3]?.score.fts).toBeGreaterThan(0);
    expect(branches[3]?.score.fts).toBeLessThan(20);
  });

  it('matches a multi-word keyword when the query contains it', () => {
    const branches = scoreBranches('posterior rank behavior', [
      candidate({ keywords: ['posterior rank', 'other'] }),
    ]);

    expect(branches[0]?.score.keywordMatches).toEqual(['posterior rank']);
    expect(branches[0]?.score.keywords).toBe(20);
  });

  it('does not match a keyword that is only a substring of a query term', () => {
    const branches = scoreBranches('diagnostics', [
      candidate({ keywords: ['gnostics'] }),
    ]);

    expect(branches[0]?.score.keywords).toBe(0);
  });

  it('caps the keyword score at two matching keywords', () => {
    const branches = scoreBranches('alpha beta gamma', [
      candidate({ keywords: ['alpha', 'beta', 'gamma'] }),
    ]);

    expect(branches[0]?.score.keywordMatches).toHaveLength(3);
    expect(branches[0]?.score.keywords).toBe(40);
  });

  it('converts FTS rank into a bounded component that decays with |rank|', () => {
    const strong = scoreBranches('term', [
      candidate({ id: 'a', ftsRank: -0.25 }),
    ]);
    const weak = scoreBranches('term', [candidate({ id: 'a', ftsRank: -9 })]);
    const missing = scoreBranches('term', [candidate({ id: 'a' })]);

    expect(strong[0]?.score.fts).toBe(8);
    expect(weak[0]?.score.fts).toBe(1);
    expect(missing[0]?.score.fts).toBe(0);
  });

  it('adds a small bonus for query terms overlapping topic labels', () => {
    const branches = scoreBranches('preconditioning', [
      candidate({ id: 'topic_a', topics: ['topic_preconditioning'] }),
      candidate({ id: 'summary_b', topics: [] }),
    ]);

    expect(branches.find(({ id }) => id === 'topic_a')?.score.topic).toBe(3);
    expect(branches.find(({ id }) => id === 'summary_b')?.score.topic).toBe(0);
  });

  it('breaks score ties deterministically by id and then path', () => {
    const branches = scoreBranches('unmatched', [
      candidate({ id: 'summary_z', path: 'b.md' }),
      candidate({ id: 'summary_a', path: 'z.md' }),
      candidate({ id: 'summary_z', path: 'a.md' }),
    ]);

    expect(branches.map((branch) => [branch.id, branch.path])).toEqual([
      ['summary_a', 'z.md'],
      ['summary_z', 'a.md'],
      ['summary_z', 'b.md'],
    ]);
  });

  it('gives every candidate a zero total for an empty query', () => {
    const branches = scoreBranches('   ', [
      candidate({ id: 'summary_a', keywords: ['alpha'], ftsRank: -0.25 }),
    ]);

    expect(branches[0]?.score.exactId).toBe(0);
    expect(branches[0]?.score.exactTitle).toBe(0);
    expect(branches[0]?.score.keywords).toBe(0);
    expect(branches[0]?.score.topic).toBe(0);
  });

  it('keeps an exact id match case-sensitive', () => {
    const branches = scoreBranches('Summary_Evon', [
      candidate({ id: 'summary_evon' }),
    ]);

    expect(branches[0]?.score.exactId).toBe(0);
  });
});

describe('selectBranches', () => {
  it('exposes the bounded retrieval limits', () => {
    expect(MAX_BRANCHES).toBe(2);
    expect(MAX_CONTEXT_FILES).toBe(10);
    expect(MIN_BRANCH_SCORE).toBe(1);
  });

  it('keeps at most two branches above the floor', () => {
    const scored = scoreBranches('term', [
      candidate({ id: 'summary_d', ftsRank: -0.1 }),
      candidate({ id: 'summary_a', ftsRank: -0.1 }),
      candidate({ id: 'summary_c', ftsRank: -0.1 }),
      candidate({ id: 'summary_b', ftsRank: -0.1 }),
    ]);

    const selected = selectBranches(scored);

    expect(selected.map((branch) => branch.id)).toEqual([
      'summary_a',
      'summary_b',
    ]);
  });

  it('drops branches whose only signal is a weak FTS hit', () => {
    const scored = scoreBranches('term', [
      candidate({ id: 'summary_weak', ftsRank: -100 }),
      candidate({ id: 'summary_strong', ftsRank: -0.5 }),
    ]);

    const selected = selectBranches(scored);

    expect(selected.map((branch) => branch.id)).toEqual(['summary_strong']);
    expect(
      scored.find((branch) => branch.id === 'summary_weak')?.score.total,
    ).toBeLessThan(MIN_BRANCH_SCORE);
  });

  it('returns an empty selection when nothing clears the floor', () => {
    const scored = scoreBranches('quokka zephyr', [
      candidate({ id: 'summary_a', title: 'Unrelated', keywords: ['other'] }),
    ]);

    expect(selectBranches(scored)).toEqual([]);
  });
});
