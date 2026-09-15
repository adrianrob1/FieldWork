import { useCallback, useEffect, useRef, useState } from 'react';

import {
  failureOf,
  getJson,
  postJson,
  postStream,
  type ApiFailure,
  type ApiOutcome,
  type GetJsonOptions,
  type StreamRequest,
} from '../shared/api.js';
import { errorTextOf } from '../shared/responses.js';
import { navigate } from '../shared/router.js';
import type { DiagnosticView } from '../shared/types.js';
import {
  begin as beginStream,
  append as appendStream,
  fail as failStream,
  finish as finishStream,
  setCancel as setStreamCancel,
} from './chat/streamRegistry.js';
import {
  addStagedAttachment,
  buildDraftPatch,
  chatIdOfSubmit,
  createPayloadOf,
  emptyDraftFields,
  fieldsFromRecord,
  fieldsOf,
  hasDraftContent,
  hasMessageText,
  idleSubmit,
  isEmptyPatch,
  isRecord,
  parseAttachables,
  parseDraftList,
  parseDraftView,
  pendingDraftSave,
  pickReusableDraft,
  resumeDecision,
  submitFailed,
  submitStarted,
  submitSucceeded,
  updatePayloadOf,
  type AttachableView,
  type DraftEntry,
  type DraftFields,
  type DraftPatch,
  type DraftView,
  type PendingDraftSave,
  type StagedAttachment,
  type SubmitState,
} from './draftFlow.js';

export interface DraftFetchers {
  listDrafts: (options?: GetJsonOptions) => Promise<ApiOutcome<unknown>>;
  getDraft: (
    id: string,
    options?: GetJsonOptions,
  ) => Promise<ApiOutcome<unknown>>;
  getAttachables: () => Promise<ApiOutcome<unknown>>;
  createDraft: (payload: unknown) => Promise<ApiOutcome<unknown>>;
  updateDraft: (id: string, payload: unknown) => Promise<ApiOutcome<unknown>>;
  submitDraft: (id: string, payload: unknown) => Promise<ApiOutcome<unknown>>;
}

const defaultFetchers: DraftFetchers = {
  listDrafts: (options) => getJson('/api/drafts', options),
  getDraft: (id, options) =>
    getJson(`/api/drafts/${encodeURIComponent(id)}`, options),
  getAttachables: () =>
    getJson(
      '/api/attachables?kinds=task,resource,summary,chat,project&limit=200',
    ),
  createDraft: (payload) => postJson('/api/drafts', payload),
  updateDraft: (id, payload) =>
    postJson(`/api/drafts/${encodeURIComponent(id)}/update`, payload),
  submitDraft: (id, payload) =>
    postJson(`/api/drafts/${encodeURIComponent(id)}/submit`, payload),
};

export type DraftLoadStatus = 'loading' | 'ready' | 'not-found' | 'error';

interface DocState {
  status: DraftLoadStatus;
  failure: ApiFailure | null;
  draftId: string | null;
  contentHash: string | null;
  message: string;
  projects: string[];
  backend: string | null;
  attachments: StagedAttachment[];
  saving: boolean;
  saveError: string | null;
}

export interface StoredDraft {
  status: DraftLoadStatus;
  failure: ApiFailure | null;
  draftId: string | null;
  message: string;
  projects: string[];
  backend: string | null;
  attachments: StagedAttachment[];
  saving: boolean;
  saveError: string | null;
  submitState: SubmitState;
  setMessage: (value: string) => void;
  setProjects: (value: string[]) => void;
  setBackend: (value: string | null) => void;
  addAttachment: (attachable: AttachableView) => void;
  removeAttachment: (key: string) => void;
  retryLoad: () => void;
  startFresh: () => void;
  submit: () => void;
  stopSubmit: () => void;
}

export interface UseStoredDraftOptions {
  paramDraftId: string | null;
  onSubmitted: (chatId: string) => void;
  // The route the hook route-replaces to when it resumes or lazily creates a
  // draft. Defaults to the dedicated /chats/new page, but the embedded panel on
  // /chats passes its own base so the query lands on the two-pane route.
  basePath?: string | undefined;
  fetchers?: Partial<DraftFetchers> | undefined;
}

const saveDebounceMs = 400;

// A stored draft id is always `draft_` plus twelve lowercase hex digits; a
// query param that does not match is treated as a missing draft.
const draftIdPattern = /^draft_[0-9a-f]{12}$/;

type DraftSubmission =
  | { kind: 'done'; result: unknown; created: boolean }
  | {
      kind: 'error';
      status: number;
      errorText: string | null;
      diagnostics: DiagnosticView[];
    }
  | { kind: 'fallback'; status: number; body: unknown };

// Drives one streaming submit attempt. The `created` event immediately moves
// the user to the chat route and seeds the registry; deltas, done, and error
// are mirrored there so the chat page can render the provisional turn even
// after this hook's component has unmounted. The promise resolves with the
// terminal outcome so the caller can reuse the existing 409-retry path.
function runDraftSubmit(
  id: string,
  expectedHash: string,
  userText: string,
  attachments: StagedAttachment[],
  onRequest: (request: StreamRequest) => void,
): Promise<DraftSubmission> {
  return new Promise((resolve) => {
    let settled = false;
    let createdChatId: string | null = null;
    let request: StreamRequest | null = null;
    const settle = (value: DraftSubmission): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request = postStream(
      `/api/drafts/${encodeURIComponent(id)}/submit`,
      { expectedHash },
      {
        event: (event) => {
          if (event.type === 'created') {
            const chat = createdChatOf(event.chat);
            if (chat === null) return;
            createdChatId = chat.chatId;
            beginStream({
              chatId: chat.chatId,
              title: chat.title,
              text: userText,
              attachments,
              draftId: id,
            });
            if (request !== null) {
              const abort = request.abort;
              setStreamCancel(chat.chatId, () => {
                abort();
              });
            }
            navigate(`/chats/${encodeURIComponent(chat.chatId)}`);
            return;
          }
          if (event.type === 'delta') {
            if (createdChatId !== null) {
              appendStream(createdChatId, event.text, event.kind);
            }
            return;
          }
          if (event.type === 'done') {
            if (createdChatId !== null) {
              finishStream(createdChatId, event.result);
            }
            settle({
              kind: 'done',
              result: event.result,
              created: createdChatId !== null,
            });
            return;
          }
          if (event.type === 'error') {
            if (createdChatId !== null) failStream(createdChatId, event);
            settle({
              kind: 'error',
              status: event.status,
              errorText: event.errorText,
              diagnostics: event.diagnostics,
            });
          }
        },
        fallbackJson: (fallback) => {
          settle({
            kind: 'fallback',
            status: fallback.status,
            body: fallback.body,
          });
        },
      },
    );
    onRequest(request);
  });
}

function createdChatOf(
  value: unknown,
): { chatId: string; title: string } | null {
  if (!isRecord(value)) return null;
  const chatId = typeof value.chatId === 'string' ? value.chatId : null;
  if (chatId === null) return null;
  return {
    chatId,
    title: typeof value.title === 'string' ? value.title : '',
  };
}

function readyDoc(
  draftId: string | null,
  contentHash: string | null,
  fields: DraftFields,
  status: DraftLoadStatus = 'ready',
): DocState {
  return {
    status,
    failure: null,
    draftId,
    contentHash,
    message: fields.message,
    projects: [...fields.projects],
    backend: fields.backend,
    attachments: [...fields.attachments],
    saving: false,
    saveError: null,
  };
}

// Owns the create-on-first-edit, debounced update, conflict-refresh, and submit
// lifecycle for one stored draft. The pure decisions live in draftFlow.ts; this
// hook is the thin fetch/effect wrapper.
export function useStoredDraft(options: UseStoredDraftOptions): StoredDraft {
  const fetchersRef = useRef<DraftFetchers>({
    ...defaultFetchers,
    ...options.fetchers,
  });
  const onSubmittedRef = useRef(options.onSubmitted);
  onSubmittedRef.current = options.onSubmitted;
  const basePath = options.basePath ?? '/chats/new';

  const [doc, setDocState] = useState<DocState>(() =>
    readyDoc(null, null, emptyDraftFields(), 'loading'),
  );
  const [submitState, setSubmitState] = useState<SubmitState>(idleSubmit);
  const [loadNonce, setLoadNonce] = useState(0);

  const docRef = useRef(doc);
  const submitRef = useRef(submitState);
  const attachablesRef = useRef<AttachableView[]>([]);
  const syncedRef = useRef<{ hash: string | null; fields: DraftFields }>({
    hash: null,
    fields: emptyDraftFields(),
  });
  const creatingRef = useRef(false);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const saveWaitersRef = useRef<Array<() => void>>([]);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<PendingDraftSave | null>(null);
  const freshIntentRef = useRef(false);
  const submitRequestRef = useRef<StreamRequest | null>(null);
  const submitAbortedRef = useRef(false);
  const draftsRef = useRef<DraftEntry[]>([]);
  const recoveryRef = useRef(false);

  const commit = useCallback((next: DocState) => {
    docRef.current = next;
    setDocState(next);
  }, []);

  const update = useCallback(
    (change: (previous: DocState) => DocState) => {
      commit(change(docRef.current));
    },
    [commit],
  );

  const setSubmit = useCallback((next: SubmitState) => {
    submitRef.current = next;
    setSubmitState(next);
  }, []);

  const currentFields = useCallback((): DraftFields => {
    const state = docRef.current;
    return fieldsOf({
      message: state.message,
      projects: state.projects,
      backend: state.backend,
      attachments: state.attachments,
    });
  }, []);

  // Refetch the draft and its hash after a 409, merging server state with the
  // locally authoritative message text.
  const refreshFromServer = useCallback(async (): Promise<string | null> => {
    const id = docRef.current.draftId;
    if (id === null) return null;
    // A conflict refresh must see the server's current bytes, not a cached
    // copy of the draft from before the competing write.
    const [detail, list] = await Promise.all([
      fetchersRef.current.getDraft(id, { bypassCache: true }),
      fetchersRef.current.listDrafts({ bypassCache: true }),
    ]);
    const detailView: DraftView | null = detail.ok
      ? parseDraftView(detail.data)
      : null;
    const entry: DraftEntry | undefined = list.ok
      ? parseDraftList(list.data).find((item) => item.draft.id === id)
      : undefined;
    const record = detailView?.draft ?? entry?.draft ?? null;
    const hash = entry?.contentHash ?? detailView?.contentHash ?? null;
    if (record === null || hash === null) return null;
    const serverFields = fieldsFromRecord(record, attachablesRef.current);
    const localMessage = docRef.current.message;
    syncedRef.current = { hash, fields: serverFields };
    update((previous) => ({
      ...previous,
      status: 'ready',
      contentHash: hash,
      message: localMessage,
      projects: serverFields.projects,
      backend: serverFields.backend,
      attachments: serverFields.attachments,
    }));
    return hash;
  }, [update]);

  // A draft deleted elsewhere while this session is mounted (discard from the
  // chats list, another tab) must not strand the composer on an error screen.
  // Recreate it from the current local state once per session, reroute, and
  // let the save loop continue; a later 404 surfaces the failure.
  const recoverDraft = useCallback(async (): Promise<boolean> => {
    if (recoveryRef.current) return false;
    recoveryRef.current = true;
    const outcome = await fetchersRef.current.createDraft(
      createPayloadOf(currentFields()),
    );
    if (!outcome.ok) return false;
    const view = parseDraftView(outcome.data);
    if (view === null || view.contentHash === null) return false;
    const serverFields = fieldsFromRecord(view.draft, attachablesRef.current);
    syncedRef.current = { hash: view.contentHash, fields: serverFields };
    update((previous) => ({
      ...previous,
      status: 'ready',
      draftId: view.draft.id,
      contentHash: view.contentHash,
      saveError: null,
    }));
    navigate(`${basePath}?draft=${view.draft.id}`, { replace: true });
    return true;
  }, [basePath, currentFields, update]);

  const persistOnce = useCallback(
    async (
      draftId: string,
      hash: string | null,
      patch: DraftPatch,
    ): Promise<string | null> => {
      let expected = hash;
      if (expected === null) {
        expected = await refreshFromServer();
        if (expected === null) {
          if (await recoverDraft()) return docRef.current.contentHash;
          update((previous) => ({
            ...previous,
            saveError: 'The draft could not be saved.',
          }));
          return null;
        }
      }
      let outcome = await fetchersRef.current.updateDraft(
        draftId,
        updatePayloadOf(expected, patch),
      );
      if (!outcome.ok && outcome.failure.status === 404) {
        // The stored draft vanished mid-edit; recreate and keep saving.
        if (await recoverDraft()) return docRef.current.contentHash;
      }
      if (!outcome.ok && outcome.failure.status === 409) {
        const refreshed = await refreshFromServer();
        if (refreshed === null) {
          if (await recoverDraft()) return docRef.current.contentHash;
          update((previous) => ({
            ...previous,
            saveError: 'The draft could not be saved.',
          }));
          return null;
        }
        outcome = await fetchersRef.current.updateDraft(
          draftId,
          updatePayloadOf(refreshed, patch),
        );
        if (!outcome.ok && outcome.failure.status === 404) {
          if (await recoverDraft()) return docRef.current.contentHash;
        }
      }
      if (!outcome.ok) {
        update((previous) => ({
          ...previous,
          saveError:
            errorTextOf(outcome.failure.body) ??
            'The draft could not be saved.',
        }));
        return null;
      }
      const view = parseDraftView(outcome.data);
      if (view === null || view.contentHash === null) {
        update((previous) => ({
          ...previous,
          saveError: 'The draft was saved but its response was unreadable.',
        }));
        return null;
      }
      const serverFields = fieldsFromRecord(view.draft, attachablesRef.current);
      syncedRef.current = { hash: view.contentHash, fields: serverFields };
      update((previous) => ({
        ...previous,
        contentHash: view.contentHash,
        saveError: null,
      }));
      return view.contentHash;
    },
    [recoverDraft, refreshFromServer, update],
  );

  const releaseWaiters = useCallback(() => {
    const waiters = saveWaitersRef.current;
    saveWaitersRef.current = [];
    for (const resolve of waiters) resolve();
  }, []);

  const persist = useCallback(async (): Promise<string | null> => {
    const id = docRef.current.draftId;
    if (id === null) return null;
    if (savingRef.current) {
      pendingRef.current = true;
      return docRef.current.contentHash;
    }
    savingRef.current = true;
    update((previous) => ({ ...previous, saving: true, saveError: null }));
    let hash = docRef.current.contentHash;
    try {
      for (let guard = 0; guard < 10; guard += 1) {
        const draftId = docRef.current.draftId;
        if (draftId === null) break;
        const patch = buildDraftPatch(
          syncedRef.current.fields,
          currentFields(),
        );
        if (isEmptyPatch(patch)) break;
        hash = await persistOnce(draftId, hash, patch);
        if (hash === null) return null;
      }
      return hash;
    } finally {
      savingRef.current = false;
      update((previous) => ({ ...previous, saving: false }));
      releaseWaiters();
      if (pendingRef.current) {
        pendingRef.current = false;
        window.setTimeout(() => {
          void persist();
        }, 0);
      }
    }
  }, [currentFields, persistOnce, releaseWaiters, update]);

  const flushSaves = useCallback(async (): Promise<string | null> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    while (savingRef.current) {
      await new Promise<void>((resolve) => {
        saveWaitersRef.current.push(resolve);
      });
    }
    return persist();
  }, [persist]);

  // Fire-and-forget the pending debounced update so navigation or a page
  // unload does not drop the last keystrokes. The timer is cancelled and the
  // pending payload cleared so a flush never repeats.
  const flushPendingSave = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending === null) return;
    void fetch(`/api/drafts/${encodeURIComponent(pending.draftId)}/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        updatePayloadOf(pending.expectedHash, pending.patch),
      ),
      keepalive: true,
    }).catch(() => {});
  }, []);

  // Mount / navigation: resolve the query param, resume the most recent stored
  // draft, or start empty.
  useEffect(() => {
    const paramDraftId = options.paramDraftId;
    const current = docRef.current;
    if (
      paramDraftId !== null &&
      current.status === 'ready' &&
      current.draftId === paramDraftId
    ) {
      return;
    }
    if (paramDraftId === null && freshIntentRef.current) {
      freshIntentRef.current = false;
      recoveryRef.current = false;
      syncedRef.current = { hash: null, fields: emptyDraftFields() };
      commit(readyDoc(null, null, emptyDraftFields()));
      return;
    }
    if (paramDraftId !== null && !draftIdPattern.test(paramDraftId)) {
      commit({
        ...current,
        status: 'not-found',
        failure: null,
        saveError: null,
      });
      return;
    }
    recoveryRef.current = false;
    commit({
      ...current,
      status: 'loading',
      failure: null,
      saveError: null,
    });
    let active = true;
    void (async () => {
      const [listOutcome, attachablesOutcome] = await Promise.all([
        fetchersRef.current.listDrafts(),
        fetchersRef.current.getAttachables(),
      ]);
      if (!active) return;
      if (attachablesOutcome.ok) {
        attachablesRef.current = parseAttachables(attachablesOutcome.data);
      }
      if (!listOutcome.ok) {
        commit({
          ...docRef.current,
          status: 'error',
          failure: listOutcome.failure,
        });
        return;
      }
      const entries = parseDraftList(listOutcome.data);
      draftsRef.current = entries;
      if (paramDraftId !== null) {
        const entry = entries.find((item) => item.draft.id === paramDraftId);
        if (entry === undefined) {
          commit({ ...docRef.current, status: 'not-found' });
          return;
        }
        const fields = fieldsFromRecord(entry.draft, attachablesRef.current);
        syncedRef.current = { hash: entry.contentHash, fields };
        commit(readyDoc(entry.draft.id, entry.contentHash, fields));
        return;
      }
      const decision = resumeDecision(null, entries);
      if (decision.kind === 'resume-recent') {
        navigate(`${basePath}?draft=${decision.draftId}`, { replace: true });
        return;
      }
      syncedRef.current = { hash: null, fields: emptyDraftFields() };
      commit(readyDoc(null, null, emptyDraftFields()));
    })();
    return () => {
      active = false;
    };
  }, [options.paramDraftId, loadNonce, basePath, commit]);

  // Lazily create the draft on the first meaningful edit.
  useEffect(() => {
    const current = docRef.current;
    if (current.status !== 'ready' || current.draftId !== null) return;
    if (!hasDraftContent(currentFields())) return;
    if (creatingRef.current) return;
    creatingRef.current = true;
    void (async () => {
      try {
        // Adopt an already-stored empty draft instead of minting a new one; the
        // debounced save then patches the typed compose state into it.
        const reusable = pickReusableDraft(draftsRef.current);
        if (reusable !== null) {
          const fields = fieldsFromRecord(
            reusable.draft,
            attachablesRef.current,
          );
          syncedRef.current = { hash: reusable.contentHash, fields };
          update((previous) => ({
            ...previous,
            draftId: reusable.draft.id,
            contentHash: reusable.contentHash,
            saveError: null,
          }));
          navigate(`${basePath}?draft=${reusable.draft.id}`, { replace: true });
          return;
        }
        const outcome = await fetchersRef.current.createDraft(
          createPayloadOf(currentFields()),
        );
        if (!outcome.ok) {
          update((previous) => ({
            ...previous,
            saveError:
              errorTextOf(outcome.failure.body) ??
              'The draft could not be saved.',
          }));
          return;
        }
        const view = parseDraftView(outcome.data);
        if (view === null || view.contentHash === null) {
          update((previous) => ({
            ...previous,
            saveError: 'The draft was created but its response was unreadable.',
          }));
          return;
        }
        const serverFields = fieldsFromRecord(
          view.draft,
          attachablesRef.current,
        );
        syncedRef.current = { hash: view.contentHash, fields: serverFields };
        update((previous) => ({
          ...previous,
          draftId: view.draft.id,
          contentHash: view.contentHash,
          saveError: null,
        }));
        navigate(`${basePath}?draft=${view.draft.id}`, { replace: true });
      } finally {
        creatingRef.current = false;
      }
    })();
  }, [
    doc.status,
    doc.draftId,
    doc.message,
    doc.projects,
    doc.backend,
    doc.attachments,
    basePath,
    currentFields,
    update,
  ]);

  // Debounced update after the draft exists.
  useEffect(() => {
    if (doc.status !== 'ready' || doc.draftId === null) return;
    const pending = pendingDraftSave({
      draftId: doc.draftId,
      contentHash: doc.contentHash,
      synced: syncedRef.current.fields,
      current: currentFields(),
    });
    if (pending === null) {
      pendingSaveRef.current = null;
      return;
    }
    pendingSaveRef.current = pending;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      pendingSaveRef.current = null;
      void persist();
    }, saveDebounceMs);
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [
    doc.status,
    doc.draftId,
    doc.contentHash,
    doc.message,
    doc.projects,
    doc.backend,
    doc.attachments,
    currentFields,
    persist,
  ]);

  // Flush the last pending debounced save on unmount and on pagehide so a SPA
  // navigation or a full page unload does not drop it.
  useEffect(() => {
    const onPageHide = () => {
      flushPendingSave();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      flushPendingSave();
    };
  }, [flushPendingSave]);

  const setMessage = useCallback(
    (value: string) => {
      update((previous) => ({ ...previous, message: value }));
    },
    [update],
  );

  const setProjects = useCallback(
    (value: string[]) => {
      update((previous) => ({ ...previous, projects: [...value] }));
    },
    [update],
  );

  const setBackend = useCallback(
    (value: string | null) => {
      update((previous) => ({ ...previous, backend: value }));
    },
    [update],
  );

  const addAttachment = useCallback(
    (attachable: AttachableView) => {
      update((previous) => ({
        ...previous,
        attachments: addStagedAttachment(previous.attachments, attachable),
      }));
    },
    [update],
  );

  const removeAttachment = useCallback(
    (key: string) => {
      update((previous) => ({
        ...previous,
        attachments: previous.attachments.filter((entry) => entry.key !== key),
      }));
    },
    [update],
  );

  const retryLoad = useCallback(() => {
    setLoadNonce((value) => value + 1);
  }, []);

  const startFresh = useCallback(() => {
    freshIntentRef.current = true;
    navigate(basePath, { replace: true });
  }, [basePath]);

  const submitDraft = useCallback(async () => {
    const current = docRef.current;
    if (current.draftId === null) return;
    if (!hasMessageText(current.message)) return;
    if (submitRef.current.status === 'sending') return;
    submitAbortedRef.current = false;
    setSubmit(submitStarted());
    const hash = await flushSaves();
    // A mid-edit 404 recovery may have recreated the draft with a new id while
    // the saves flushed; submit against whatever is current now.
    const id = docRef.current.draftId;
    const userText = docRef.current.message;
    const attachments = [...docRef.current.attachments];
    if (hash === null || id === null) {
      setSubmit(
        submitFailed({
          errorText:
            docRef.current.saveError ??
            'The draft could not be saved before sending.',
          diagnostics: [],
        }),
      );
      return;
    }
    let outcome = await runDraftSubmit(
      id,
      hash,
      userText,
      attachments,
      (request) => {
        submitRequestRef.current = request;
      },
    );
    submitRequestRef.current = null;
    if (submitAbortedRef.current) {
      submitAbortedRef.current = false;
      return;
    }
    if (outcome.kind === 'fallback' && outcome.status === 409) {
      const refreshed = await refreshFromServer();
      if (refreshed !== null) {
        outcome = await runDraftSubmit(
          id,
          refreshed,
          userText,
          attachments,
          (request) => {
            submitRequestRef.current = request;
          },
        );
        submitRequestRef.current = null;
        if (submitAbortedRef.current) {
          submitAbortedRef.current = false;
          return;
        }
      }
    }
    if (outcome.kind === 'error') {
      setSubmit(
        submitFailed({
          errorText: outcome.errorText,
          diagnostics: outcome.diagnostics,
        }),
      );
      return;
    }
    if (outcome.kind === 'done') {
      const chatId = chatIdOfSubmit(outcome.result);
      if (chatId === null) {
        setSubmit(
          submitFailed({
            errorText: 'The chat was created but no id came back.',
            diagnostics: [],
          }),
        );
        return;
      }
      setSubmit(submitSucceeded());
      // The `created` event already navigated; only a done without one needs
      // the callback.
      if (!outcome.created) onSubmittedRef.current(chatId);
      return;
    }
    if (outcome.status >= 200 && outcome.status < 300) {
      const chatId = chatIdOfSubmit(outcome.body);
      if (chatId === null) {
        setSubmit(
          submitFailed({
            errorText: 'The chat was created but no id came back.',
            diagnostics: [],
          }),
        );
        return;
      }
      setSubmit(submitSucceeded());
      onSubmittedRef.current(chatId);
      return;
    }
    const failure = failureOf(outcome.status, outcome.body);
    setSubmit(
      submitFailed({
        errorText: failure.errorText,
        diagnostics: failure.diagnostics,
      }),
    );
  }, [flushSaves, refreshFromServer, setSubmit]);

  const submit = useCallback(() => {
    void submitDraft();
  }, [submitDraft]);

  // Stop a draft submit that is still streaming: abort the request, drop back to
  // idle, and leave the stored draft exactly as it was so the user can resend.
  const stopSubmit = useCallback(() => {
    if (submitRef.current.status !== 'sending') return;
    submitAbortedRef.current = true;
    const request = submitRequestRef.current;
    submitRequestRef.current = null;
    setSubmit(idleSubmit);
    request?.abort();
  }, [setSubmit]);

  return {
    status: doc.status,
    failure: doc.failure,
    draftId: doc.draftId,
    message: doc.message,
    projects: doc.projects,
    backend: doc.backend,
    attachments: doc.attachments,
    saving: doc.saving,
    saveError: doc.saveError,
    submitState,
    setMessage,
    setProjects,
    setBackend,
    addAttachment,
    removeAttachment,
    retryLoad,
    startFresh,
    submit,
    stopSubmit,
  };
}
