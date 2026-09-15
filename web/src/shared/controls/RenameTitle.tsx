import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';

import { classNames, resolveRenameValue, type RenameIntent } from './logic.js';

// Module-level store keyed by titleKey. Multiple RenameTitle instances that
// share a key (chat full header plus the sticky bar) stay in sync.
const titleStore = new Map<string, string>();
const titleListeners = new Map<string, Set<() => void>>();

function emitTitle(key: string): void {
  for (const listener of titleListeners.get(key) ?? []) listener();
}

export function setTitle(key: string, value: string): void {
  titleStore.set(key, value);
  emitTitle(key);
}

export function getTitle(key: string): string | undefined {
  return titleStore.get(key);
}

export function subscribeTitle(key: string, listener: () => void): () => void {
  let set = titleListeners.get(key);
  if (set === undefined) {
    set = new Set();
    titleListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) titleListeners.delete(key);
  };
}

export interface RenameTitleProps {
  value: string;
  onCommit: (value: string) => void | Promise<void>;
  onError?: ((error: unknown) => void) | undefined;
  titleKey?: string | undefined;
  className?: string | undefined;
  inputClassName?: string | undefined;
  ariaLabel?: string | undefined;
  testId?: string | undefined;
}

export function RenameTitle({
  value,
  onCommit,
  onError,
  titleKey,
  className,
  inputClassName,
  ariaLabel = 'Title',
  testId = 'rename-title',
}: RenameTitleProps) {
  const subscribe = useCallback(
    (listener: () => void) =>
      titleKey === undefined
        ? () => undefined
        : subscribeTitle(titleKey, listener),
    [titleKey],
  );
  const snapshot = useCallback(
    () => (titleKey === undefined ? undefined : getTitle(titleKey)),
    [titleKey],
  );
  const stored = useSyncExternalStore(subscribe, snapshot, snapshot);
  const display = stored ?? value;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(display);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busyRef = useRef(false);
  const skipBlurRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const startEdit = useCallback(() => {
    skipBlurRef.current = false;
    setDraft(display);
    setFailed(false);
    setEditing(true);
  }, [display]);

  const finish = useCallback(
    async (intent: RenameIntent) => {
      if (busyRef.current) return;
      busyRef.current = true;
      // The blur that follows this close is already accounted for.
      skipBlurRef.current = true;
      const next = resolveRenameValue(display, draft, intent);
      if (intent === 'cancel' || next === display) {
        setEditing(false);
        busyRef.current = false;
        return;
      }
      setPending(true);
      if (titleKey !== undefined) setTitle(titleKey, next);
      try {
        await onCommit(next);
      } catch (error) {
        if (titleKey !== undefined) setTitle(titleKey, display);
        setFailed(true);
        onError?.(error);
      } finally {
        setPending(false);
        setEditing(false);
        busyRef.current = false;
      }
    },
    [display, draft, titleKey, onCommit, onError],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void finish('commit');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        void finish('cancel');
      }
    },
    [finish],
  );

  const handleDisplayKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        startEdit();
      }
    },
    [startEdit],
  );

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={classNames('input', 'ti-inp', inputClassName)}
        style={{ width: `${String(Math.max(draft.length, 4))}ch` }}
        value={draft}
        disabled={pending}
        aria-label={ariaLabel}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
        }}
        onKeyDown={handleInputKeyDown}
        onBlur={() => {
          if (skipBlurRef.current) return;
          void finish('commit');
        }}
      />
    );
  }

  return (
    <span
      className={classNames('ti', failed && 'is-error', className)}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
      title={display}
      data-testid={testId}
      onClick={startEdit}
      onKeyDown={handleDisplayKeyDown}
    >
      {display}
    </span>
  );
}
