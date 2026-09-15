import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { postJson } from '../../shared/api.js';
import { setTitle, type OptionItem } from '../../shared/controls/index.js';
import { Link, navigate } from '../../shared/router.js';
import { withExpectedHash } from '../../chat/store.js';
import { draftRoute, mobileDraftMediaQuery } from '../chats/chatListModel.js';
import { PagePlaceholder } from '../stub.js';
import { AttachmentSlideOver } from './AttachmentSlideOver.js';
import { ChatComposer } from './ChatComposerDock.js';
import { ChatStickyBar } from './ChatStickyBar.js';
import { ChatThread } from './ChatThreadView.js';
import {
  initialWindowState,
  parseChatDetail,
  type ChatDetail,
} from './chatThread.js';
import { parseContentHashResponse } from './chatComposer.js';
import {
  clear as clearStream,
  get as getStream,
  subscribe as subscribeStream,
  text as streamText,
  thought as streamThought,
  type StreamEntry,
} from './streamRegistry.js';
import { useAttachmentEditor } from './useAttachmentEditor.js';
import { useChatComposer } from './useChatComposer.js';
import { useChatThread } from './useChatThread.js';

// A minimal detail for the provisional turn handed off by the new-chat screen.
// Project chips and metadata stay empty until the real transcript loads.
export function provisionalChat(id: string, title: string): ChatDetail {
  return {
    id,
    title,
    created: null,
    updated: null,
    projects: [],
    topics: [],
    provider: null,
    model: null,
    links: [],
    path: '',
    contentHash: null,
    messages: [],
    hasEarlier: false,
    earlierCursor: null,
  };
}

export interface ChatConversationProps {
  chatId: string;
  projects: readonly OptionItem[];
  onTitleChange?: ((title: string | null) => void) | undefined;
}

// The per-chat conversation: header, thread, sticky bar, composer, provisional
// stream handling, slide-over, and the mutations. The page-level shell keys this
// by chat id, so switching chats remounts only this subtree while the list pane
// and app chrome stay put.
export function ChatConversation({
  chatId,
  projects: projectOptions,
  onTitleChange,
}: ChatConversationProps) {
  const [stream, setStream] = useState<StreamEntry | null>(() =>
    getStream(chatId),
  );
  const streamingLive = stream !== null && stream.done === null;
  const resource = useChatThread(chatId, streamingLive);
  const editor = useAttachmentEditor();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const headerSentinelRef = useRef<HTMLElement | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const chat = resource.chat;
  const chatTitle = chat?.title ?? null;
  const titleKey = `chat:${chatId}`;
  const { updateChat, reload } = resource;

  const composer = useChatComposer({
    chatId,
    chat,
    reload,
    applyExchange: resource.applyExchange,
    onConflict: () => {
      setNotice(
        'The chat changed while you were sending. The transcript was reloaded.',
      );
    },
  });

  // Follow a streaming handoff from the new-chat screen or the composer. While
  // the entry is live the initial GET is paused; once `done` lands the entry is
  // consumed and the normal load runs underneath the provisional view until it
  // is ready.
  useEffect(() => {
    const current = getStream(chatId);
    if (current === null) {
      setStream(null);
      return;
    }
    // A composer-owned turn that failed while away left nothing server-side:
    // drop the entry, hand the text back to the fresh composer, and let the
    // transcript load normally.
    if (current.error !== null && current.draftId === null) {
      clearStream(chatId);
      setStream(null);
      composer.setMessage(current.text);
      setNotice(current.error.errorText ?? 'The backend could not answer.');
      return;
    }
    setStream(current);
    if (current.done !== null) {
      clearStream(chatId);
      return;
    }
    return subscribeStream(chatId, () => {
      const next = getStream(chatId);
      if (next === null) return;
      if (next.error !== null && next.draftId === null) {
        clearStream(chatId);
        setStream(null);
        composer.setMessage(next.text);
        setNotice(next.error.errorText ?? 'The backend could not answer.');
        return;
      }
      if (next.done !== null) clearStream(chatId);
      setStream({ ...next });
    });
  }, [chatId]);

  useEffect(() => {
    if (chatTitle !== null) setTitle(titleKey, chatTitle);
  }, [titleKey, chatTitle]);

  useEffect(() => {
    onTitleChange?.(chatTitle);
  }, [chatTitle, onTitleChange]);

  const toggleProject = useCallback(
    (projectId: string) => {
      if (chat === null) return;
      const attached = chat.projects.includes(projectId);
      const built = withExpectedHash({ projectId }, chat.contentHash);
      if (!built.ok) {
        setNotice('This chat has no content hash yet.');
        return;
      }
      const route = attached
        ? `/api/chats/${encodeURIComponent(chatId)}/detach`
        : `/api/chats/${encodeURIComponent(chatId)}/attach`;
      void postJson<unknown>(route, built.payload).then((outcome) => {
        if (outcome.ok) {
          const detail = parseChatDetail(outcome.data);
          if (detail === null) {
            setNotice(
              'The project change went through but its response was unreadable.',
            );
            return;
          }
          updateChat({
            title: detail.title,
            projects: detail.projects,
            contentHash: detail.contentHash,
            updated: detail.updated,
          });
          setNotice(null);
          return;
        }
        if (outcome.failure.status === 409) {
          reload();
          setNotice(
            'The chat changed while you were editing it. The transcript was reloaded.',
          );
          return;
        }
        setNotice(
          outcome.failure.errorText ?? 'The project change could not be saved.',
        );
      });
    },
    [chat, chatId, reload, updateChat],
  );

  const commitTitle = useCallback(
    async (nextTitle: string) => {
      if (chat === null) throw new Error('chat-unavailable');
      const built = withExpectedHash(
        { path: chat.path, changes: { title: nextTitle } },
        chat.contentHash,
      );
      if (!built.ok) {
        setNotice('This chat has no content hash yet.');
        throw new Error('missing-hash');
      }
      const outcome = await postJson<unknown>(
        '/api/edit/frontmatter',
        built.payload,
      );
      if (outcome.ok) {
        const hash = parseContentHashResponse(outcome.data);
        updateChat({ title: nextTitle, contentHash: hash ?? chat.contentHash });
        setNotice(null);
        return;
      }
      if (outcome.failure.status === 409) {
        reload();
        setNotice(
          'The title changed elsewhere. The chat was reloaded with the current title.',
        );
        throw new Error('title-conflict');
      }
      setNotice(outcome.failure.errorText ?? 'The title could not be saved.');
      throw new Error('title-failed');
    },
    [chat, reload, updateChat],
  );

  // Stop a still-streaming draft submit or composer send from its provisional
  // chat view: abort the transport, drop the registry entry, and restore what
  // can be restored. A draft submit returns to the untouched draft on the start
  // screen (the server never created the chat file); a composer send gets its
  // text back in the fresh composer. Either way nothing persists server-side.
  const stopProvisional = useCallback(() => {
    if (stream === null) return;
    const { cancel, draftId } = stream;
    clearStream(chatId);
    setStream(null);
    cancel?.();
    if (draftId === null) composer.setMessage(stream.text);
    if (draftId !== null) {
      const mobile =
        typeof window !== 'undefined' &&
        window.matchMedia(mobileDraftMediaQuery).matches;
      navigate(draftRoute(draftId, mobile));
    }
  }, [chatId, stream]);

  const provisional = stream !== null && resource.status === 'loading';

  const stickyBar: ReactNode =
    chat === null ? null : (
      <ChatStickyBar
        chat={chat}
        projects={projectOptions}
        sentinelRef={headerSentinelRef}
        rootRef={scrollRef}
        onToggleProject={toggleProject}
        onCommitTitle={commitTitle}
        disabled={composer.sending}
      />
    );

  const composerDock: ReactNode =
    chat === null ? null : (
      <ChatComposer composer={composer} chat={chat} scrollRef={scrollRef} />
    );

  return (
    <>
      {resource.status === 'loading' && !provisional && (
        <PagePlaceholder
          glyph="◔"
          heading="Loading chat…"
          body="Reading the transcript from the workspace."
        />
      )}
      {resource.status === 'not-found' && (
        <PagePlaceholder
          glyph="◌"
          heading="Chat not found"
          body="This chat no longer exists in the workspace."
          actions={
            <Link className="btn primary sm" to="/chats">
              Back to chats
            </Link>
          }
        />
      )}
      {resource.status === 'error' && (
        <PagePlaceholder
          glyph="◌"
          heading="Chat unavailable"
          body={
            resource.failure?.errorText ?? 'The transcript could not be loaded.'
          }
          actions={
            <button
              className="btn primary sm"
              type="button"
              onClick={resource.reload}
            >
              Retry
            </button>
          }
        />
      )}
      {provisional && stream !== null && (
        <>
          <ChatThread
            chat={provisionalChat(chatId, stream.title)}
            thread={initialWindowState()}
            loadingEarlier={false}
            projects={[]}
            optimistic={[
              {
                id: 'stream-user',
                text: stream.text,
                attachments: stream.attachments,
              },
            ]}
            streaming={
              stream.error === null
                ? {
                    text: streamText(stream),
                    thought: streamThought(stream),
                    startedAt: stream.startedAt,
                  }
                : null
            }
            showEmptyNote={false}
            notice={null}
            sentinelRef={headerSentinelRef}
            scrollRef={scrollRef}
            onLoadEarlier={() => undefined}
            onOpenAttachment={editor.openAttachment}
            onToggleProject={() => undefined}
            onCommitTitle={() => Promise.resolve()}
            disabled
          />
          {stream.error === null && stream.done === null && (
            <div className="chatfoot" data-testid="provisional-dock">
              <div className="cwrap">
                <div className="cfoot">
                  <span className="grow" />
                  <button
                    className="btn sm"
                    type="button"
                    data-testid="draft-stop"
                    onClick={stopProvisional}
                  >
                    Stop
                  </button>
                </div>
              </div>
            </div>
          )}
          {stream.error !== null && (
            <div className="chatfoot" data-testid="stream-error-dock">
              <div className="cwrap">
                <div
                  className="note"
                  data-testid="chat-stream-error"
                  style={{ borderLeftColor: 'var(--danger)' }}
                >
                  <b>The backend could not answer.</b>{' '}
                  {stream.error.errorText ?? 'The chat could not be started.'}
                  {stream.error.diagnostics.length > 0 && (
                    <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                      {stream.error.diagnostics.map((entry) => (
                        <li key={`${entry.code}:${entry.message}`}>
                          {entry.message}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div style={{ marginTop: 10 }}>
                    {stream.draftId !== null && (
                      <Link
                        className="btn sm"
                        to={`/chats/new?draft=${stream.draftId}`}
                      >
                        Back to draft
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
      {resource.status === 'ready' && chat !== null && (
        <>
          {stickyBar}
          <ChatThread
            chat={chat}
            thread={resource.thread}
            loadingEarlier={resource.loadingEarlier}
            projects={projectOptions}
            optimistic={composer.optimistic}
            streaming={composer.streaming}
            notice={notice}
            sentinelRef={headerSentinelRef}
            scrollRef={scrollRef}
            onLoadEarlier={resource.loadEarlier}
            onOpenAttachment={editor.openAttachment}
            onToggleProject={toggleProject}
            onCommitTitle={commitTitle}
            disabled={composer.sending}
          />
          {composerDock}
        </>
      )}
      <AttachmentSlideOver editor={editor} />
    </>
  );
}
