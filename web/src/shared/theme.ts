import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

export const themeStorageKey = 'lh-sidecar-theme';

interface ViewTransitionLike {
  ready: Promise<void>;
  finished: Promise<void>;
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void) => ViewTransitionLike;
};

export interface ThemeToggleEvent {
  clientX?: number;
  clientY?: number;
}

function rootElement(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

export function currentTheme(): Theme {
  return rootElement()?.dataset.theme === 'light' ? 'light' : 'dark';
}

function persistTheme(next: Theme): void {
  try {
    localStorage.setItem(themeStorageKey, next);
  } catch {
    // Private mode or file:// — the theme still applies for this session.
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

let activeTheme: Theme = currentTheme();
const themeListeners = new Set<() => void>();

function applyTheme(next: Theme): void {
  const element = rootElement();
  if (element !== null) element.dataset.theme = next;
  persistTheme(next);
  activeTheme = next;
  for (const listener of themeListeners) listener();
}

function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function themeSnapshot(): Theme {
  return activeTheme;
}

export function flipTheme(x?: number, y?: number): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  const paint = () => {
    applyTheme(next);
  };
  if (
    prefersReducedMotion() ||
    typeof document === 'undefined' ||
    typeof window === 'undefined'
  ) {
    paint();
    return next;
  }
  const doc = document as DocumentWithViewTransition;
  if (typeof doc.startViewTransition === 'function') {
    const cx = typeof x === 'number' && x > 0 ? x : window.innerWidth - 60;
    const cy = typeof y === 'number' && y > 0 ? y : 24;
    const radius = Math.hypot(
      Math.max(cx, window.innerWidth - cx),
      Math.max(cy, window.innerHeight - cy),
    );
    const element = document.documentElement;
    element.classList.add('vt-circle');
    const transition = doc.startViewTransition(paint);
    // View Transitions can stall in a background or non-compositing tab, so a
    // watchdog guarantees the theme still flips and the helper class clears.
    let settled = false;
    let watchdog = 0;
    const settle = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(watchdog);
      element.classList.remove('vt-circle');
    };
    watchdog = window.setTimeout(() => {
      paint();
      settle();
    }, 700);
    void transition.ready
      .then(() => {
        element.animate(
          {
            clipPath: [
              `circle(0px at ${String(cx)}px ${String(cy)}px)`,
              `circle(${String(radius)}px at ${String(cx)}px ${String(cy)}px)`,
            ],
          },
          {
            duration: 520,
            easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)',
            pseudoElement: '::view-transition-new(root)',
          },
        );
        return transition.finished;
      })
      .catch(() => undefined)
      .then(settle);
    return next;
  }
  document.body.animate([{ opacity: 1 }, { opacity: 0.55 }, { opacity: 1 }], {
    duration: 240,
    easing: 'ease-out',
  });
  window.setTimeout(paint, 120);
  return next;
}

export function useTheme(): [Theme, (event?: ThemeToggleEvent) => void] {
  const theme = useSyncExternalStore(
    subscribeTheme,
    themeSnapshot,
    themeSnapshot,
  );
  const toggleAt = useCallback((event?: ThemeToggleEvent) => {
    flipTheme(event?.clientX, event?.clientY);
  }, []);
  return [theme, toggleAt];
}
