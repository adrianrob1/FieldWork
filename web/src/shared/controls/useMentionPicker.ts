import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { getJson } from '../api.js';
import {
  parseAttachables,
  type AttachableView,
} from '../../pages/draftFlow.js';

// The `#` mention picker. Instead of a trigger button, it watches the textarea
// value and caret: typing `#` opens a popover above the box, typing after the
// `#` filters it, and picking a row stages an attachment while consuming the
// `#query` text. The pure decisions live at the top of this module so they can
// be unit tested without a DOM; the hook below is the React/fetch wrapper.

const kindsParam = 'task,resource,summary,chat,project';
export const mentionBaseQuery = `/api/attachables?kinds=${kindsParam}&limit=100`;
export const mentionDebounceMs = 200;

export interface MentionRange {
  start: number;
  end: number;
}

export interface MentionQuery extends MentionRange {
  // The characters typed after the `#`, before the caret.
  query: string;
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

// Trigger rule (documented): look at the whitespace-delimited token that holds
// the caret. If that token contains a `#` at or before the caret, the last such
// `#` starts a mention and the query is everything after it up to the caret.
// A `#` immediately preceded by another `#` is escaped literal text, and a
// token with no `#` has no mention. This is deliberately permissive so picking
// works mid-sentence (`hel#wri` opens with query `wri`); `#a#b` treats the
// second `#` as the start of a fresh mention.
export function findMentionQuery(
  text: string,
  caretIndex: number,
): MentionQuery | null {
  const caret = Math.max(0, Math.min(caretIndex, text.length));
  if (caret === 0) return null;
  let tokenStart = caret;
  while (tokenStart > 0 && !isWhitespace(text[tokenStart - 1])) tokenStart -= 1;
  const hash = text.lastIndexOf('#', caret - 1);
  if (hash < tokenStart) return null;
  if (text[hash - 1] === '#') return null;
  return { start: hash, end: caret, query: text.slice(hash + 1, caret) };
}

export interface MentionReplacement {
  text: string;
  caret: number;
}

// Consume the `#query` range when an item is picked: the text from `start` to
// the caret comes out, and the caret lands where the `#` used to be. A seam of
// two spaces (or a trailing space when the token ended the line) is collapsed
// so the remaining sentence does not gain an empty gap.
export function consumeMention(
  text: string,
  range: MentionRange,
): MentionReplacement {
  const start = Math.max(0, Math.min(range.start, text.length));
  const end = Math.max(start, Math.min(range.end, text.length));
  let head = text.slice(0, start);
  let tail = text.slice(end);
  if (head.endsWith(' ') && tail.startsWith(' ')) {
    tail = tail.slice(1);
  } else if (head.endsWith(' ') && tail === '') {
    head = head.slice(0, -1);
  }
  return { text: head + tail, caret: head.length };
}

export function mentionUrl(query: string): string {
  const term = query.trim();
  if (term === '') return mentionBaseQuery;
  return `${mentionBaseQuery}&q=${encodeURIComponent(term)}`;
}

export type MentionFetchDecision =
  | { action: 'skip' }
  | { action: 'load-base' }
  | { action: 'search'; query: string };

// The popup loads the unfiltered base list once per opening and then debounces
// one search per distinct trimmed query. An unchanged query is skipped so a
// re-render never refetches what is already shown.
export function mentionFetchDecision(input: {
  open: boolean;
  query: string;
  baseLoaded: boolean;
  activeQuery: string | null;
}): MentionFetchDecision {
  if (!input.open) return { action: 'skip' };
  const term = input.query.trim();
  if (term === '') {
    return input.baseLoaded ? { action: 'skip' } : { action: 'load-base' };
  }
  if (input.activeQuery === term) return { action: 'skip' };
  return { action: 'search', query: term };
}

export interface MentionPickerOptions {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  onPick: (attachable: AttachableView) => void;
  disabled?: boolean | undefined;
}

export interface MentionPickerResource {
  open: boolean;
  query: string;
  items: AttachableView[];
  activeIndex: number;
  popupId: string;
  // Returns true when the popup consumed the key; callers fall through to their
  // own Enter handling otherwise (so Cmd/Ctrl+Enter still sends).
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  pick: (index: number) => void;
  close: () => void;
}

export function useMentionPicker(
  options: MentionPickerOptions,
): MentionPickerResource {
  const { textareaRef, value, onChange, onPick, disabled = false } = options;
  const popupId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<AttachableView[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const rangeRef = useRef<MentionRange | null>(null);
  const baseItemsRef = useRef<AttachableView[] | null>(null);
  const baseLoadedRef = useRef(false);
  const activeQueryRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);

  // Detect the mention on every value change (typing, paste, deletion). The
  // caret is read from the live textarea; a null result closes the popup.
  useEffect(() => {
    if (disabled) {
      rangeRef.current = null;
      setOpen(false);
      setQuery('');
      return;
    }
    const element = textareaRef.current;
    const caret = element?.selectionStart ?? value.length;
    const found = findMentionQuery(value, caret);
    if (found === null) {
      rangeRef.current = null;
      setOpen(false);
      setQuery('');
      return;
    }
    rangeRef.current = { start: found.start, end: found.end };
    setQuery(found.query);
    setOpen(true);
  }, [value, disabled, textareaRef]);

  // A new query restarts the highlight at the first row.
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // Refetch the base list on each opening, then debounce one search per query.
  useEffect(() => {
    if (!open) {
      baseLoadedRef.current = false;
      activeQueryRef.current = null;
      return;
    }
    const decision = mentionFetchDecision({
      open,
      query,
      baseLoaded: baseLoadedRef.current,
      activeQuery: activeQueryRef.current,
    });
    if (decision.action === 'skip') {
      if (query.trim() === '' && baseItemsRef.current !== null) {
        setItems(baseItemsRef.current);
      }
      return;
    }
    if (decision.action === 'load-base') {
      const requestId = ++requestIdRef.current;
      void getJson<unknown>(mentionBaseQuery).then((outcome) => {
        if (requestIdRef.current !== requestId) return;
        baseLoadedRef.current = true;
        activeQueryRef.current = '';
        const next = outcome.ok ? parseAttachables(outcome.data) : [];
        baseItemsRef.current = next;
        setItems(next);
      });
      return;
    }
    const handle = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;
      void getJson<unknown>(mentionUrl(decision.query)).then((outcome) => {
        if (requestIdRef.current !== requestId) return;
        activeQueryRef.current = decision.query;
        setItems(outcome.ok ? parseAttachables(outcome.data) : []);
      });
    }, mentionDebounceMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [open, query]);

  const close = useCallback(() => {
    rangeRef.current = null;
    setOpen(false);
    setQuery('');
  }, []);

  const pick = useCallback(
    (index: number) => {
      const item = items[index];
      if (item === undefined) return;
      const range = rangeRef.current;
      onPick(item);
      if (range !== null) {
        const replacement = consumeMention(value, range);
        onChange(replacement.text);
        requestAnimationFrame(() => {
          const element = textareaRef.current;
          if (element === null) return;
          element.focus();
          element.setSelectionRange(replacement.caret, replacement.caret);
        });
      }
      close();
    },
    [items, onPick, onChange, value, textareaRef, close],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) =>
          items.length === 0 ? 0 : (current + 1) % items.length,
        );
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) =>
          items.length === 0
            ? 0
            : current <= 0
              ? items.length - 1
              : current - 1,
        );
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // Cmd/Ctrl+Enter is the explicit "send anyway" escape hatch.
        if (event.metaKey || event.ctrlKey) return false;
        event.preventDefault();
        pick(activeIndex);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [open, items.length, activeIndex, pick, close],
  );

  return {
    open,
    query,
    items,
    activeIndex,
    popupId,
    handleKeyDown,
    pick,
    close,
  };
}
