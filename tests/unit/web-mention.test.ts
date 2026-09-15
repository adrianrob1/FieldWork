import { describe, expect, it } from 'vitest';

import {
  consumeMention,
  findMentionQuery,
  mentionBaseQuery,
  mentionFetchDecision,
  mentionUrl,
} from '../../web/src/shared/controls/useMentionPicker.js';
import { hasMessageText } from '../../web/src/pages/draftFlow.js';

describe('findMentionQuery', () => {
  it('opens at the start of the string', () => {
    expect(findMentionQuery('#', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(findMentionQuery('#wri', 4)).toEqual({
      start: 0,
      end: 4,
      query: 'wri',
    });
  });

  it('opens after whitespace', () => {
    expect(findMentionQuery('hel #wri', 8)).toEqual({
      start: 4,
      end: 8,
      query: 'wri',
    });
  });

  it('opens for a hash inside the current token (probe case)', () => {
    expect(findMentionQuery('hel#wri', 7)).toEqual({
      start: 3,
      end: 7,
      query: 'wri',
    });
  });

  it('reports an empty query when the caret sits right after the hash', () => {
    expect(findMentionQuery('hel#wri', 4)).toEqual({
      start: 3,
      end: 4,
      query: '',
    });
  });

  it('returns null when the token has no hash', () => {
    expect(findMentionQuery('hello', 5)).toBeNull();
    expect(findMentionQuery('hel #wri', 3)).toBeNull();
  });

  it('returns null at the start of the string and before the hash', () => {
    expect(findMentionQuery('#wri', 0)).toBeNull();
    expect(findMentionQuery('hel#wri', 2)).toBeNull();
  });

  it('ignores an escaped double hash', () => {
    expect(findMentionQuery('##foo', 5)).toBeNull();
    expect(findMentionQuery('hel ##foo', 9)).toBeNull();
  });

  it('treats a second hash as the start of a fresh mention', () => {
    expect(findMentionQuery('#a#b', 4)).toEqual({
      start: 2,
      end: 4,
      query: 'b',
    });
  });

  it('stops the query at the caret and clamps an out-of-range caret', () => {
    expect(findMentionQuery('hel#wri more', 7)).toEqual({
      start: 3,
      end: 7,
      query: 'wri',
    });
    expect(findMentionQuery('#wri', 99)).toEqual({
      start: 0,
      end: 4,
      query: 'wri',
    });
  });
});

describe('consumeMention', () => {
  it('removes the hash token and leaves the prefix', () => {
    expect(consumeMention('hel#wri', { start: 3, end: 7 })).toEqual({
      text: 'hel',
      caret: 3,
    });
  });

  it('collapses the seam when the token followed a space', () => {
    expect(consumeMention('hel #wri', { start: 4, end: 8 })).toEqual({
      text: 'hel',
      caret: 3,
    });
  });

  it('keeps the text after the token and collapses a doubled seam space', () => {
    expect(consumeMention('hel#wri more', { start: 3, end: 7 })).toEqual({
      text: 'hel more',
      caret: 3,
    });
    expect(consumeMention('hel #wri more', { start: 4, end: 8 })).toEqual({
      text: 'hel more',
      caret: 4,
    });
  });

  it('handles a token that fills the whole message', () => {
    expect(consumeMention('#wri', { start: 0, end: 4 })).toEqual({
      text: '',
      caret: 0,
    });
  });
});

describe('mentionFetchDecision', () => {
  it('does nothing while closed', () => {
    expect(
      mentionFetchDecision({
        open: false,
        query: 'wri',
        baseLoaded: false,
        activeQuery: null,
      }),
    ).toEqual({ action: 'skip' });
  });

  it('loads the base list once when the popup opens with an empty query', () => {
    expect(
      mentionFetchDecision({
        open: true,
        query: '',
        baseLoaded: false,
        activeQuery: null,
      }),
    ).toEqual({ action: 'load-base' });
    expect(
      mentionFetchDecision({
        open: true,
        query: '',
        baseLoaded: true,
        activeQuery: '',
      }),
    ).toEqual({ action: 'skip' });
  });

  it('searches a new trimmed query and skips an unchanged one', () => {
    expect(
      mentionFetchDecision({
        open: true,
        query: 'w',
        baseLoaded: true,
        activeQuery: null,
      }),
    ).toEqual({ action: 'search', query: 'w' });
    expect(
      mentionFetchDecision({
        open: true,
        query: '  w  ',
        baseLoaded: true,
        activeQuery: 'w',
      }),
    ).toEqual({ action: 'skip' });
    expect(
      mentionFetchDecision({
        open: true,
        query: 'wr',
        baseLoaded: true,
        activeQuery: 'w',
      }),
    ).toEqual({ action: 'search', query: 'wr' });
  });
});

describe('mentionUrl', () => {
  it('uses the base query with no term and encodes the search term', () => {
    expect(mentionUrl('')).toBe(mentionBaseQuery);
    expect(mentionUrl('wri')).toBe(`${mentionBaseQuery}&q=wri`);
    expect(mentionUrl(' a b ')).toBe(`${mentionBaseQuery}&q=a%20b`);
  });
});

describe('hasMessageText', () => {
  it('requires non-whitespace message text', () => {
    expect(hasMessageText('')).toBe(false);
    expect(hasMessageText('   ')).toBe(false);
    expect(hasMessageText('\n\t')).toBe(false);
    expect(hasMessageText('hi')).toBe(true);
    expect(hasMessageText('  hi  ')).toBe(true);
  });
});
