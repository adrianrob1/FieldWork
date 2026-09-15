import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';

import {
  classNames,
  escapeAction,
  filterItems,
  type OptionItem,
} from './logic.js';

// Menus mix plain menuitems with single- and multi-select rows, so roving
// focus must cover all three roles. Disabled rows stay out of the ring.
const focusableItemSelector = [
  '[role="menuitem"]:not([aria-disabled="true"])',
  '[role="menuitemradio"]:not([aria-disabled="true"])',
  '[role="menuitemcheckbox"]:not([aria-disabled="true"])',
].join(', ');

export interface MenuTriggerProps {
  ref: Ref<HTMLButtonElement>;
  id: string;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

export interface MenuProps {
  trigger: (props: MenuTriggerProps) => ReactNode;
  children: ReactNode;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  align?: 'left' | 'right' | undefined;
  stack?: boolean | undefined;
  className?: string | undefined;
  ariaLabel?: string | undefined;
  menuId?: string | undefined;
  testId?: string | undefined;
  // 'bottom' opens below the trigger (default); 'top' opens upward, for
  // controls docked to the bottom of the view like the chat composer.
  placement?: 'top' | 'bottom' | undefined;
  // Return true to keep the menu open after Escape (the FilterMenu uses this
  // to clear a non-empty query first). Return false or nothing to close.
  onEscape?: (() => boolean) | undefined;
  focusOnOpen?: 'first' | 'none' | undefined;
}

function useControllableOpen(
  openProp: boolean | undefined,
  defaultOpen: boolean,
  onOpenChange: ((open: boolean) => void) | undefined,
): [boolean, (next: boolean) => void] {
  const [internal, setInternal] = useState(defaultOpen);
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : internal;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInternal(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange],
  );
  return [open, setOpen];
}

export function Menu({
  trigger,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  align = 'right',
  stack = false,
  className,
  ariaLabel,
  menuId,
  testId,
  placement = 'bottom',
  onEscape,
  focusOnOpen = 'first',
}: MenuProps) {
  const autoId = useId();
  const id = menuId ?? `${autoId}-menu`;
  const [open, setOpen] = useControllableOpen(
    openProp,
    defaultOpen,
    onOpenChange,
  );
  const wrapperRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLSpanElement | null>(null);
  const wasOpenRef = useRef(open);
  const suppressFocusRef = useRef(false);
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  const close = useCallback(
    (returnFocus: boolean) => {
      suppressFocusRef.current = !returnFocus;
      setOpen(false);
    },
    [setOpen],
  );

  // Return focus to the trigger on close, except when the close came from a
  // pointer press outside the menu (that press owns focus now).
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (wasOpen && !open) {
      if (!suppressFocusRef.current) triggerRef.current?.focus();
      suppressFocusRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        wrapperRef.current?.contains(target) === true
      )
        return;
      close(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const handled = onEscapeRef.current?.();
      if (handled === true) return;
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close]);

  useEffect(() => {
    if (!open || focusOnOpen === 'none') return;
    const handle = window.setTimeout(() => {
      const first = popRef.current?.querySelector<HTMLElement>(
        focusableItemSelector,
      );
      first?.focus();
    }, 0);
    return () => window.clearTimeout(handle);
  }, [open, focusOnOpen]);

  const handleTriggerClick = useCallback(() => {
    if (open) {
      close(false);
      return;
    }
    setOpen(true);
  }, [open, close, setOpen]);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown' && !open) {
        event.preventDefault();
        setOpen(true);
      }
    },
    [open, setOpen],
  );

  const handlePopoverKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      const items = Array.from(
        popRef.current?.querySelectorAll<HTMLElement>(focusableItemSelector) ??
          [],
      );
      if (items.length === 0) return;
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        const next = index < 0 ? 0 : (index + 1) % items.length;
        items[next]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        const next = index <= 0 ? items.length - 1 : index - 1;
        items[next]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    [],
  );

  const triggerProps: MenuTriggerProps = {
    ref: triggerRef,
    id: `${id}-trigger`,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': id,
    onClick: handleTriggerClick,
    onKeyDown: handleTriggerKeyDown,
  };

  return (
    <span className="ddown" ref={wrapperRef}>
      {trigger(triggerProps)}
      <span
        className={classNames(
          'ddop',
          align === 'left' && 'align-left',
          stack && 'stack',
          placement === 'top' && 'ddup',
          open && 'open',
          className,
        )}
        id={id}
        ref={popRef}
        role="menu"
        aria-label={ariaLabel}
        data-testid={testId}
        onKeyDown={handlePopoverKeyDown}
      >
        {children}
      </span>
    </span>
  );
}

export type MenuItemRole = 'menuitem' | 'menuitemcheckbox' | 'menuitemradio';

export interface MenuItemProps {
  label: ReactNode;
  sublabel?: string | undefined;
  keywords?: readonly string[] | undefined;
  icon?: ReactNode | undefined;
  hint?: ReactNode | undefined;
  selected?: boolean | undefined;
  disabled?: boolean | undefined;
  danger?: boolean | undefined;
  role?: MenuItemRole | undefined;
  className?: string | undefined;
  onSelect?: (() => void) | undefined;
  testId?: string | undefined;
}

export function MenuItem({
  label,
  sublabel,
  icon,
  hint,
  selected = false,
  disabled = false,
  danger = false,
  role = 'menuitem',
  className,
  onSelect,
  testId,
}: MenuItemProps) {
  const checked =
    role === 'menuitem'
      ? undefined
      : selected
        ? ('true' as const)
        : ('false' as const);
  return (
    <button
      type="button"
      role={role}
      aria-disabled={disabled ? true : undefined}
      aria-checked={checked}
      disabled={disabled}
      className={classNames('dditem', danger && 'warn', className)}
      data-testid={testId}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
      }}
    >
      <span className="ddi-main">
        {icon}
        <span>
          {label}
          {sublabel !== undefined && (
            <span className="ddi-sub">{` · ${sublabel}`}</span>
          )}
        </span>
      </span>
      {hint !== undefined && <span className="hint">{hint}</span>}
    </button>
  );
}

export interface FilterMenuProps<T extends OptionItem> {
  items: readonly T[];
  trigger: (props: MenuTriggerProps) => ReactNode;
  renderItem: (item: T) => ReactNode;
  open?: boolean | undefined;
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  placeholder?: string | undefined;
  ariaLabel: string;
  align?: 'left' | 'right' | undefined;
  stack?: boolean | undefined;
  placement?: 'top' | 'bottom' | undefined;
  className?: string | undefined;
  emptyText?: string | undefined;
  menuTestId?: string | undefined;
}

export function FilterMenu<T extends OptionItem>({
  items,
  trigger,
  renderItem,
  open,
  defaultOpen,
  onOpenChange,
  placeholder = 'Filter',
  ariaLabel,
  align,
  stack,
  placement,
  className,
  emptyText = 'No matches',
  menuTestId,
}: FilterMenuProps<T>) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setOpen] = useControllableOpen(
    open,
    defaultOpen ?? false,
    onOpenChange,
  );
  const visible = filterItems(items, query);

  // Reset the query every time the menu reopens and focus the filter box.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    const handle = window.setTimeout(() => inputRef.current?.focus(), 60);
    return () => window.clearTimeout(handle);
  }, [isOpen]);

  const handleEscape = useCallback(() => {
    if (escapeAction(query) === 'clear') {
      setQuery('');
      inputRef.current?.focus();
      return true;
    }
    return false;
  }, [query]);

  return (
    <Menu
      trigger={trigger}
      open={isOpen}
      onOpenChange={setOpen}
      align={align}
      stack={stack}
      placement={placement}
      className={className}
      ariaLabel={ariaLabel}
      testId={menuTestId}
      onEscape={handleEscape}
      focusOnOpen="none"
    >
      <span className="ddsearch">
        <input
          ref={inputRef}
          className="dds"
          type="text"
          value={query}
          placeholder={placeholder}
          aria-label={ariaLabel}
          data-testid="filter-menu-input"
          onChange={(event) => {
            setQuery(event.currentTarget.value);
          }}
        />
      </span>
      {visible.length === 0 ? (
        <p className="stub-note">{emptyText}</p>
      ) : (
        visible.map((item) => renderItem(item))
      )}
    </Menu>
  );
}
