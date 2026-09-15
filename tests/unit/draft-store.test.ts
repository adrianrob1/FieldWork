import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDraft,
  deleteDraft,
  draftFilePath,
  listDrafts,
  loadDraft,
  markDraftConsumed,
  updateDraft,
  type DraftRecord,
} from '../../src/files/draftStore.js';
import { hashOf } from '../../src/operations/edit.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => removeTempDirectory(directory)),
  );
});

async function removeTempDirectory(directory: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 25));
    }
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-drafts-'));
  temporaryDirectories.push(root);
  return root;
}

async function writeDraftFile(
  root: string,
  id: string,
  lines: string[],
): Promise<string> {
  const file = draftFilePath(root, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function draftOrThrow(outcome: {
  draft: DraftRecord | null;
  contentHash: string | null;
}): DraftRecord {
  if (outcome.draft === null) {
    throw new Error(`Expected a draft, got: ${JSON.stringify(outcome)}`);
  }
  return outcome.draft;
}

const survivorLines = [
  'id: draft_abc123def456',
  'message: Restart survivor',
  'projects: []',
  'attachments: []',
  'created: 2019-01-01T00:00:00.000Z',
  'updated: 2020-01-01T00:00:00.000Z',
];

describe('draft store', () => {
  it('creates a draft with defaults and round-trips it through load', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, {});
    const draft = draftOrThrow(created);
    expect(draft.id).toMatch(/^draft_[a-z0-9]{12}$/);
    expect(draft.message).toBe('');
    expect(draft.projects).toEqual([]);
    expect(draft.attachments).toEqual([]);
    expect(draft.backend).toBeUndefined();
    expect(draft.consumed).toBeUndefined();
    expect(draft.created).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(draft.updated).toBe(draft.created);

    const loaded = await loadDraft(root, draft.id);
    expect(loaded.draft).toEqual(draft);
    expect(loaded.contentHash).toBe(created.contentHash);
    expect(await fileExists(draftFilePath(root, draft.id))).toBe(true);
  });

  it('round-trips every field through the YAML file', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, {
      message: 'Plan the whiteboard refresh\n\nAlso share the notes.',
      projects: ['project_evon'],
      backend: 'research-model',
      attachments: [{ id: 'task_lab_refresh' }, { path: 'inbox/notes.md' }],
    });
    const draft = draftOrThrow(created);
    expect(draft.message).toBe(
      'Plan the whiteboard refresh\n\nAlso share the notes.',
    );
    expect(draft.projects).toEqual(['project_evon']);
    expect(draft.backend).toBe('research-model');
    expect(draft.attachments).toEqual([
      { id: 'task_lab_refresh' },
      { path: 'inbox/notes.md' },
    ]);

    const source = await readFile(draftFilePath(root, draft.id), 'utf8');
    expect(source).toContain(`id: ${draft.id}`);
    expect(source).toContain('backend: research-model');
    expect(source).toContain('- project_evon');
    expect(source).toContain('- id: task_lab_refresh');
    expect(source).toContain('- path: inbox/notes.md');

    const loaded = await loadDraft(root, draft.id);
    expect(loaded.draft).toEqual(draft);
  });

  it('lists and loads drafts from a fresh disk read', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, { message: 'Fresh draft' });
    const draft = draftOrThrow(created);
    await writeDraftFile(root, 'draft_abc123def456', survivorLines);

    const listed = await listDrafts(root);
    expect(listed.diagnostics).toEqual([]);
    expect(listed.drafts.map((entry) => entry.draft.id)).toEqual([
      draft.id,
      'draft_abc123def456',
    ]);
    expect(listed.drafts.map((entry) => entry.draft.message)).toEqual([
      'Fresh draft',
      'Restart survivor',
    ]);

    const loaded = await loadDraft(root, 'draft_abc123def456');
    expect(loaded.draft?.message).toBe('Restart survivor');
    expect(loaded.draft?.created).toBe('2019-01-01T00:00:00.000Z');
  });

  it('preserves unknown top-level keys through updates', async () => {
    const root = await makeRoot();
    const file = await writeDraftFile(root, 'draft_abc123def456', [
      ...survivorLines.slice(0, 4),
      'priority: high',
      'created: 2019-01-01T00:00:00.000Z',
      'updated: 2020-01-01T00:00:00.000Z',
    ]);
    const before = await readFile(file);

    const updated = await updateDraft(root, {
      id: 'draft_abc123def456',
      expectedHash: hashOf(before),
      patch: { message: 'Edited message' },
    });
    expect(updated.draft?.message).toBe('Edited message');

    const after = await readFile(file, 'utf8');
    expect(after).toContain('priority: high');
    expect(after).toContain('message: Edited message');
    expect(after).toContain('id: draft_abc123def456');
  });

  it('lazily deletes consumed drafts on load and reports them missing', async () => {
    const root = await makeRoot();
    const file = await writeDraftFile(root, 'draft_abc123def456', [
      ...survivorLines,
      'consumed: true',
    ]);

    const loaded = await loadDraft(root, 'draft_abc123def456');
    expect(loaded.draft).toBeNull();
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
    expect(await fileExists(file)).toBe(false);
  });

  it('excludes and lazily deletes consumed drafts on list', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, { message: 'Live draft' });
    const draft = draftOrThrow(created);
    const consumedFile = await writeDraftFile(root, 'draft_abc123def456', [
      ...survivorLines,
      'consumed: true',
    ]);

    const listed = await listDrafts(root);
    expect(listed.drafts.map((entry) => entry.draft.id)).toEqual([draft.id]);
    expect(await fileExists(consumedFile)).toBe(false);
  });

  it('rejects a stale hash without writing', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, { message: 'Original' });
    const draft = draftOrThrow(created);
    const file = draftFilePath(root, draft.id);
    const before = await readFile(file);

    const updated = await updateDraft(root, {
      id: draft.id,
      expectedHash: '0'.repeat(64),
      patch: { message: 'Should not land' },
    });
    expect(updated.draft).toBeNull();
    expect(updated.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.stale_hash',
    ]);
    expect(await readFile(file)).toEqual(before);
  });

  it('merges a patch and bumps updated', async () => {
    const root = await makeRoot();
    const file = await writeDraftFile(root, 'draft_abc123def456', [
      'id: draft_abc123def456',
      'message: Original',
      'projects:',
      '- project_evon',
      'backend: research-model',
      'attachments:',
      '- id: task_lab_refresh',
      'created: 2019-01-01T00:00:00.000Z',
      'updated: 2020-01-01T00:00:00.000Z',
    ]);

    const updated = await updateDraft(root, {
      id: 'draft_abc123def456',
      expectedHash: hashOf(await readFile(file)),
      patch: { message: 'New message' },
    });
    expect(updated.draft?.message).toBe('New message');
    expect(updated.draft?.projects).toEqual(['project_evon']);
    expect(updated.draft?.backend).toBe('research-model');
    expect(updated.draft?.attachments).toEqual([{ id: 'task_lab_refresh' }]);
    expect(updated.draft?.created).toBe('2019-01-01T00:00:00.000Z');
    expect(updated.draft?.updated).not.toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(updated.draft?.updated ?? '').getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );

    const source = await readFile(file, 'utf8');
    expect(source).toContain('message: New message');
    expect(source).toContain('- project_evon');
    expect(source).toContain('backend: research-model');
    expect(source).toContain('created: 2019-01-01T00:00:00.000Z');
    expect(source).not.toContain('updated: 2020-01-01T00:00:00.000Z');
  });

  it('replaces projects, backend, and attachments through a patch', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, {
      message: 'Original',
      projects: ['project_evon'],
      backend: 'research-model',
      attachments: [{ id: 'task_lab_refresh' }],
    });
    const draft = draftOrThrow(created);

    const updated = await updateDraft(root, {
      id: draft.id,
      expectedHash: created.contentHash ?? '',
      patch: {
        projects: ['project_soap'],
        backend: 'local-agent',
        attachments: [{ id: 'task_scaling_review' }],
      },
    });
    expect(updated.draft?.projects).toEqual(['project_soap']);
    expect(updated.draft?.backend).toBe('local-agent');
    expect(updated.draft?.attachments).toEqual([{ id: 'task_scaling_review' }]);
    expect(updated.draft?.message).toBe('Original');

    const loaded = await loadDraft(root, draft.id);
    expect(loaded.draft?.projects).toEqual(['project_soap']);
  });

  it('deletes drafts and reports missing ids', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, { message: 'Bye' });
    const draft = draftOrThrow(created);
    const file = draftFilePath(root, draft.id);

    const removed = await deleteDraft(root, draft.id);
    expect(removed.deleted).toBe(true);
    expect(await fileExists(file)).toBe(false);

    const missing = await deleteDraft(root, draft.id);
    expect(missing.deleted).toBe(false);
    expect(missing.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
  });

  it('rejects invalid draft ids without touching disk', async () => {
    const root = await makeRoot();
    for (const id of [
      'nope',
      'draft_short',
      '../escape',
      'draft_ABCDEF123456',
    ]) {
      const loaded = await loadDraft(root, id);
      expect(loaded.diagnostics.map((entry) => entry.code)).toEqual([
        'draft.missing',
      ]);
      const removed = await deleteDraft(root, id);
      expect(removed.diagnostics.map((entry) => entry.code)).toEqual([
        'draft.missing',
      ]);
      const updated = await updateDraft(root, {
        id,
        expectedHash: '0'.repeat(64),
        patch: { message: 'Nope' },
      });
      expect(updated.diagnostics.map((entry) => entry.code)).toEqual([
        'draft.missing',
      ]);
    }
    expect(await fileExists(path.join(root, '.workspace'))).toBe(false);
  });

  it('marks a draft consumed and reports it missing afterwards', async () => {
    const root = await makeRoot();
    const created = await createDraft(root, { message: 'Halfway there' });
    const draft = draftOrThrow(created);
    const file = draftFilePath(root, draft.id);

    const marked = await markDraftConsumed(root, draft.id);
    expect(marked.draft?.consumed).toBe(true);
    expect(await fileExists(file)).toBe(true);
    const source = await readFile(file, 'utf8');
    expect(source).toContain('consumed: true');
    expect(source).toContain(`updated: ${draft.updated}`);

    const loaded = await loadDraft(root, draft.id);
    expect(loaded.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.missing',
    ]);
    expect(await fileExists(file)).toBe(false);

    const consumedAgain = await markDraftConsumed(root, draft.id);
    expect(consumedAgain.draft).toBeNull();
  });

  it('reports unreadable and invalid draft files', async () => {
    const root = await makeRoot();
    await writeDraftFile(root, 'draft_abc123def456', ['id: [']);
    await writeDraftFile(root, 'draft_abc123def457', [
      'id: draft_abc123def457',
      'message: 42',
      'projects: []',
      'attachments: []',
      'created: 2019-01-01T00:00:00.000Z',
      'updated: 2020-01-01T00:00:00.000Z',
    ]);

    const unreadable = await loadDraft(root, 'draft_abc123def456');
    expect(unreadable.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.unreadable',
    ]);
    const invalid = await loadDraft(root, 'draft_abc123def457');
    expect(invalid.diagnostics.map((entry) => entry.code)).toEqual([
      'draft.invalid',
    ]);

    const listed = await listDrafts(root);
    expect(listed.drafts).toEqual([]);
    expect(listed.diagnostics.map((entry) => entry.code).sort()).toEqual([
      'draft.invalid',
      'draft.unreadable',
    ]);
  });
});
