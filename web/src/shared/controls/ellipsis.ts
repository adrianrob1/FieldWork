// Middle-ellipsis fitting, ported from the Sidecar mockup's fitClip/fitAllClips.
// The pure helpers below are the deterministic core the DOM fitter drives, so
// the algorithm can be unit tested without a browser.

export const ellipsisChar = '…';

export interface ClipPlan {
  head: number;
  tail: number;
}

// Mirrors fitClip's starting split: the head keeps roughly 60% of the budget.
export function clipPlan(total: number): ClipPlan {
  const size = Math.max(0, Math.trunc(total));
  const head = size === 0 ? 0 : Math.ceil(size * 0.6);
  return { head, tail: Math.max(0, size - head) };
}

// One step of fitClip's shrink loop. Returns null once the plan has no room
// left to shrink into (the mockup stops when head + tail drops to 2).
export function clipNext(plan: ClipPlan): ClipPlan | null {
  if (plan.head + plan.tail <= 2) return null;
  if (plan.head > plan.tail) return { head: plan.head - 1, tail: plan.tail };
  return { head: plan.head, tail: plan.tail - 1 };
}

// Renders the plan. When the plan already covers the whole string the full
// text is returned unchanged, so callers never see an inserted ellipsis.
export function clipText(full: string, plan: ClipPlan): string {
  if (plan.head + plan.tail >= full.length) return full;
  return (
    full.slice(0, plan.head) +
    ellipsisChar +
    full.slice(full.length - plan.tail)
  );
}

// Deterministic, char-budget version of the DOM fitter. The result never
// exceeds maxChars and keeps both edges whenever maxChars is at least 3.
export function middleClip(text: string, maxChars: number): string {
  const budget = Math.trunc(maxChars);
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  if (budget < 3) return ellipsisChar;
  const inner = budget - 1;
  let head = Math.ceil(inner * 0.6);
  let tail = inner - head;
  if (tail < 1) {
    tail = 1;
    head = inner - 1;
  }
  if (head < 1) {
    head = 1;
    tail = inner - 1;
  }
  let plan: ClipPlan = { head, tail };
  let value = clipText(text, plan);
  while (value.length > budget) {
    const next = clipNext(plan);
    if (next === null) break;
    plan = next;
    value = clipText(text, plan);
  }
  return value;
}
