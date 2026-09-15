import { useEffect, useRef, useState, type ReactNode } from 'react';

import { classNames } from './logic.js';

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode | undefined;
  ariaLabel?: string | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}

// Matches the .mdedit transform transition in global.css.
const transitionMs = 260;

export function SlideOver({
  open,
  onClose,
  title,
  children,
  footer,
  ariaLabel,
  className,
  testId = 'slide-over',
}: SlideOverProps) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      setMounted(true);
      const frame = requestAnimationFrame(() => {
        setShown(true);
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => {
      setMounted(false);
    }, transitionMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [open]);

  useEffect(() => {
    if (!mounted) return;
    if (open) {
      const frame = requestAnimationFrame(() => {
        panelRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(frame);
      };
    }
    openerRef.current?.focus();
    openerRef.current = null;
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <>
      <div
        className={classNames('edscrim', shown && 'open')}
        onClick={onClose}
      />
      <aside
        ref={panelRef}
        className={classNames('mdedit', shown && 'open', className)}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? title}
        tabIndex={-1}
        data-testid={testId}
      >
        <div className="ede-h">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 className="ede-name">{title}</h2>
          </div>
          <button
            className="x"
            type="button"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="ede-body">{children}</div>
        {footer !== undefined && <div className="ede-f">{footer}</div>}
      </aside>
    </>
  );
}
