import { describe, expect, it } from 'vitest';

import {
  addStagedAttachment,
  attachmentRefOf,
  buildDraftPatch,
  chatIdOfSubmit,
  createPayloadOf,
  draftRowPreview,
  emptyDraftFields,
  fieldsFromRecord,
  firstLineTitle,
  hasDraftContent,
  idleSubmit,
  isEmptyPatch,
  mostRecentDraft,
  parseAttachables,
  parseDraftList,
  parseDraftRecord,
  parseDraftView,
  pendingDraftSave,
  pickReusableDraft,
  resumeDecision,
  stagedAttachmentOf,
  submitFailed,
  submitStarted,
  submitSucceeded,
  type AttachableView,
  type DraftEntry,
  type DraftFields,
  type DraftRecordView,
} from '../../web/src/pages/draftFlow.js';

const hash = 'ab'.repeat(32);

function recordOf(overrides: Partial<DraftRecordView> = {}): DraftRecordView {
  return {
    id: 'draft_aaaaaaaaaaaa',
    message: '',
    projects: [],
    backend: null,
    attachments: [],
    created: '2026-09-10T09:00:00.000Z',
    updated: '2026-09-10T09:00:00.000Z',
    consumed: false,
    ...overrides,
  };
}

function entryOf(id: string, updated: string, consumed = false): DraftEntry {
  return {
    draft: recordOf({ id, updated, consumed }),
    contentHash: hash,
  };
}

function fieldsOf(overrides: Partial<DraftFields> = {}): DraftFields {
  return { ...emptyDraftFields(), ...overrides };
}

const attachableReadme: AttachableView = {
  id: 'resource_evon_readme',
  kind: 'resource',
  title: 'Evon README',
  path: 'repositories/evon/README.md',
  label: 'Evon README',
};

describe('firstLineTitle', () => {
  it('uses the collapsed first line', () => {
    expect(firstLineTitle('  Plan   the   batch\nsecond line')).toBe(
      'Plan the batch',
    );
  });

  it('falls back to the untitled label for empty drafts', () => {
    expect(firstLineTitle('   \n')).toBe('Untitled draft');
  });
});

describe('draftRowPreview', () => {
  it('uses the first non-empty line', () => {
    expect(draftRowPreview('\n\nActual message')).toBe('Actual message');
  });

  it('uses the mockup fallback for empty drafts', () => {
    expect(draftRowPreview('  ')).toBe(
      "Write the first message when you're ready.",
    );
  });
});

describe('parseDraftRecord', () => {
  it('parses a completed record and normalizes missing fields', () => {
    expect(
      parseDraftRecord({
        id: 'draft_abcabcabcabc',
        message: 'hello',
        projects: ['project_evon'],
        backend: 'manual',
        attachments: [{ id: 'resource_readme' }, { path: '/tmp/x.md' }],
        created: '2026-09-10T09:00:00.000Z',
        updated: '2026-09-10T09:05:00.000Z',
      }),
    ).toEqual({
      id: 'draft_abcabcabcabc',
      message: 'hello',
      projects: ['project_evon'],
      backend: 'manual',
      attachments: [{ id: 'resource_readme' }, { path: '/tmp/x.md' }],
      created: '2026-09-10T09:00:00.000Z',
      updated: '2026-09-10T09:05:00.000Z',
      consumed: false,
    });
  });

  it('rejects a record without an id', () => {
    expect(parseDraftRecord({ message: 'x' })).toBeNull();
  });

  it('rejects a record without a message string', () => {
    expect(parseDraftRecord({ id: 'draft_abcabcabcabc' })).toBeNull();
  });
});

describe('parseDraftView', () => {
  it('unwraps a nested DraftView with its content hash', () => {
    const view = parseDraftView({
      draft: {
        draft: recordOf({ message: 'hi' }),
        contentHash: hash,
        route: '/chats/new?draft=draft_aaaaaaaaaaaa',
      },
      diagnostics: [],
    });
    expect(view).toEqual({
      draft: recordOf({ message: 'hi' }),
      contentHash: hash,
    });
  });

  it('accepts a bare record view without a hash', () => {
    const view = parseDraftView({ draft: recordOf({ message: 'hi' }) });
    expect(view?.draft.message).toBe('hi');
    expect(view?.contentHash).toBeNull();
  });
});

describe('parseDraftList', () => {
  it('keeps list entries and their hashes', () => {
    const entries = parseDraftList({
      drafts: [{ draft: recordOf({ message: 'a' }), contentHash: hash }],
      diagnostics: [],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.contentHash).toBe(hash);
    expect(entries[0]?.draft.message).toBe('a');
  });

  it('drops entries without a usable hash', () => {
    expect(parseDraftList({ drafts: [{ draft: recordOf() }] })).toHaveLength(0);
  });
});

describe('resumeDecision', () => {
  it('opens the query param when present', () => {
    expect(resumeDecision('draft_param0000000', [])).toEqual({
      kind: 'open-param',
      draftId: 'draft_param0000000',
    });
  });

  it('resumes the most recently updated non-consumed draft', () => {
    const entries = [
      entryOf('draft_old0000000', '2026-09-01T00:00:00.000Z'),
      entryOf('draft_new0000000', '2026-09-09T00:00:00.000Z'),
    ];
    expect(resumeDecision(null, entries)).toEqual({
      kind: 'resume-recent',
      draftId: 'draft_new0000000',
    });
  });

  it('skips consumed drafts when choosing the most recent', () => {
    const entries = [
      entryOf('draft_new0000000', '2026-09-09T00:00:00.000Z', true),
      entryOf('draft_old0000000', '2026-09-01T00:00:00.000Z'),
    ];
    expect(mostRecentDraft(entries)?.draft.id).toBe('draft_old0000000');
  });

  it('starts fresh when nothing is stored', () => {
    expect(resumeDecision(null, [])).toEqual({ kind: 'fresh' });
  });
});

describe('pickReusableDraft', () => {
  it('picks the most recent empty draft and skips drafts with content', () => {
    const contentEntry = entryOf(
      'draft_content0001',
      '2026-09-09T00:00:00.000Z',
    );
    contentEntry.draft.message = 'Already drafting';
    const emptyEntry = entryOf('draft_empty00001', '2026-09-08T00:00:00.000Z');
    expect(pickReusableDraft([contentEntry, emptyEntry])?.draft.id).toBe(
      'draft_empty00001',
    );
  });

  it('skips a draft with attachments', () => {
    const attached = entryOf('draft_attached001', '2026-09-09T00:00:00.000Z');
    attached.draft.attachments = [{ id: 'task_lab_refresh' }];
    expect(pickReusableDraft([attached])).toBeNull();
  });

  it('treats project and backend picks as reusable', () => {
    const picked = entryOf('draft_picked0001', '2026-09-09T00:00:00.000Z');
    picked.draft.projects = ['project_evon'];
    picked.draft.backend = 'manual';
    expect(pickReusableDraft([picked])?.draft.id).toBe('draft_picked0001');
  });

  it('returns null when every draft has content', () => {
    const only = entryOf('draft_content0002', '2026-09-09T00:00:00.000Z');
    only.draft.message = 'text';
    expect(pickReusableDraft([only])).toBeNull();
  });

  it('prefers the most recently updated reusable draft', () => {
    const older = entryOf('draft_older00001', '2026-09-01T00:00:00.000Z');
    const newer = entryOf('draft_newer00001', '2026-09-09T00:00:00.000Z');
    expect(pickReusableDraft([older, newer])?.draft.id).toBe(
      'draft_newer00001',
    );
  });
});

describe('buildDraftPatch', () => {
  it('returns an empty patch when nothing changed', () => {
    const fields = fieldsOf({ message: 'hello', projects: ['p1'] });
    const patch = buildDraftPatch(fields, fields);
    expect(isEmptyPatch(patch)).toBe(true);
  });

  it('patches only the changed message', () => {
    const previous = fieldsOf({ message: 'one', projects: ['p1'] });
    const next = fieldsOf({ message: 'two', projects: ['p1'] });
    expect(buildDraftPatch(previous, next)).toEqual({ message: 'two' });
  });

  it('patches only the changed projects', () => {
    const previous = fieldsOf({ message: 'same', projects: ['p1'] });
    const next = fieldsOf({ message: 'same', projects: ['p1', 'p2'] });
    expect(buildDraftPatch(previous, next)).toEqual({
      projects: ['p1', 'p2'],
    });
  });

  it('patches a newly picked backend only', () => {
    const previous = fieldsOf({ message: 'same' });
    const next = fieldsOf({ message: 'same', backend: 'manual' });
    expect(buildDraftPatch(previous, next)).toEqual({ backend: 'manual' });
  });

  it('does not send a backend patch when clearing to the default', () => {
    const previous = fieldsOf({ message: 'same', backend: 'manual' });
    const next = fieldsOf({ message: 'same', backend: null });
    expect(isEmptyPatch(buildDraftPatch(previous, next))).toBe(true);
  });

  it('serializes staged attachments to references', () => {
    const previous = fieldsOf({ message: 'same' });
    const next = fieldsOf({
      message: 'same',
      attachments: [
        {
          key: 'resource_readme',
          id: 'resource_readme',
          path: null,
          label: 'README',
          kind: 'resource',
        },
      ],
    });
    expect(buildDraftPatch(previous, next)).toEqual({
      attachments: [{ id: 'resource_readme' }],
    });
  });
});

describe('pendingDraftSave', () => {
  it('returns null without a stored draft', () => {
    expect(
      pendingDraftSave({
        draftId: null,
        contentHash: hash,
        synced: fieldsOf({ message: 'one' }),
        current: fieldsOf({ message: 'two' }),
      }),
    ).toBeNull();
  });

  it('returns null without a content hash', () => {
    expect(
      pendingDraftSave({
        draftId: 'draft_aaaaaaaaaaaa',
        contentHash: null,
        synced: fieldsOf({ message: 'one' }),
        current: fieldsOf({ message: 'two' }),
      }),
    ).toBeNull();
  });

  it('returns null when nothing changed', () => {
    const fields = fieldsOf({ message: 'same', projects: ['p1'] });
    expect(
      pendingDraftSave({
        draftId: 'draft_aaaaaaaaaaaa',
        contentHash: hash,
        synced: fields,
        current: fields,
      }),
    ).toBeNull();
  });

  it('carries the draft id, hash, and changed patch', () => {
    expect(
      pendingDraftSave({
        draftId: 'draft_aaaaaaaaaaaa',
        contentHash: hash,
        synced: fieldsOf({ message: 'one' }),
        current: fieldsOf({ message: 'two' }),
      }),
    ).toEqual({
      draftId: 'draft_aaaaaaaaaaaa',
      expectedHash: hash,
      patch: { message: 'two' },
    });
  });
});

describe('createPayloadOf and hasDraftContent', () => {
  it('omits the backend when unset and includes attachments', () => {
    const fields = fieldsOf({ message: 'hi', projects: ['p1'] });
    expect(createPayloadOf(fields)).toEqual({
      message: 'hi',
      projects: ['p1'],
      attachments: [],
    });
  });

  it('includes the backend when set', () => {
    expect(createPayloadOf(fieldsOf({ backend: 'manual' })).backend).toBe(
      'manual',
    );
  });

  it('detects meaningful content', () => {
    expect(hasDraftContent(emptyDraftFields())).toBe(false);
    expect(hasDraftContent(fieldsOf({ message: '   ' }))).toBe(false);
    expect(hasDraftContent(fieldsOf({ projects: ['p1'] }))).toBe(true);
    expect(hasDraftContent(fieldsOf({ backend: 'manual' }))).toBe(true);
  });
});

describe('attachable labels', () => {
  it('resolves a staged attachment by id to its title label', () => {
    const staged = stagedAttachmentOf(
      { id: 'resource_evon_readme' },
      new Map(),
    );
    expect(staged.label).toBe('resource_evon_readme');
    const resolved = stagedAttachmentOf(
      { id: 'resource_evon_readme' },
      new Map([[attachableReadme.id, attachableReadme]]),
    );
    expect(resolved).toEqual({
      key: 'resource_evon_readme',
      id: 'resource_evon_readme',
      path: null,
      label: 'Evon README',
      kind: 'resource',
    });
    expect(resolved.label).not.toContain('/');
  });

  it('falls back to the last path segment for path-only references', () => {
    const staged = stagedAttachmentOf({ path: 'a/b/notes.md' }, new Map());
    expect(staged.label).toBe('notes.md');
  });

  it('parses attachables from the API payload', () => {
    const attachables = parseAttachables({
      attachables: [
        {
          id: 'task_scaling',
          kind: 'task',
          title: 'Scaling review',
          path: 'tasks/scaling-review.md',
          label: 'Scaling review',
        },
      ],
    });
    expect(attachables).toHaveLength(1);
    expect(attachables[0]?.label).toBe('Scaling review');
  });

  it('adds staged attachments without duplicating an id', () => {
    const first = addStagedAttachment([], attachableReadme);
    expect(first).toHaveLength(1);
    expect(addStagedAttachment(first, attachableReadme)).toHaveLength(1);
  });

  it('hydrates fields from a record using attachable labels', () => {
    const fields = fieldsFromRecord(
      recordOf({
        message: 'hello',
        projects: ['project_evon'],
        backend: 'manual',
        attachments: [{ id: 'resource_evon_readme' }],
      }),
      [attachableReadme],
    );
    expect(fields.message).toBe('hello');
    expect(fields.projects).toEqual(['project_evon']);
    expect(fields.backend).toBe('manual');
    expect(fields.attachments[0]?.label).toBe('Evon README');
  });

  it('round-trips a staged attachment to a reference', () => {
    const staged = addStagedAttachment([], attachableReadme)[0];
    if (staged === undefined) throw new Error('expected a staged attachment');
    expect(attachmentRefOf(staged)).toEqual({ id: 'resource_evon_readme' });
  });
});

describe('submit transitions', () => {
  it('goes idle to sending to done', () => {
    const sending = submitStarted();
    expect(sending.status).toBe('sending');
    expect(submitSucceeded().status).toBe('done');
    expect(idleSubmit.status).toBe('idle');
  });

  it('carries the error text and diagnostics on failure', () => {
    const failed = submitFailed({
      errorText: 'backend.unconfigured',
      diagnostics: [
        {
          code: 'backend.unconfigured',
          severity: 'error',
          file: 'workspace.yml',
          fieldPath: null,
          message: 'No backend is configured.',
          line: null,
          column: null,
        },
      ],
    });
    expect(failed.status).toBe('failed');
    expect(failed.errorText).toBe('backend.unconfigured');
    expect(failed.diagnostics).toHaveLength(1);
  });

  it('reads the chat id from a submit response', () => {
    expect(chatIdOfSubmit({ chat: { chatId: 'chat_x' } })).toBe('chat_x');
    expect(chatIdOfSubmit({})).toBeNull();
  });
});
