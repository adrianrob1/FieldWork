import { useMemo, type CSSProperties } from 'react';

// Staggered entry timing copied from the mockup's .rise rules in global.css:
// 0.02s for the first child, +0.04s per row, capped at the tenth (0.38s).
const staggerBase = 0.02;
const staggerStep = 0.04;
const staggerMaxIndex = 9;

export function staggerDelaySeconds(index: number): number {
  const safe = Math.max(0, Math.trunc(index));
  const capped = Math.min(safe, staggerMaxIndex);
  return Number((staggerBase + staggerStep * capped).toFixed(2));
}

export function staggerStyle(index: number): CSSProperties {
  return {
    animationDelay: `${String(staggerDelaySeconds(index))}s`,
    animationFillMode: 'backwards',
  };
}

export function staggerStyles(count: number): CSSProperties[] {
  const total = Math.max(0, Math.trunc(count));
  return Array.from({ length: total }, (_, index) => staggerStyle(index));
}

export function useStagger(count: number): CSSProperties[] {
  return useMemo(() => staggerStyles(count), [count]);
}
