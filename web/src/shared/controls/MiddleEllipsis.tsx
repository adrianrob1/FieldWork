import { useEffect, useRef } from 'react';

import { clipNext, clipPlan, clipText, type ClipPlan } from './ellipsis.js';
import { classNames } from './logic.js';

export interface MiddleEllipsisProps {
  text: string;
  className?: string | undefined;
  title?: string | undefined;
  testId?: string | undefined;
}

// Direct DOM measurement (no canvas) with a ResizeObserver, ported from the
// mockup's fitClip. The full string always stays in the title attribute.
export function MiddleEllipsis({
  text,
  className,
  title,
  testId,
}: MiddleEllipsisProps) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const fit = () => {
      element.textContent = text;
      if (element.scrollWidth <= element.clientWidth + 1) return;
      let plan: ClipPlan = clipPlan(text.length);
      for (;;) {
        const next = clipNext(plan);
        if (next === null) break;
        plan = next;
        element.textContent = clipText(text, plan);
        if (element.scrollWidth <= element.clientWidth + 1) return;
      }
      element.textContent = clipText(text, { head: 1, tail: 1 });
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [text]);

  return (
    <span
      ref={ref}
      className={classNames(className)}
      title={title ?? text}
      data-testid={testId}
    />
  );
}
