import { describe, expect, it } from 'vitest';

import {
  isMacPlatform,
  isSearchShortcut,
  searchShortcutLabel,
} from '../../web/src/shared/shortcut.js';

describe('isMacPlatform', () => {
  it('detects macOS and iOS platforms', () => {
    expect(
      isMacPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0' }),
    ).toBe(true);
    expect(isMacPlatform({ platform: 'iPhone', userAgent: '' })).toBe(true);
  });

  it('rejects Windows and Linux platforms', () => {
    expect(isMacPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0' })).toBe(
      false,
    );
    expect(isMacPlatform({ platform: 'Linux x86_64', userAgent: '' })).toBe(
      false,
    );
  });
});

describe('searchShortcutLabel', () => {
  it('uses the command glyph on macOS and Ctrl elsewhere', () => {
    expect(searchShortcutLabel(true)).toBe('⌘F');
    expect(searchShortcutLabel(false)).toBe('Ctrl+F');
  });
});

describe('isSearchShortcut', () => {
  const base = {
    key: 'f',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };

  it('matches Ctrl+F and Cmd+F', () => {
    expect(isSearchShortcut({ ...base, ctrlKey: true })).toBe(true);
    expect(isSearchShortcut({ ...base, metaKey: true })).toBe(true);
  });

  it('matches the capital key', () => {
    expect(isSearchShortcut({ ...base, key: 'F', ctrlKey: true })).toBe(true);
  });

  it('rejects plain F, other modifiers, and other keys', () => {
    expect(isSearchShortcut(base)).toBe(false);
    expect(isSearchShortcut({ ...base, key: 'g', ctrlKey: true })).toBe(false);
    expect(isSearchShortcut({ ...base, ctrlKey: true, altKey: true })).toBe(
      false,
    );
    expect(isSearchShortcut({ ...base, ctrlKey: true, shiftKey: true })).toBe(
      false,
    );
  });
});
