import { useState } from 'react';

export interface ThoughtTraceProps {
  text: string;
  // Expanded while the turn streams, collapsed once the reply is committed.
  defaultExpanded: boolean;
  testId: string;
}

// The reasoning trace toggle. The region scrolls on its own once it passes
// ~40vh so the containing bubble never grows without bound.
export function ThoughtTrace({
  text,
  defaultExpanded,
  testId,
}: ThoughtTraceProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <div className="stream-thought" data-testid={testId}>
      <button
        type="button"
        className="sth-toggle"
        data-testid={`${testId}-toggle`}
        aria-expanded={expanded}
        onClick={() => {
          setExpanded((value) => !value);
        }}
      >
        <span className="sth-chev" aria-hidden="true">
          {expanded ? '▾' : '▸'}
        </span>
        Thinking
      </button>
      {expanded && <div className="sth-body">{text}</div>}
    </div>
  );
}
