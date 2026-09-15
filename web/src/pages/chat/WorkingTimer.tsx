import { useEffect, useState } from 'react';

import { workingLabelFor } from './chatThread.js';

// The elapsed "Working for …" microcopy at the top of a streaming bubble. The
// text is static microcopy, so the live-region semantics of the surrounding
// stream bubble already announce it; this component adds no role of its own.
export function WorkingTimer({
  startedAt,
}: {
  startedAt?: number | undefined;
}) {
  const [started] = useState(() => startedAt ?? Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  return (
    <span className="chip" data-testid="stream-working">
      {workingLabelFor(now - started)}
    </span>
  );
}
