import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type { OptionItem } from '../../shared/controls/index.js';
import {
  captureScrollAnchor,
  scrollTopAfterPrepend,
  stickAfterAppend,
  streamBubbleMaxHeight,
  threadAppendSnapshot,
  THREAD_STICK_TOLERANCE,
  attachmentBadge,
  type AttachmentView,
  type ChatDetail,
  type ScrollAnchor,
  type ThreadState,
} from './chatThread.js';
import { atBottom } from './chatComposer.js';
import type { ComposerOptimistic } from './chatComposer.js';
import { ChatHeader } from './ChatHeader.js';
import { ChatMessageBlock } from './ChatMessageBlock.js';
import { ThoughtTrace } from './ThoughtTrace.js';
import { WorkingTimer } from './WorkingTimer.js';

export interface ChatThreadProps {
  chat: ChatDetail;
  thread: ThreadState;
  loadingEarlier: boolean;
  projects: readonly OptionItem[];
  optimistic: readonly ComposerOptimistic[];
  streaming?: {
    text: string;
    thought?: string;
    startedAt?: number | undefined;
  } | null;
  showEmptyNote?: boolean;
  notice: string | null;
  sentinelRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onLoadEarlier: () => void;
  onOpenAttachment: (attachment: AttachmentView) => void;
  onToggleProject: (projectId: string) => void;
  onCommitTitle: (title: string) => Promise<void>;
  disabled?: boolean | undefined;
}

export function ChatThread({
  chat,
  thread,
  loadingEarlier,
  projects,
  optimistic,
  streaming = null,
  showEmptyNote = true,
  notice,
  sentinelRef,
  scrollRef,
  onLoadEarlier,
  onOpenAttachment,
  onToggleProject,
  onCommitTitle,
  disabled = false,
}: ChatThreadProps) {
  const initialScrolled = useRef(false);
  const pendingAnchor = useRef<ScrollAnchor | null>(null);
  const atBottomRef = useRef(true);
  const lastScrollHeightRef = useRef<number | null>(null);
  const streamBubbleRef = useRef<HTMLDivElement | null>(null);
  const streamInnerRef = useRef<HTMLDivElement | null>(null);
  const [streamCap, setStreamCap] = useState<number | null>(null);
  const streamingActive = streaming !== null;
  const streamLength =
    (streaming?.text.length ?? 0) + (streaming?.thought?.length ?? 0);
  const previousSnapshot = useRef<ReturnType<
    typeof threadAppendSnapshot
  > | null>(null);
  const previousOptimisticCount = useRef(0);

  const attachmentStarts = useMemo(() => {
    const starts: number[] = [];
    let running = 0;
    for (const message of thread.messages) {
      starts.push(running);
      running += message.attachments.length;
    }
    return starts;
  }, [thread.messages]);

  // First paint of a loaded transcript lands at the newest turn, unanimated.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null || initialScrolled.current) return;
    if (thread.messages.length === 0) return;
    initialScrolled.current = true;
    element.scrollTop = element.scrollHeight;
  }, [thread.messages.length, scrollRef]);

  // After older turns are prepended, restore the anchored viewport.
  useLayoutEffect(() => {
    const anchor = pendingAnchor.current;
    const element = scrollRef.current;
    if (anchor === null || element === null) return;
    pendingAnchor.current = null;
    element.scrollTop = scrollTopAfterPrepend(anchor, element.scrollHeight);
  }, [thread.messages.length, thread.oldestLoadedIndex, scrollRef]);

  // Track "at bottom" as the user scrolls. Because content growth does not fire
  // a scroll event, this ref keeps the pre-growth reading the stick effect
  // needs; programmatic scrolls update it via the same handler.
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const onScroll = () => {
      atBottomRef.current = atBottom(
        {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        },
        THREAD_STICK_TOLERANCE,
      );
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      element.removeEventListener('scroll', onScroll);
    };
  }, [scrollRef]);

  // Stick to the newest content when it appends and the reader was at bottom,
  // and always when the reader just sent their own message. Prepends are left
  // alone so the Load-earlier anchor math above stays authoritative.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    const streamLength =
      (streaming?.text.length ?? 0) + (streaming?.thought?.length ?? 0);
    const next = threadAppendSnapshot(thread.messages, streamLength);
    const previous = previousSnapshot.current;
    const justSent = optimistic.length > previousOptimisticCount.current;
    previousOptimisticCount.current = optimistic.length;
    // The scroll event that follows a user scroll is async and can be delayed
    // past the next delta, leaving `atBottomRef` stale. Compare the live
    // scrollTop (which updates synchronously) against the scrollHeight recorded
    // before this render grew the thread, so a reader who scrolled up is never
    // yanked back to the bottom.
    const previousHeight = lastScrollHeightRef.current;
    const wasAtBottom =
      previousHeight === null
        ? atBottomRef.current
        : element.scrollTop + element.clientHeight >=
          previousHeight - THREAD_STICK_TOLERANCE;
    if (
      previous !== null &&
      stickAfterAppend(previous, next, wasAtBottom, justSent)
    ) {
      element.scrollTop = element.scrollHeight;
      atBottomRef.current = true;
    }
    lastScrollHeightRef.current = element.scrollHeight;
    previousSnapshot.current = next;
  }, [
    thread.messages,
    thread.oldestLoadedIndex,
    streaming,
    optimistic,
    scrollRef,
  ]);

  const handleLoadEarlier = useCallback(() => {
    const element = scrollRef.current;
    if (element !== null) pendingAnchor.current = captureScrollAnchor(element);
    onLoadEarlier();
  }, [onLoadEarlier, scrollRef]);

  // Cap the streaming bubble to the thread viewport (minus its own header) and
  // recompute when the viewport resizes.
  useLayoutEffect(() => {
    if (!streamingActive) {
      setStreamCap(null);
      return;
    }
    const scroller = scrollRef.current;
    const bubble = streamBubbleRef.current;
    if (scroller === null || bubble === null) return;
    const compute = () => {
      const header = bubble.querySelector('.mh');
      const headerHeight =
        header instanceof HTMLElement ? header.offsetHeight : 0;
      setStreamCap(streamBubbleMaxHeight(scroller.clientHeight, headerHeight));
    };
    compute();
    const observer = new ResizeObserver(compute);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [streamingActive, scrollRef]);

  // While the reader is pinned to the newest turn, the capped bubble's inner
  // scroller follows its own growth so the freshest thinking/text stays visible.
  useLayoutEffect(() => {
    const inner = streamInnerRef.current;
    if (inner === null || !atBottomRef.current) return;
    inner.scrollTop = inner.scrollHeight;
  }, [streamLength, streamCap]);

  return (
    <div
      className="chatscroll"
      data-testid="chat-thread-scroll"
      ref={scrollRef}
    >
      <div className="sheet">
        <ChatHeader
          chat={chat}
          projects={projects}
          sentinelRef={sentinelRef}
          onToggleProject={onToggleProject}
          onCommitTitle={onCommitTitle}
          disabled={disabled}
        />
        {notice !== null && (
          <div
            className="note"
            data-testid="chat-notice"
            style={{ borderLeftColor: 'var(--warn)', marginBottom: 18 }}
          >
            {notice}
          </div>
        )}
        <div className="thread rise" data-testid="chat-thread">
          {thread.hasEarlier && (
            <div className="winnote">
              <span className="chip">windowed view</span>
              <span>
                showing the latest {thread.messages.length} messages. Older
                turns stay on disk
              </span>
              <button
                className="link"
                type="button"
                data-testid="load-earlier"
                disabled={loadingEarlier}
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: 0,
                  cursor: loadingEarlier ? 'default' : 'pointer',
                  font: 'inherit',
                }}
                onClick={handleLoadEarlier}
              >
                {loadingEarlier ? 'Loading earlier…' : 'Load earlier ↑'}
              </button>
            </div>
          )}
          {thread.messages.length === 0 && showEmptyNote && (
            <p className="stub-note">No messages yet.</p>
          )}
          {thread.messages.map((message, offset) => (
            <ChatMessageBlock
              key={message.index}
              message={message}
              attachmentStart={attachmentStarts[offset] ?? 0}
              onOpenAttachment={onOpenAttachment}
            />
          ))}
          {optimistic.map((entry) => (
            <div
              className="msg user pending"
              key={entry.id}
              data-testid="msg-pending"
            >
              <div className="mh">
                <span className="from">You</span>
                <span className="chip">sending…</span>
              </div>
              <div className="mc">
                <p>{entry.text}</p>
                {entry.attachments.map((attachment, offset) => (
                  <span
                    className="att pending"
                    key={attachment.key}
                    data-testid={`pending-attachment-chip-${String(offset)}`}
                    aria-disabled="true"
                  >
                    <span className="ext">
                      {attachmentBadge(attachment.kind)}
                    </span>
                    <span>
                      <b>{attachment.label}</b>
                      {attachment.id === null ? '' : ` · ${attachment.id}`}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          ))}
          {streaming !== null && (
            <div
              className="msg model pending"
              data-testid="stream-bubble"
              ref={streamBubbleRef}
            >
              <div className="mh">
                <span className="from acc">Assistant</span>
                <WorkingTimer startedAt={streaming.startedAt} />
              </div>
              <div
                className="mc"
                data-testid="stream-bubble-content"
                ref={streamInnerRef}
                style={
                  streamCap === null
                    ? undefined
                    : { maxHeight: `${String(streamCap)}px`, overflowY: 'auto' }
                }
              >
                {(streaming.thought ?? '') !== '' && (
                  <ThoughtTrace
                    text={streaming.thought ?? ''}
                    defaultExpanded={true}
                    testId="stream-thought"
                  />
                )}
                {streaming.text !== '' && (
                  <p
                    data-testid="stream-message"
                    style={{ whiteSpace: 'pre-wrap' }}
                  >
                    {streaming.text}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
