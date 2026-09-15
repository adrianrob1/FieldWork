import { useCallback, useEffect, useRef, useState } from 'react';

import { getJson, postJson, type ApiFailure } from '../shared/api.js';
import {
  editorStatusKind,
  editorStatusText,
  initialEditorDoc,
  isDirty,
  loadFailureMessage,
  parseEditResult,
  parseEditableFileView,
  reduceConflict,
  shouldAutosave,
  editLoadFailure,
  type EditorDoc,
  type EditorStatusKind,
} from './editModel.js';

export const autosaveDelayMs = 800;

export interface EditPageApi {
  doc: EditorDoc;
  dirty: boolean;
  statusKind: EditorStatusKind;
  statusText: string;
  retry: () => void;
  setBody: (value: string) => void;
  commitTitle: (value: string) => Promise<void>;
  keepEditing: () => void;
  reloadFromDisk: () => void;
}

function failureMessage(failure: ApiFailure): string {
  return loadFailureMessage(editLoadFailure(failure.status, failure.body));
}

// Owns the file -> autosave -> conflict lifecycle for /edit. The pure decisions
// (autosave gating, conflict transitions, status text) live in editModel.ts.
export function useEditPage(path: string | null): EditPageApi {
  const [doc, setDoc] = useState<EditorDoc>(initialEditorDoc);
  const docRef = useRef(doc);
  const tokenRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const savingRef = useRef(false);

  useEffect(() => {
    docRef.current = doc;
  }, [doc]);

  const fetchFile = useCallback(
    async (token: number, target: string): Promise<void> => {
      const outcome = await getJson<unknown>(
        `/api/file?path=${encodeURIComponent(target)}`,
      );
      if (token !== tokenRef.current) return;
      if (!outcome.ok) {
        setDoc({
          ...initialEditorDoc,
          status: 'error',
          errorText: failureMessage(outcome.failure),
        });
        return;
      }
      const file = parseEditableFileView(outcome.data);
      if (file === null) {
        setDoc({
          ...initialEditorDoc,
          status: 'error',
          errorText: 'The file response could not be read.',
        });
        return;
      }
      setDoc({
        status: 'ready',
        file,
        body: file.body,
        savedBody: file.body,
        expectedHash: file.contentHash,
        saving: false,
        conflictHash: null,
        errorText: null,
        savedAt: null,
      });
    },
    [],
  );

  useEffect(() => {
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (path === null || path.trim() === '') {
      setDoc({
        ...initialEditorDoc,
        status: 'error',
        errorText: 'No file path was provided.',
      });
      return;
    }
    setDoc({ ...initialEditorDoc, status: 'loading' });
    void fetchFile(token, path);
  }, [path, fetchFile]);

  const save = useCallback(async (): Promise<void> => {
    const current = docRef.current;
    if (
      current.status !== 'ready' ||
      current.file === null ||
      !shouldAutosave({
        status: current.status,
        dirty: isDirty(current),
        saving: savingRef.current,
        expectedHash: current.expectedHash,
        conflict: current.conflictHash !== null,
      })
    ) {
      return;
    }
    const body = current.body;
    const expectedHash = current.expectedHash;
    if (expectedHash === null) return;
    const token = tokenRef.current;
    savingRef.current = true;
    setDoc((previous) => ({ ...previous, saving: true, errorText: null }));
    const outcome = await postJson<unknown>('/api/edit/body', {
      path: current.file.path,
      body,
      expectedHash,
    });
    savingRef.current = false;
    if (token !== tokenRef.current) return;
    if (outcome.ok) {
      const result = parseEditResult(outcome.data);
      setDoc((previous) => ({
        ...previous,
        saving: false,
        savedBody: body,
        expectedHash: result?.contentHash ?? previous.expectedHash,
        savedAt: Date.now(),
      }));
      return;
    }
    if (outcome.failure.status === 409) {
      const conflictHash = outcome.failure.currentHash;
      setDoc((previous) => ({
        ...previous,
        saving: false,
        conflictHash: conflictHash ?? previous.expectedHash,
      }));
      return;
    }
    setDoc((previous) => ({
      ...previous,
      saving: false,
      errorText: failureMessage(outcome.failure),
    }));
  }, []);

  useEffect(() => {
    if (doc.status !== 'ready') return;
    if (
      !shouldAutosave({
        status: doc.status,
        dirty: isDirty(doc),
        saving: doc.saving,
        expectedHash: doc.expectedHash,
        conflict: doc.conflictHash !== null,
      })
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      timerRef.current = null;
      void save();
    }, autosaveDelayMs);
    timerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (timerRef.current === timer) timerRef.current = null;
    };
  }, [doc, save]);

  useEffect(() => {
    const dirty = doc.status === 'ready' && isDirty(doc);
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [doc]);

  const retry = useCallback(() => {
    if (path === null || path.trim() === '') {
      setDoc({
        ...initialEditorDoc,
        status: 'error',
        errorText: 'No file path was provided.',
      });
      return;
    }
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setDoc({ ...initialEditorDoc, status: 'loading' });
    void fetchFile(token, path);
  }, [path, fetchFile]);

  const setBody = useCallback((value: string) => {
    setDoc((previous) =>
      previous.status === 'ready' ? { ...previous, body: value } : previous,
    );
  }, []);

  const commitTitle = useCallback(async (value: string): Promise<void> => {
    const current = docRef.current;
    if (
      current.status !== 'ready' ||
      current.file === null ||
      current.expectedHash === null
    ) {
      throw new Error('The file is not ready to rename.');
    }
    const outcome = await postJson<unknown>('/api/edit/frontmatter', {
      path: current.file.path,
      changes: { title: value },
      expectedHash: current.expectedHash,
    });
    if (!outcome.ok) {
      if (outcome.failure.status === 409) {
        const conflictHash = outcome.failure.currentHash;
        setDoc((previous) => ({
          ...previous,
          conflictHash: conflictHash ?? previous.expectedHash,
        }));
      }
      throw new Error(failureMessage(outcome.failure));
    }
    const result = parseEditResult(outcome.data);
    setDoc((previous) =>
      previous.file === null
        ? previous
        : {
            ...previous,
            file: {
              ...previous.file,
              metadata: { ...previous.file.metadata, title: value },
            },
            expectedHash: result?.contentHash ?? previous.expectedHash,
          },
    );
  }, []);

  const keepEditing = useCallback(() => {
    setDoc((previous) => reduceConflict(previous, { type: 'keep-editing' }));
  }, []);

  const reloadFromDisk = useCallback(() => {
    const current = docRef.current;
    const target = current.file?.path;
    if (target === undefined) return;
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setDoc({ ...initialEditorDoc, status: 'loading' });
    void (async () => {
      // Conflict recovery must read the current bytes; the external write that
      // caused the 409 was not one of our POSTs, so the cache is still stale.
      const outcome = await getJson<unknown>(
        `/api/file?path=${encodeURIComponent(target)}`,
        { bypassCache: true },
      );
      if (token !== tokenRef.current) return;
      if (!outcome.ok) {
        setDoc({
          ...initialEditorDoc,
          status: 'error',
          errorText: failureMessage(outcome.failure),
        });
        return;
      }
      const file = parseEditableFileView(outcome.data);
      if (file === null) {
        setDoc({
          ...initialEditorDoc,
          status: 'error',
          errorText: 'The file response could not be read.',
        });
        return;
      }
      setDoc((previous) =>
        reduceConflict(
          {
            ...previous,
            status: 'ready',
            file,
            savedAt: previous.savedAt,
          },
          { type: 'reload', body: file.body, contentHash: file.contentHash },
        ),
      );
    })();
  }, []);

  const dirty = doc.status === 'ready' && isDirty(doc);
  const statusKind = editorStatusKind({
    status: doc.status,
    saving: doc.saving,
    conflict: doc.conflictHash !== null,
    dirty,
    errorText: doc.errorText,
  });
  const statusText = editorStatusText(statusKind, doc.savedAt);

  return {
    doc,
    dirty,
    statusKind,
    statusText,
    retry,
    setBody,
    commitTitle,
    keepEditing,
    reloadFromDisk,
  };
}
