import { useEffect, useRef, type RefObject } from 'react';

import type { AttachableView } from '../../pages/draftFlow.js';
import { MenuItem } from './Menu.js';
import { classNames } from './logic.js';

export interface MentionPopupProps {
  open: boolean;
  items: readonly AttachableView[];
  activeIndex: number;
  // Index-based so keyboard and click picks share the hook's consume logic.
  onPick: (index: number) => void;
  onClose: () => void;
  // Clicks inside the owning textarea keep the popup (they only move the
  // caret); anything else outside the popover closes it.
  ignoreRef?: RefObject<HTMLElement | null> | undefined;
  id?: string | undefined;
  testId?: string | undefined;
}

// The `#` picker popover. Reuses the shared dropdown building blocks (the
// `.ddop`/`.ddup` placement and `MenuItem` rows) but is controlled by the
// mention hook rather than a trigger button, so focus never leaves the
// textarea. It opens upward with `placement="top"` styling for bottom-docked
// composers.
export function MentionPopup({
  open,
  items,
  activeIndex,
  onPick,
  onClose,
  ignoreRef,
  id,
  testId = 'mention-popup',
}: MentionPopupProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true) return;
      if (ignoreRef?.current?.contains(target) === true) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, onClose, ignoreRef]);

  useEffect(() => {
    if (!open) return;
    const active =
      rootRef.current?.querySelector<HTMLElement>('.dditem.active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  return (
    <span className="ddown mention-anchor" ref={rootRef}>
      <span
        className={classNames(
          'ddop',
          'ddup',
          'align-left',
          'mention-popup',
          open && 'open',
        )}
        id={id}
        role="menu"
        aria-label="Mention attachment"
        data-testid={testId}
      >
        {items.length === 0 ? (
          <p className="stub-note">No attachables</p>
        ) : (
          items.map((item, index) => (
            <MenuItem
              key={item.id}
              label={item.label}
              sublabel={item.kind}
              className={index === activeIndex ? 'active' : undefined}
              testId={`mention-item-${item.id}`}
              onSelect={() => {
                onPick(index);
              }}
            />
          ))
        )}
      </span>
    </span>
  );
}
