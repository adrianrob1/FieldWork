import { useCallback, useEffect, useRef, useState } from 'react';

import { getJson, type ApiFailure } from '../../shared/api.js';
import type { ChatMessageView } from '../../shared/types.js';
import {
  chatWindowRoute,
  initialWindowState,
  parseChatDetail,
  reduceInitialLoad,
  reducePrepend,
  toChatMessage,
  type ChatDetail,
  type ThreadState,
} from './chatThread.js';

export type ThreadLoadStatus = 'loading' | 'ready' | 'not-found' | 'error';

interface ThreadDoc {
  status: ThreadLoadStatus;
  failure: ApiFailure | null;
  chat: ChatDetail | null;
  thread: ThreadState;
}

export interface SendExchange {
  contentHash: string | null;
  exchange: { user: ChatMessageView; assistant: ChatMessageView };
}

export interface ChatThreadResource {
  status: ThreadLoadStatus;
  failure: ApiFailure | null;
  chat: ChatDetail | null;
  thread: ThreadState;
  loadingEarlier: boolean;
  loadEarlier: () => void;
  reload: () => void;
  // Merge field updates (title, projects, contentHash) from a mutation
  // response without refetching the transcript.
  updateChat: (patch: Partial<ChatDetail>) => void;
  // Append a committed exchange to the loaded window and adopt its hash.
  applyExchange: (result: SendExchange) => void;
}

function loadingDoc(): ThreadDoc {
  return {
    status: 'loading',
    failure: null,
    chat: null,
    thread: initialWindowState(),
  };
}

function unreadableFailure(): ApiFailure {
  return {
    status: 0,
    errorText: 'The transcript response was unreadable.',
    diagnostics: [],
    currentHash: null,
    body: null,
  };
}

// Owns the windowed transcript: the newest window on mount, prepend windows on
// demand, and the reload used by the failure state. Scroll anchoring stays in
// the component because it needs the live scroll container. `paused` defers the
// initial load while a streaming handoff owns the route.
export function useChatThread(
  chatId: string,
  paused = false,
): ChatThreadResource {
  const [doc, setDoc] = useState<ThreadDoc>(loadingDoc);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [nonce, setNonce] = useState(0);

  const docRef = useRef(doc);
  docRef.current = doc;
  const loadingEarlierRef = useRef(false);
  const requestRef = useRef(0);

  useEffect(() => {
    if (paused) return;
    let active = true;
    requestRef.current += 1;
    loadingEarlierRef.current = false;
    setLoadingEarlier(false);
    setDoc(loadingDoc());
    void getJson<unknown>(chatWindowRoute(chatId, null)).then((outcome) => {
      if (!active) return;
      if (!outcome.ok) {
        setDoc({
          status: outcome.failure.status === 404 ? 'not-found' : 'error',
          failure: outcome.failure,
          chat: null,
          thread: initialWindowState(),
        });
        return;
      }
      const detail = parseChatDetail(outcome.data);
      if (detail === null) {
        setDoc({
          status: 'error',
          failure: unreadableFailure(),
          chat: null,
          thread: initialWindowState(),
        });
        return;
      }
      setDoc({
        status: 'ready',
        failure: null,
        chat: detail,
        thread: reduceInitialLoad(detail),
      });
    });
    return () => {
      active = false;
    };
  }, [chatId, nonce, paused]);

  const loadEarlier = useCallback(() => {
    const current = docRef.current;
    if (
      current.status !== 'ready' ||
      !current.thread.hasEarlier ||
      current.thread.earlierCursor === null ||
      loadingEarlierRef.current
    ) {
      return;
    }
    const cursor = current.thread.earlierCursor;
    const token = requestRef.current;
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    void getJson<unknown>(chatWindowRoute(chatId, cursor)).then((outcome) => {
      if (token !== requestRef.current) return;
      loadingEarlierRef.current = false;
      setLoadingEarlier(false);
      if (!outcome.ok) return;
      const detail = parseChatDetail(outcome.data);
      if (detail === null) return;
      setDoc((previous) =>
        previous.status === 'ready'
          ? {
              ...previous,
              chat: detail,
              thread: reducePrepend(previous.thread, detail),
            }
          : previous,
      );
    });
  }, [chatId]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  const updateChat = useCallback((patch: Partial<ChatDetail>) => {
    setDoc((previous) =>
      previous.status === 'ready' && previous.chat !== null
        ? { ...previous, chat: { ...previous.chat, ...patch } }
        : previous,
    );
  }, []);

  const applyExchange = useCallback((result: SendExchange) => {
    setDoc((previous) => {
      if (previous.status !== 'ready' || previous.chat === null)
        return previous;
      const last =
        previous.thread.messages[previous.thread.messages.length - 1];
      const base = last === undefined ? 0 : last.index + 1;
      const user = toChatMessage(result.exchange.user, base);
      const assistant = toChatMessage(result.exchange.assistant, base + 1);
      return {
        ...previous,
        chat: { ...previous.chat, contentHash: result.contentHash },
        thread: {
          ...previous.thread,
          messages: [...previous.thread.messages, user, assistant],
        },
      };
    });
  }, []);

  return {
    status: doc.status,
    failure: doc.failure,
    chat: doc.chat,
    thread: doc.thread,
    loadingEarlier,
    loadEarlier,
    reload,
    updateChat,
    applyExchange,
  };
}
