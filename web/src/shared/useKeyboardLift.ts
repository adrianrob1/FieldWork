import { useEffect, type RefObject } from 'react';

// Mobile keyboard fallback: lift the composer by the pixels the keyboard
// covers. Engines with interactive-widget=resizes-content report ~0.
export function useKeyboardLift(target: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const element = target.current;
    const viewport = window.visualViewport;
    if (element === null || viewport === null) return;
    const lift = () => {
      const covered = window.innerHeight - viewport.height - viewport.offsetTop;
      element.style.bottom = `${String(Math.max(0, Math.round(covered)))}px`;
    };
    viewport.addEventListener('resize', lift);
    viewport.addEventListener('scroll', lift);
    lift();
    return () => {
      viewport.removeEventListener('resize', lift);
      viewport.removeEventListener('scroll', lift);
    };
  }, [target]);
}
