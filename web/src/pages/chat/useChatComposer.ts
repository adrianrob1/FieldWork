import { useCallback, useRef, useState } from 'react';

import {
  failureOf,
  postStream,
  type ApiOutcome,
  type NdjsonEvent,
} from '../../shared/api.js';
import { classifySendFailure, type SendFailure } from '../../chat/store.js';
import { hasMessageText, type AttachableView } from '../draftFlow.js';
import {
  addOptimistic,
  buildComposerPayload,
  canRetrySend,
  composerSendReducer,
  emptyFailure,
  idleComposerSend,
  parseSendResponse,
  resolveOptimistic,
  textToRestoreAfterStop,
  type ComposerAttachment,
  type ComposerOptimistic,
  type ComposerSendState,
} from './chatComposer.js';
import type { ChatDetail } from './chatThread.js';
import {
  begin as beginStream,
  append as appendStream,
  fail as failStream,
  finish as finishStream,
  setCancel as setStreamCancel,
} from './streamRegistry.js';
import type { SendExchange } from './useChatThread.js';

export interface UseChatComposerOptions {
  chatId: string;
  chat: ChatDetail | null;
  reload: () => void;
  applyExchange: (result: SendExchange) => void;
  onConflict?: (() => void) | undefined;
}

export interface ChatComposerResource {
  message: string;
  setMessage: (value: string) => void;
  backend: string | null;
  setBackend: (value: string | null) => void;
  attachments: ComposerAttachment[];
  addAttachment: (attachable: AttachableView) => void;
  removeAttachment: (key: string) => void;
  optimistic: ComposerOptimistic[];
  sendState: ComposerSendState;
  sending: boolean;
  canRetry: boolean;
  // Entered when the send starts, before the first delta arrives; `startedAt`
  // anchors the "Working for …" timer. `thought` holds ephemeral reasoning
  // that renders in the collapsible Thinking row and is never committed.
  streaming: { text: string; thought: string; startedAt: number } | null;
  send: () => void;
  retry: () => void;
  stop: () => void;
  resetError: () => void;
}

let optimisticCounter = 0;

// Owns the per-turn composer state and the optimistic send lifecycle. The pure
// decisions live in chatComposer.ts; this hook is the fetch/effect wrapper.
export function useChatComposer(
  options: UseChatComposerOptions,
): ChatComposerResource {
  const { chatId, chat, reload, applyExchange, onConflict } = options;
  const [message, setMessageState] = useState('');
  const [backend, setBackendState] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [optimistic, setOptimistic] = useState<ComposerOptimistic[]>([]);
  const [sendState, setSendState] =
    useState<ComposerSendState>(idleComposerSend);
  const [streaming, setStreaming] = useState<{
    text: string;
    thought: string;
    startedAt: number;
  } | null>(null);

  const messageRef = useRef(message);
  messageRef.current = message;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const sendStateRef = useRef(sendState);
  sendStateRef.current = sendState;
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const stopRef = useRef<(() => void) | null>(null);
  const pendingTurnRef = useRef<{ optimisticId: string; text: string } | null>(
    null,
  );

  const setMessage = useCallback((value: string) => {
    setMessageState(value);
  }, []);

  const setBackend = useCallback((value: string | null) => {
    setBackendState(value);
  }, []);

  const addAttachment = useCallback((attachable: AttachableView) => {
    setAttachments((previous) => {
      if (previous.some((entry) => entry.id === attachable.id)) return previous;
      return [
        ...previous,
        {
          key: attachable.id,
          id: attachable.id,
          path: null,
          label: attachable.label,
          kind: attachable.kind,
        },
      ];
    });
  }, []);

  const removeAttachment = useCallback((key: string) => {
    setAttachments((previous) => previous.filter((entry) => entry.key !== key));
  }, []);

  const resetError = useCallback(() => {
    setSendState((previous) =>
      previous.status === 'failed' || previous.status === 'conflict'
        ? composerSendReducer(previous, { type: 'reset' })
        : previous,
    );
  }, []);

  const dispatch = useCallback(
    (action: Parameters<typeof composerSendReducer>[1]) => {
      setSendState((previous) => composerSendReducer(previous, action));
    },
    [],
  );

  const send = useCallback(() => {
    const currentChat = chatRef.current;
    if (currentChat === null) return;
    const text = messageRef.current;
    if (!hasMessageText(text)) return;
    if (sendStateRef.current.status === 'sending') return;

    const built = buildComposerPayload({
      message: text,
      backend: backendRef.current,
      contentHash: currentChat.contentHash,
      attachments: attachmentsRef.current,
    });
    if (!built.ok) {
      setSendState(
        composerSendReducer(sendStateRef.current, {
          type: 'failed',
          failure: emptyFailure('This chat has no content hash yet.'),
        }),
      );
      return;
    }

    optimisticCounter += 1;
    const optimisticId = `composer-optimistic-${String(optimisticCounter)}`;
    const sentAttachments = [...attachmentsRef.current];
    setOptimistic((previous) =>
      addOptimistic(previous, {
        id: optimisticId,
        text,
        attachments: sentAttachments,
      }),
    );
    pendingTurnRef.current = { optimisticId, text };
    dispatch({ type: 'send', payload: built.payload });
    setStreaming({ text: '', thought: '', startedAt: Date.now() });
    setMessageState('');
    // Mirror the turn into the registry so the chat page can re-attach after
    // an in-app navigation unmounts this hook while the stream keeps running.
    beginStream({
      chatId,
      title: currentChat.title,
      text,
      attachments: sentAttachments,
      draftId: null,
    });
    const restoreMessage = () => {
      if (messageRef.current.trim() === '') setMessageState(text);
    };
    const resolvePending = () => {
      pendingTurnRef.current = null;
      setOptimistic((previous) => resolveOptimistic(previous, optimisticId));
    };
    let aborted = false;

    const succeed = (data: unknown) => {
      if (aborted) return;
      finishStream(chatId, data);
      clearActive();
      const parsed = parseSendResponse(data);
      if (parsed === null) {
        resolvePending();
        restoreMessage();
        setStreaming(null);
        setSendState((previous) =>
          composerSendReducer(previous, {
            type: 'failed',
            failure: emptyFailure('The send response was unreadable.'),
          }),
        );
        return;
      }
      applyExchange({
        contentHash: parsed.contentHash,
        exchange: parsed.exchange,
      });
      resolvePending();
      setAttachments([]);
      setStreaming(null);
      setSendState((previous) =>
        composerSendReducer(previous, { type: 'applied' }),
      );
    };

    const failTerminal = (
      status: number,
      diagnostics: SendFailure['diagnostics'],
      errorText: string | null,
    ) => {
      if (aborted) return;
      failStream(chatId, { type: 'error', status, errorText, diagnostics });
      clearActive();
      resolvePending();
      restoreMessage();
      setStreaming(null);
      if (status === 409) {
        reload();
        onConflict?.();
        setSendState((previous) =>
          composerSendReducer(previous, { type: 'conflict' }),
        );
        return;
      }
      setSendState((previous) =>
        composerSendReducer(previous, {
          type: 'failed',
          failure: classifySendFailure(status, diagnostics, errorText),
        }),
      );
    };

    const clearActive = () => {
      stopRef.current = null;
    };

    const request = postStream(
      `/api/chats/${encodeURIComponent(chatId)}/messages`,
      built.payload,
      {
        event: (event: NdjsonEvent) => {
          if (aborted) return;
          if (event.type === 'delta') {
            appendStream(chatId, event.text, event.kind);
            setStreaming((previous) => {
              const current = previous ?? {
                text: '',
                thought: '',
                startedAt: Date.now(),
              };
              return event.kind === 'thought'
                ? {
                    ...current,
                    thought: `${current.thought}${event.text}`,
                  }
                : {
                    ...current,
                    text: `${current.text}${event.text}`,
                  };
            });
            return;
          }
          if (event.type === 'done') {
            succeed(event.result);
            return;
          }
          if (event.type === 'error') {
            failTerminal(event.status, event.diagnostics, event.errorText);
          }
        },
        fallbackJson: ({ status, body }) => {
          if (aborted) return;
          const outcome: ApiOutcome<unknown> =
            status >= 200 && status < 300
              ? { ok: true, data: body }
              : { ok: false, failure: failureOf(status, body) };
          if (outcome.ok) {
            succeed(outcome.data);
            return;
          }
          failTerminal(
            outcome.failure.status,
            outcome.failure.diagnostics,
            outcome.failure.errorText,
          );
        },
      },
    );
    const cancelRequest = () => {
      aborted = true;
      request.abort();
    };
    stopRef.current = cancelRequest;
    // The provisional view stops the orphaned stream through the registry once
    // this hook has unmounted.
    setStreamCancel(chatId, cancelRequest);
  }, [applyExchange, chatId, dispatch, onConflict, reload]);

  const retry = useCallback(() => {
    if (!canRetrySend(sendStateRef.current)) return;
    send();
  }, [send]);

  // Abort the in-flight stream. Nothing persisted server-side, so the pending
  // bubble is dropped, the typed text is restored, and the composer notes the
  // stop instead of showing a failure.
  const stop = useCallback(() => {
    const cancel = stopRef.current;
    if (cancel === null) return;
    stopRef.current = null;
    cancel();
    const pending = pendingTurnRef.current;
    pendingTurnRef.current = null;
    if (pending !== null) {
      setOptimistic((previous) =>
        resolveOptimistic(previous, pending.optimisticId),
      );
      const restored = textToRestoreAfterStop(messageRef.current, pending.text);
      if (restored !== null) setMessageState(restored);
    }
    setStreaming(null);
    setSendState((previous) =>
      composerSendReducer(previous, { type: 'stopped' }),
    );
  }, []);

  return {
    message,
    setMessage,
    backend,
    setBackend,
    attachments,
    addAttachment,
    removeAttachment,
    optimistic,
    sendState,
    sending: sendState.status === 'sending',
    canRetry: canRetrySend(sendState),
    streaming,
    send,
    retry,
    stop,
    resetError,
  };
}
