import { describe, expect, it } from 'vitest';

import {
  clipNext,
  clipPlan,
  clipText,
  middleClip,
} from '../../web/src/shared/controls/ellipsis.js';
import {
  backendIconKind,
  escapeAction,
  filterItems,
  multiSelectLabel,
  resolveRenameValue,
  selectedCount,
  toggleSelection,
  type OptionItem,
} from '../../web/src/shared/controls/logic.js';

const alpha: OptionItem = { id: 'alpha', label: 'Alpha', keywords: ['first'] };
const beta: OptionItem = { id: 'beta', label: 'Beta' };
const gamma: OptionItem = {
  id: 'gamma',
  label: 'Gamma',
  keywords: ['Third', 'zebra'],
};
const items: OptionItem[] = [alpha, beta, gamma];

describe('middleClip', () => {
  it('returns short strings untouched', () => {
    expect(middleClip('abc', 7)).toBe('abc');
  });

  it('returns strings exactly at the budget untouched', () => {
    expect(middleClip('abcdefg', 7)).toBe('abcdefg');
  });

  it('mid-clips only when necessary and preserves both edges', () => {
    expect(middleClip('abcdefgh', 7)).toBe('abcd…gh');
    expect(middleClip('abcdefghij', 7)).toBe('abcd…ij');
    expect(
      middleClip('Evolution of the organization', 12).startsWith('Evol'),
    ).toBe(true);
  });

  it('keeps both edge characters for any clipped string', () => {
    const full = 'Evolution of the organization';
    for (let budget = 3; budget <= full.length; budget += 1) {
      const clipped = middleClip(full, budget);
      expect(clipped.length).toBeLessThanOrEqual(budget);
      expect(clipped.startsWith(full[0] ?? '')).toBe(true);
      expect(clipped.endsWith(full[full.length - 1] ?? '')).toBe(true);
    }
  });

  it('never exceeds the budget', () => {
    const full = 'abcdefghijklmnop';
    for (let budget = 0; budget <= 20; budget += 1) {
      expect(middleClip(full, budget).length).toBeLessThanOrEqual(budget);
    }
  });

  it('handles budgets smaller than three', () => {
    expect(middleClip('abcdef', 2)).toBe('…');
    expect(middleClip('abcdef', 1)).toBe('…');
    expect(middleClip('abcdef', 0)).toBe('');
    expect(middleClip('abcdef', -1)).toBe('');
  });
});

describe('clip plan helpers', () => {
  it('splits the head and tail at roughly 60 percent', () => {
    expect(clipPlan(10)).toEqual({ head: 6, tail: 4 });
    expect(clipPlan(6)).toEqual({ head: 4, tail: 2 });
    expect(clipPlan(0)).toEqual({ head: 0, tail: 0 });
  });

  it('renders the full string when the plan already covers it', () => {
    expect(clipText('abc', { head: 2, tail: 2 })).toBe('abc');
    expect(clipText('abcdefghij', { head: 3, tail: 2 })).toBe('abc…ij');
  });

  it('shrinks the larger side and stops at two remaining characters', () => {
    expect(clipNext({ head: 3, tail: 1 })).toEqual({ head: 2, tail: 1 });
    expect(clipNext({ head: 1, tail: 3 })).toEqual({ head: 1, tail: 2 });
    expect(clipNext({ head: 2, tail: 0 })).toBeNull();
    expect(clipNext({ head: 1, tail: 1 })).toBeNull();
  });
});

describe('filterItems', () => {
  it('returns every item for an empty query', () => {
    expect(filterItems(items, '').map((item) => item.id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(filterItems(items, '   ').map((item) => item.id)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });

  it('matches labels case-insensitively', () => {
    expect(filterItems(items, 'ALPHA').map((item) => item.id)).toEqual([
      'alpha',
    ]);
    expect(filterItems(items, 'be').map((item) => item.id)).toEqual(['beta']);
  });

  it('matches keywords case-insensitively', () => {
    expect(filterItems(items, 'first').map((item) => item.id)).toEqual([
      'alpha',
    ]);
    expect(filterItems(items, 'THIRD').map((item) => item.id)).toEqual([
      'gamma',
    ]);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterItems(items, 'zzz')).toEqual([]);
  });
});

describe('escapeAction', () => {
  it('closes when the query is empty', () => {
    expect(escapeAction('')).toBe('close');
  });

  it('clears when the query has any content', () => {
    expect(escapeAction('proj')).toBe('clear');
    expect(escapeAction('   ')).toBe('clear');
  });
});

describe('multi-select helpers', () => {
  it('labels the pick count with a middle dot separator', () => {
    expect(multiSelectLabel('Projects', 0)).toBe('Projects');
    expect(multiSelectLabel('Projects', 2)).toBe('Projects · 2');
    expect(multiSelectLabel('Projects', 12)).toBe('Projects · 12');
  });

  it('toggles ids without mutating the input', () => {
    const start: string[] = ['a'];
    expect(toggleSelection(start, 'b')).toEqual(['a', 'b']);
    expect(toggleSelection(start, 'a')).toEqual([]);
    expect(start).toEqual(['a']);
  });

  it('counts the selected ids', () => {
    expect(selectedCount([])).toBe(0);
    expect(selectedCount(['a', 'b'])).toBe(2);
  });
});

describe('resolveRenameValue', () => {
  it('commits a changed value', () => {
    expect(resolveRenameValue('Old', 'New', 'commit')).toBe('New');
    expect(resolveRenameValue('Old', '  New  ', 'commit')).toBe('New');
  });

  it('cancels back to the original', () => {
    expect(resolveRenameValue('Old', 'New', 'cancel')).toBe('Old');
  });

  it('keeps the old name for an empty or whitespace-only edit', () => {
    expect(resolveRenameValue('Old', '', 'commit')).toBe('Old');
    expect(resolveRenameValue('Old', '   ', 'commit')).toBe('Old');
  });

  it('keeps the old name when the value is unchanged', () => {
    expect(resolveRenameValue('Old', 'Old', 'commit')).toBe('Old');
  });
});

describe('backendIconKind', () => {
  it('maps the three backend types to icon kinds', () => {
    expect(backendIconKind('openai')).toBe('cloud');
    expect(backendIconKind('opencode')).toBe('terminal');
    expect(backendIconKind('agent')).toBe('plug');
  });

  it('falls back to terminal for agent-* and unknown types', () => {
    expect(backendIconKind('agent-codex')).toBe('terminal');
    expect(backendIconKind('mystery')).toBe('terminal');
    expect(backendIconKind('')).toBe('terminal');
  });
});
