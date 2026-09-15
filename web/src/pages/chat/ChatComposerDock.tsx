import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from 'react';

import { getJson } from '../../shared/api.js';
import {
  BackendPicker,
  FilterMenu,
  MentionPopup,
  MenuItem,
  classNames,
  useMentionPicker,
  type OptionItem,
} from '../../shared/controls/index.js';
import { Link } from '../../shared/router.js';
import { useKeyboardLift } from '../../shared/useKeyboardLift.js';
import {
  hasMessageText,
  parseAttachables,
  type AttachableView,
} from '../draftFlow.js';
import {
  atBottom,
  composerShouldMinimize,
  distanceFromBottom,
  jumpDuration,
  jumpEase,
  jumpTarget,
  latestPillVisible,
  type ComposerAttachment,
} from './chatComposer.js';
import type { ChatDetail } from './chatThread.js';
import type { ChatComposerResource } from './useChatComposer.js';

const BASE_HEIGHT = 46;
const desktopQuery = '(min-width: 721px)';
const attachableQuery =
  '/api/attachables?kinds=task,resource,summary,chat,project&limit=200';

export interface ChatComposerProps {
  composer: ChatComposerResource;
  chat: ChatDetail;
  scrollRef: RefObject<HTMLDivElement | null>;
}

function AttachmentPicker({
  onPick,
  disabled,
}: {
  onPick: (attachable: AttachableView) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [attachables, setAttachables] = useState<AttachableView[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void getJson<unknown>(attachableQuery).then((outcome) => {
      if (!active) return;
      setAttachables(outcome.ok ? parseAttachables(outcome.data) : []);
    });
    return () => {
      active = false;
    };
  }, [open]);

  const items: OptionItem[] = attachables.map((entry) => ({
    id: entry.id,
    label: entry.label,
    keywords: [entry.kind, entry.path],
  }));

  return (
    <FilterMenu
      items={items}
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Attach context"
      align="left"
      placement="top"
      placeholder="Filter attachables"
      menuTestId="composer-attach-menu"
      emptyText="No attachables"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="cicon"
          aria-label="Attach a file"
          title="Attach a file"
          data-testid="composer-attach"
          disabled={disabled}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l8.57-8.57A4 4 0 1118 8.84l-8.59 8.57a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
      )}
      renderItem={(item) => {
        const attachable = attachables.find((entry) => entry.id === item.id);
        return (
          <MenuItem
            key={item.id}
            label={item.label}
            sublabel={attachable?.kind}
            testId={`attach-item-${item.id}`}
            onSelect={() => {
              if (attachable !== undefined) onPick(attachable);
              setOpen(false);
            }}
          />
        );
      }}
    />
  );
}

function StagedChips({
  attachments,
  onRemove,
}: {
  attachments: readonly ComposerAttachment[];
  onRemove: (key: string) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="cchips">
      {attachments.map((attachment, index) => (
        <span
          className="tag acc"
          key={attachment.key}
          data-testid={`composer-chip-${String(index)}`}
        >
          {attachment.label}
          <button
            className="link"
            type="button"
            aria-label={`Remove ${attachment.label}`}
            onClick={() => {
              onRemove(attachment.key);
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

// Pinned composer over the thread's gradient fade, ported from the mockup's
// initChatUX: the box grows with content up to 50vh, collapses to one line
// while the reader is away from the bottom, and the Latest pill rides above it.
export function ChatComposer({ composer, chat, scrollRef }: ChatComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const footRef = useRef<HTMLDivElement | null>(null);
  const jumpingRef = useRef(false);
  const [minimized, setMinimized] = useState(false);
  const [pillVisible, setPillVisible] = useState(false);

  useKeyboardLift(footRef);

  const mention = useMentionPicker({
    textareaRef,
    value: composer.message,
    onChange: composer.setMessage,
    onPick: composer.addAttachment,
    disabled: composer.sending,
  });

  const cap = useCallback(() => Math.round(window.innerHeight * 0.5), []);

  const grow = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const limit = cap();
    textarea.style.height = 'auto';
    const need = textarea.scrollHeight;
    textarea.style.height = `${String(Math.max(BASE_HEIGHT, Math.min(need, limit)))}px`;
    textarea.style.overflowY = need > limit ? 'auto' : 'hidden';
  }, [cap]);

  const minimize = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = `${String(BASE_HEIGHT)}px`;
    textarea.style.overflowY = 'hidden';
  }, []);

  const readGeometry = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return null;
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  }, [scrollRef]);

  const updateScroll = useCallback(() => {
    const geometry = readGeometry();
    if (geometry === null) return;
    if (!jumpingRef.current) {
      setMinimized(
        composerShouldMinimize({
          distanceFromBottom: distanceFromBottom(geometry),
          atBottom: atBottom(geometry),
          focused: document.activeElement === textareaRef.current,
        }),
      );
    }
    setPillVisible(latestPillVisible(distanceFromBottom(geometry)));
  }, [readGeometry]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onScroll = () => {
      updateScroll();
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    updateScroll();
    return () => {
      element.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef, updateScroll]);

  // Sizing effect: one line while minimized, otherwise content height capped at
  // 50vh. Runs on content and attachment changes as well as the collapse flag.
  useEffect(() => {
    if (minimized) {
      minimize();
      return;
    }
    grow();
  }, [
    minimized,
    composer.message,
    composer.attachments.length,
    grow,
    minimize,
  ]);

  // Desktop-only focus on load, without stealing the scroll position.
  useEffect(() => {
    if (!window.matchMedia(desktopQuery).matches) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  const jumpToLatest = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const target = jumpTarget({
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    });
    const start = element.scrollTop;
    if (
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      start === target
    ) {
      element.scrollTop = target;
      setMinimized(false);
      setPillVisible(false);
      grow();
      return;
    }
    jumpingRef.current = true;
    const span = target - start;
    const duration = jumpDuration(span);
    const startedAt = performance.now();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      jumpingRef.current = false;
      window.clearTimeout(watchdog);
      updateScroll();
      grow();
    };
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      element.scrollTop = start + span * jumpEase(progress);
      if (progress < 1 && jumpingRef.current) {
        requestAnimationFrame(step);
      } else {
        finish();
      }
    };
    // If frames stop arriving (hidden tab, throttled context), land directly.
    const watchdog = window.setTimeout(() => {
      if (jumpingRef.current) {
        element.scrollTop = target;
        finish();
      }
    }, duration + 120);
    requestAnimationFrame(step);
  }, [grow, scrollRef, updateScroll]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (mention.handleKeyDown(event)) return;
      if (event.key !== 'Enter') return;
      if (event.shiftKey) return;
      event.preventDefault();
      composer.send();
    },
    [composer, mention],
  );

  const canSend =
    hasMessageText(composer.message) &&
    !composer.sending &&
    chat.contentHash !== null;

  const failure = composer.sendState.failure;

  return (
    <div className="chatfoot" data-testid="chat-composer" ref={footRef}>
      <div className={classNames('cwrap', minimized && 'minwrap')}>
        <button
          className={classNames('jump-latest', pillVisible && 'show')}
          type="button"
          data-testid="latest-pill"
          aria-label="Jump to the latest message"
          onClick={jumpToLatest}
        >
          ↓ Latest
        </button>
        <MentionPopup
          open={mention.open}
          items={mention.items}
          activeIndex={mention.activeIndex}
          onPick={mention.pick}
          onClose={mention.close}
          ignoreRef={textareaRef}
          id={mention.popupId}
        />
        <textarea
          ref={textareaRef}
          className={classNames('cinput', minimized && 'min')}
          aria-controls={mention.popupId}
          data-testid="composer-input"
          rows={2}
          placeholder="Write a message"
          aria-label="Message"
          value={composer.message}
          onChange={(event) => {
            composer.setMessage(event.currentTarget.value);
            setMinimized(false);
          }}
          onFocus={() => {
            setMinimized(false);
          }}
          onKeyDown={handleKeyDown}
        />

        <StagedChips
          attachments={composer.attachments}
          onRemove={composer.removeAttachment}
        />

        <div className="cfoot">
          <AttachmentPicker
            onPick={composer.addAttachment}
            disabled={composer.sending}
          />
          <span className="grow" />
          <span data-testid="composer-backend">
            <BackendPicker
              value={composer.backend}
              onChange={composer.setBackend}
              disabled={composer.sending}
              ariaLabel="Backend for this turn"
              placement="top"
              testId="composer-backend-menu"
            />
          </span>
          <button
            className="btn primary sm"
            type="button"
            data-testid="composer-send"
            disabled={!canSend}
            onClick={() => {
              composer.send();
            }}
          >
            {composer.sending ? 'Sending…' : 'Send'}
          </button>
          {composer.sendState.status === 'sending' && (
            <button
              className="btn sm"
              type="button"
              data-testid="composer-stop"
              onClick={() => {
                composer.stop();
              }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                style={{ marginRight: 5, verticalAlign: '-1px' }}
              >
                <rect x="6" y="6" width="12" height="12" rx="1.5" />
              </svg>
              Stop
            </button>
          )}
        </div>

        {composer.sendState.status === 'stopped' && (
          <div className="ccfoot">
            <span className="tag" data-testid="composer-stopped">
              Stopped.
            </span>
          </div>
        )}

        {composer.sendState.status === 'conflict' && (
          <div
            className="note"
            data-testid="composer-conflict"
            style={{ borderLeftColor: 'var(--warn)', marginTop: 10 }}
          >
            <b>The chat changed on disk.</b> The transcript was reloaded so you
            are looking at the current text. Review it, then send again.
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button
                className="btn sm"
                type="button"
                data-testid="composer-retry"
                onClick={() => {
                  composer.retry();
                }}
              >
                Send again
              </button>
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  composer.resetError();
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {composer.sendState.status === 'failed' && failure !== null && (
          <div
            className="note"
            data-testid="composer-error"
            style={{ borderLeftColor: 'var(--danger)', marginTop: 10 }}
          >
            <b>{failure.message}</b>{' '}
            {failure.errorText ?? 'The message could not be sent.'}
            {failure.diagnostics.length > 0 && (
              <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                {failure.diagnostics.map((entry) => (
                  <li key={`${entry.code}:${entry.message}`}>
                    {entry.message}
                  </li>
                ))}
              </ul>
            )}
            {failure.needsSettings && (
              <div style={{ marginTop: 6 }}>
                <Link className="link" to="/settings">
                  Configure a backend in Settings →
                </Link>
              </div>
            )}
            <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
              <button
                className="btn sm"
                type="button"
                data-testid="composer-retry"
                onClick={() => {
                  composer.retry();
                }}
              >
                Retry
              </button>
              <button
                className="btn sm"
                type="button"
                onClick={() => {
                  composer.resetError();
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
