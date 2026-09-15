import { useCallback, useRef, useState } from 'react';

import { getJson, postJson, type ApiFailure } from '../../shared/api.js';
import { parseAttachables } from '../draftFlow.js';
import {
  parseBodyEditResult,
  parseEditableFile,
  type EditableFile,
} from './attachmentEditor.js';
import type { AttachmentView } from './chatThread.js';

export type AttachmentEditorStatus = 'loading' | 'ready' | 'error';

interface EditorDoc {
  open: boolean;
  status: AttachmentEditorStatus;
  file: EditableFile | null;
  body: string;
  savedBody: string;
  expectedHash: string | null;
  saving: boolean;
  saved: boolean;
  errorText: string | null;
  conflictHash: string | null;
}

export interface AttachmentEditor extends EditorDoc {
  dirty: boolean;
  openAttachment: (attachment: AttachmentView) => void;
  close: () => void;
  setBody: (value: string) => void;
  save: () => void;
  reloadFromDisk: () => void;
  keepEditing: () => void;
}

function closedDoc(): EditorDoc {
  return {
    open: false,
    status: 'loading',
    file: null,
    body: '',
    savedBody: '',
    expectedHash: null,
    saving: false,
    saved: false,
    errorText: null,
    conflictHash: null,
  };
}

const attachableQuery =
  '/api/attachables?q=&kinds=task,resource,summary,chat&limit=200';

function isWorkspaceRelative(path: string): boolean {
  if (path === '') return false;
  if (path.startsWith('/') || path.startsWith('~')) return false;
  if (path.includes('\\')) return false;
  if (/^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

function failureMessage(failure: ApiFailure): string {
  return (
    failure.errorText ??
    failure.diagnostics.find((entry) => entry.severity === 'error')?.message ??
    'The file could not be read.'
  );
}

async function lookupAttachablePath(id: string): Promise<string | null> {
  const outcome = await getJson<unknown>(attachableQuery);
  if (!outcome.ok) return null;
  const hit = parseAttachables(outcome.data).find((entry) => entry.id === id);
  if (hit === undefined || hit.path === '') return null;
  return hit.path;
}

// Owns the attachment -> file -> body editor lifecycle for the slide-over,
// including the stale-hash conflict handshake. The pure parsing lives in
// attachmentEditor.ts.
export function useAttachmentEditor(): AttachmentEditor {
  const [doc, setDoc] = useState<EditorDoc>(closedDoc);
  const tokenRef = useRef(0);

  const loadInto = useCallback(
    async (
      path: string,
      token: number,
      bypassCache = false,
    ): Promise<boolean> => {
      const outcome = await getJson<unknown>(
        `/api/file?path=${encodeURIComponent(path)}`,
        bypassCache ? { bypassCache: true } : undefined,
      );
      if (token !== tokenRef.current) return true;
      if (!outcome.ok) return false;
      const file = parseEditableFile(outcome.data);
      if (file === null) return false;
      setDoc((previous) => ({
        ...previous,
        status: 'ready',
        file,
        body: file.body,
        savedBody: file.body,
        expectedHash: file.contentHash,
        saving: false,
        saved: false,
        errorText: null,
        conflictHash: null,
      }));
      return true;
    },
    [],
  );

  const openAttachment = useCallback(
    (attachment: AttachmentView) => {
      const token = tokenRef.current + 1;
      tokenRef.current = token;
      setDoc({ ...closedDoc(), open: true });
      void (async () => {
        const preferred = attachment.path;
        if (preferred !== null && isWorkspaceRelative(preferred)) {
          if (await loadInto(preferred, token)) return;
        }
        if (attachment.id !== null) {
          const resolved = await lookupAttachablePath(attachment.id);
          if (token !== tokenRef.current) return;
          if (resolved !== null && (await loadInto(resolved, token))) return;
        }
        if (token !== tokenRef.current) return;
        setDoc((previous) => ({
          ...previous,
          status: 'error',
          errorText:
            'The attachment could not be opened; its file may have moved or been removed.',
        }));
      })();
    },
    [loadInto],
  );

  const close = useCallback(() => {
    tokenRef.current += 1;
    setDoc(closedDoc());
  }, []);

  const setBody = useCallback((value: string) => {
    setDoc((previous) => ({ ...previous, body: value, saved: false }));
  }, []);

  const reloadFromDisk = useCallback(() => {
    const path = doc.file?.path;
    if (path === undefined) return;
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    setDoc((previous) => ({
      ...previous,
      status: 'loading',
      errorText: null,
      conflictHash: null,
    }));
    void (async () => {
      // A conflict reload must bypass the cache: the competing write did not
      // come from this client, so no POST invalidated the cached body.
      const loaded = await loadInto(path, token, true);
      if (loaded || token !== tokenRef.current) return;
      setDoc((previous) => ({
        ...previous,
        status: 'error',
        errorText: 'The file could not be reloaded.',
      }));
    })();
  }, [doc.file, loadInto]);

  const keepEditing = useCallback(() => {
    setDoc((previous) => ({
      ...previous,
      expectedHash: previous.conflictHash ?? previous.expectedHash,
      conflictHash: null,
    }));
  }, []);

  const save = useCallback(() => {
    const current = doc;
    const file = current.file;
    if (
      current.status !== 'ready' ||
      file === null ||
      current.saving ||
      current.expectedHash === null ||
      current.body === current.savedBody
    ) {
      return;
    }
    const token = tokenRef.current;
    setDoc((previous) => ({ ...previous, saving: true, errorText: null }));
    void postJson<unknown>('/api/edit/body', {
      path: file.path,
      body: current.body,
      expectedHash: current.expectedHash,
    }).then((outcome) => {
      if (token !== tokenRef.current) return;
      if (outcome.ok) {
        const result = parseBodyEditResult(outcome.data);
        setDoc((previous) => ({
          ...previous,
          saving: false,
          saved: true,
          conflictHash: null,
          savedBody: previous.body,
          expectedHash: result?.contentHash ?? previous.expectedHash,
        }));
        return;
      }
      if (outcome.failure.status === 409) {
        setDoc((previous) => ({
          ...previous,
          saving: false,
          conflictHash: outcome.failure.currentHash,
        }));
        return;
      }
      setDoc((previous) => ({
        ...previous,
        saving: false,
        errorText: failureMessage(outcome.failure),
      }));
    });
  }, [doc]);

  return {
    ...doc,
    dirty: doc.status === 'ready' && doc.body !== doc.savedBody,
    openAttachment,
    close,
    setBody,
    save,
    reloadFromDisk,
    keepEditing,
  };
}
