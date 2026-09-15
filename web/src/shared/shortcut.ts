// Global search shortcut: Cmd+F on macOS, Ctrl+F elsewhere.

export interface ShortcutLikeEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isMacPlatform(navigatorLike?: {
  platform?: string;
  userAgent?: string;
}): boolean {
  const source =
    navigatorLike === undefined
      ? typeof navigator === 'undefined'
        ? ''
        : `${navigator.platform} ${navigator.userAgent}`
      : `${navigatorLike.platform ?? ''} ${navigatorLike.userAgent ?? ''}`;
  return /mac|iphone|ipad|ipod/i.test(source);
}

export function searchShortcutLabel(mac?: boolean): string {
  return (mac ?? isMacPlatform()) ? '⌘F' : 'Ctrl+F';
}

export function isSearchShortcut(event: ShortcutLikeEvent): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === 'f';
}
