import { describe, expect, it } from 'vitest';

import {
  editorStatusKind,
  editorStatusText,
  fileTitle,
  initialEditorDoc,
  parseEditResult,
  parseEditableFileView,
  reduceConflict,
  shouldAutosave,
  titleEditable,
  type ConflictFields,
  type EditableFileView,
} from '../../web/src/pages/editModel.js';

const hash = 'ab'.repeat(32);
const nextHash = 'cd'.repeat(32);

function fileOf(overrides: Partial<EditableFileView>): EditableFileView {
  return {
    kind: 'chat',
    path: 'chats/2026-09-10-lab-agenda.md',
    metadata: {},
    unknownKeys: [],
    body: 'Planning thread.',
    contentHash: hash,
    editableFields: [],
    ...overrides,
  };
}

function conflictOf(overrides: Partial<ConflictFields>): ConflictFields {
  return {
    body: 'local draft',
    savedBody: 'on disk',
    expectedHash: hash,
    conflictHash: nextHash,
    ...overrides,
  };
}

describe('parseEditableFileView', () => {
  it('normalizes the GET /api/file response', () => {
    const view = parseEditableFileView({
      kind: 'resource',
      path: 'projects/evo/context/posterior.md',
      metadata: { title: 'Posterior notes' },
      unknownKeys: ['custom'],
      body: '# Notes',
      contentHash: hash,
      editableFields: [{ field: 'title', type: 'text' }],
    });
    expect(view).toEqual({
      kind: 'resource',
      path: 'projects/evo/context/posterior.md',
      metadata: { title: 'Posterior notes' },
      unknownKeys: ['custom'],
      body: '# Notes',
      contentHash: hash,
      editableFields: [{ field: 'title', type: 'text' }],
    });
  });

  it('rejects responses without a kind, path, or hash', () => {
    expect(parseEditableFileView(null)).toBeNull();
    expect(
      parseEditableFileView({ path: 'a.md', contentHash: hash }),
    ).toBeNull();
    expect(
      parseEditableFileView({ kind: 'chat', contentHash: hash }),
    ).toBeNull();
    expect(parseEditableFileView({ kind: 'chat', path: 'a.md' })).toBeNull();
  });
});

describe('shouldAutosave', () => {
  it('saves when dirty and settled on a ready file with a hash', () => {
    expect(
      shouldAutosave({
        status: 'ready',
        dirty: true,
        saving: false,
        expectedHash: hash,
        conflict: false,
      }),
    ).toBe(true);
  });

  it('stays quiet when nothing changed', () => {
    expect(
      shouldAutosave({
        status: 'ready',
        dirty: false,
        saving: false,
        expectedHash: hash,
        conflict: false,
      }),
    ).toBe(false);
  });

  it('waits for an in-flight save to settle', () => {
    expect(
      shouldAutosave({
        status: 'ready',
        dirty: true,
        saving: true,
        expectedHash: hash,
        conflict: false,
      }),
    ).toBe(false);
  });

  it('never autosaves through an unresolved conflict', () => {
    expect(
      shouldAutosave({
        status: 'ready',
        dirty: true,
        saving: false,
        expectedHash: hash,
        conflict: true,
      }),
    ).toBe(false);
  });

  it('requires a loadable file and an expected hash', () => {
    expect(
      shouldAutosave({
        status: 'ready',
        dirty: true,
        saving: false,
        expectedHash: null,
        conflict: false,
      }),
    ).toBe(false);
    expect(
      shouldAutosave({
        status: 'loading',
        dirty: true,
        saving: false,
        expectedHash: hash,
        conflict: false,
      }),
    ).toBe(false);
  });
});

describe('reduceConflict', () => {
  it('keep-editing keeps the local text and adopts the fresh hash', () => {
    const next = reduceConflict(conflictOf({}), { type: 'keep-editing' });
    expect(next).toEqual({
      body: 'local draft',
      savedBody: 'on disk',
      expectedHash: nextHash,
      conflictHash: null,
    });
  });

  it('keep-editing falls back to the loaded hash without a fresh one', () => {
    const next = reduceConflict(conflictOf({ conflictHash: null }), {
      type: 'keep-editing',
    });
    expect(next.expectedHash).toBe(hash);
    expect(next.conflictHash).toBeNull();
  });

  it('reload discards the local text for the on-disk copy', () => {
    const next = reduceConflict(conflictOf({}), {
      type: 'reload',
      body: 'fresh from disk',
      contentHash: 'ef'.repeat(32),
    });
    expect(next).toEqual({
      body: 'fresh from disk',
      savedBody: 'fresh from disk',
      expectedHash: 'ef'.repeat(32),
      conflictHash: null,
    });
  });
});

describe('titleEditable and fileTitle', () => {
  it('allows renaming only when the title field is editable', () => {
    expect(
      titleEditable(
        fileOf({ editableFields: [{ field: 'title', type: 'text' }] }),
      ),
    ).toBe(true);
    expect(
      titleEditable(
        fileOf({ editableFields: [{ field: 'topics', type: 'list' }] }),
      ),
    ).toBe(false);
    expect(titleEditable(fileOf({}))).toBe(false);
  });

  it('prefers the metadata title and falls back to the basename', () => {
    expect(
      fileTitle(fileOf({ metadata: { title: 'Lab meeting agenda' } })),
    ).toBe('Lab meeting agenda');
    expect(fileTitle(fileOf({ metadata: { title: '' } }))).toBe(
      '2026-09-10-lab-agenda.md',
    );
  });
});

describe('editorStatusKind and editorStatusText', () => {
  it('prioritizes loading, error, saving, then conflict', () => {
    expect(
      editorStatusKind({
        status: 'loading',
        saving: true,
        conflict: true,
        dirty: true,
        errorText: null,
      }),
    ).toBe('loading');
    expect(
      editorStatusKind({
        status: 'error',
        saving: false,
        conflict: false,
        dirty: false,
        errorText: 'boom',
      }),
    ).toBe('error');
    expect(
      editorStatusKind({
        status: 'ready',
        saving: true,
        conflict: true,
        dirty: true,
        errorText: null,
      }),
    ).toBe('saving');
    expect(
      editorStatusKind({
        status: 'ready',
        saving: false,
        conflict: true,
        dirty: true,
        errorText: null,
      }),
    ).toBe('conflict');
  });

  it('distinguishes unsaved work from a clean autosave', () => {
    expect(
      editorStatusKind({
        status: 'ready',
        saving: false,
        conflict: false,
        dirty: true,
        errorText: null,
      }),
    ).toBe('unsaved');
    expect(
      editorStatusKind({
        status: 'ready',
        saving: false,
        conflict: false,
        dirty: false,
        errorText: null,
      }),
    ).toBe('autosaved');
  });

  it('maps each kind to the status line copy', () => {
    expect(editorStatusText('loading', null)).toBe('loading…');
    expect(editorStatusText('error', null)).toBe('not saved');
    expect(editorStatusText('saving', null)).toBe('saving…');
    expect(editorStatusText('conflict', null)).toBe('conflict');
    expect(editorStatusText('unsaved', null)).toBe('unsaved changes');
    expect(editorStatusText('autosaved', null)).toBe('autosaved');
    expect(editorStatusText('autosaved', 0, () => '09:41')).toBe(
      'autosaved 09:41',
    );
  });
});

describe('parseEditResult', () => {
  it('reads the changed flag and the next content hash', () => {
    expect(parseEditResult({ changed: true, contentHash: nextHash })).toEqual({
      changed: true,
      contentHash: nextHash,
    });
    expect(parseEditResult({ changed: false })).toEqual({
      changed: false,
      contentHash: null,
    });
    expect(parseEditResult(null)).toBeNull();
  });
});

describe('initialEditorDoc', () => {
  it('starts in a neutral loading state', () => {
    expect(initialEditorDoc).toEqual({
      status: 'loading',
      file: null,
      body: '',
      savedBody: '',
      expectedHash: null,
      saving: false,
      conflictHash: null,
      errorText: null,
      savedAt: null,
    });
  });
});
