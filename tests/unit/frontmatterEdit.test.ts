import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashOf } from '../../src/operations/edit.js';
import {
  applyBodyEdit,
  applyFrontmatterPatch,
  checkEditPath,
  editableFieldPolicy,
  loadEditableFile,
} from '../../src/operations/frontmatterEdit.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 10 }),
      ),
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-edit-'));
  temporaryDirectories.push(root);
  await write(
    root,
    'chats/sample.md',
    [
      '---',
      'id: chat_sample',
      'title: Sample chat',
      'created: 2026-09-01',
      '# tone of voice',
      'x-custom: keep-me  # sticky note',
      'topics:',
      '  - alpha',
      '---',
      '',
      '# Body',
      '',
      'Body stays byte-identical.',
      '',
    ].join('\n'),
  );
  await write(
    root,
    'topics/overview.md',
    [
      '---',
      'id: summary_overview',
      'title: Overview',
      'kind: topic',
      'keywords:',
      '  - routing',
      '---',
      '',
      'Summary body.',
      '',
    ].join('\n'),
  );
  await write(
    root,
    'projects/demo/project.yml',
    'id: project_demo\ntitle: Demo\n',
  );
  return root;
}

async function write(
  root: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const file = path.join(root, ...relativePath.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function hash(root: string, relativePath: string): Promise<string> {
  return hashOf(await readFile(path.join(root, ...relativePath.split('/'))));
}

function bodySlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(closing);
}

function frontmatterSlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(0, closing);
}

describe('checkEditPath', () => {
  const root = path.resolve(path.sep, 'workspace');

  it('accepts workspace-relative Markdown paths', () => {
    const result = checkEditPath(root, 'chats/notes.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file).toBe(path.resolve(root, 'chats/notes.md'));
    }
    expect(checkEditPath(root, './chats/notes.md').ok).toBe(true);
  });

  it('rejects empty, absolute, tilde, and backslash paths', () => {
    expect(checkEditPath(root, '').ok).toBe(false);
    expect(checkEditPath(root, '   ').ok).toBe(false);
    expect(checkEditPath(root, '/etc/hosts.md').ok).toBe(false);
    expect(checkEditPath(root, '~/notes.md').ok).toBe(false);
    expect(checkEditPath(root, '..\\workspace.yml').ok).toBe(false);
    expect(checkEditPath(root, 'chats\\notes.md').ok).toBe(false);
  });

  it('rejects traversal segments', () => {
    expect(checkEditPath(root, '../workspace.yml').ok).toBe(false);
    expect(checkEditPath(root, 'chats/../workspace.yml').ok).toBe(false);
    expect(checkEditPath(root, 'chats/../../outside.md').ok).toBe(false);
  });
});

describe('loadEditableFile', () => {
  it('returns policy, unknown keys, body, and hash for a chat', async () => {
    const root = await createWorkspace();

    const outcome = await loadEditableFile(root, 'chats/sample.md');

    expect(outcome.status).toBe('ok');
    expect(outcome.view?.kind).toBe('chat');
    expect(outcome.view?.path).toBe('chats/sample.md');
    expect(outcome.view?.metadata.title).toBe('Sample chat');
    expect(outcome.view?.unknownKeys).toEqual(['x-custom']);
    expect(outcome.view?.editableFields).toEqual(editableFieldPolicy.chat);
    expect(outcome.view?.body).toBe('\n# Body\n\nBody stays byte-identical.\n');
    expect(outcome.view?.contentHash).toBe(await hash(root, 'chats/sample.md'));
  });

  it('reports summary kinds for topic summaries', async () => {
    const root = await createWorkspace();

    const outcome = await loadEditableFile(root, 'topics/overview.md');

    expect(outcome.status).toBe('ok');
    expect(outcome.view?.kind).toBe('summary');
    expect(outcome.view?.editableFields).toEqual(editableFieldPolicy.summary);
  });

  it('rejects out-of-scope and missing paths', async () => {
    const root = await createWorkspace();

    const manifest = await loadEditableFile(root, 'projects/demo/project.yml');
    expect(manifest.status).toBe('outOfScope');

    const missing = await loadEditableFile(root, 'chats/nope.md');
    expect(missing.status).toBe('notFound');

    const traversal = await loadEditableFile(root, '../outside.md');
    expect(traversal.status).toBe('outOfScope');
  });
});

describe('applyFrontmatterPatch', () => {
  it('changes allowed fields and preserves unknown keys, comments, and body', async () => {
    const root = await createWorkspace();
    const before = await read(root, 'chats/sample.md');

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Renamed chat', topics: ['alpha', 'beta'] },
      expectedHash: hashOf(Buffer.from(before, 'utf8')),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(true);
    const after = await read(root, 'chats/sample.md');
    expect(after).toContain('title: Renamed chat');
    expect(after).toContain('- alpha');
    expect(after).toContain('- beta');
    expect(after).toContain('x-custom: keep-me');
    expect(after).toContain('sticky note');
    expect(after).toContain('# tone of voice');
    expect(bodySlice(after)).toBe(bodySlice(before));
    expect(await loadEditableFile(root, 'chats/sample.md')).toMatchObject({
      status: 'ok',
      view: { unknownKeys: ['x-custom'] },
    });
  });

  it('removes a field when the change value is null', async () => {
    const root = await createWorkspace();
    await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { provider: 'local' },
      expectedHash: null,
    });
    const before = await read(root, 'chats/sample.md');
    expect(before).toContain('provider: local');

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { provider: null },
      expectedHash: hashOf(Buffer.from(before, 'utf8')),
    });

    expect(outcome.status).toBe('ok');
    expect(await read(root, 'chats/sample.md')).not.toContain('provider');
  });

  it('reports a diagnostic naming each disallowed field', async () => {
    const root = await createWorkspace();
    const before = await hash(root, 'chats/sample.md');

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { id: 'chat_other', created: '2020-01-01' },
      expectedHash: null,
    });

    expect(outcome.status).toBe('invalid');
    expect(
      outcome.diagnostics
        .filter((entry) => entry.code === 'edit.field_not_editable')
        .map((entry) => entry.fieldPath),
    ).toEqual(['id', 'created']);
    expect(await hash(root, 'chats/sample.md')).toBe(before);
  });

  it('refuses invalid values with field paths and leaves the file untouched', async () => {
    const root = await createWorkspace();
    const before = await hash(root, 'chats/sample.md');

    const typed = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 5 },
      expectedHash: null,
    });
    expect(typed.status).toBe('invalid');
    expect(
      typed.diagnostics.some(
        (entry) => entry.severity === 'error' && entry.fieldPath === 'title',
      ),
    ).toBe(true);

    const referenced = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { projects: ['project_nowhere'] },
      expectedHash: null,
    });
    expect(referenced.status).toBe('invalid');
    expect(
      referenced.diagnostics.some(
        (entry) =>
          entry.severity === 'error' && entry.fieldPath === 'projects.0',
      ),
    ).toBe(true);

    expect(await hash(root, 'chats/sample.md')).toBe(before);
  });

  it('reports a stale expected hash as a conflict', async () => {
    const root = await createWorkspace();
    const current = await hash(root, 'chats/sample.md');

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Renamed chat' },
      expectedHash: '0'.repeat(64),
    });

    expect(outcome.status).toBe('conflict');
    expect(outcome.contentHash).toBe(current);
    expect(
      outcome.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
    ).toBe(true);
    expect(await hash(root, 'chats/sample.md')).toBe(current);
  });

  it('accepts an uppercase fresh hash and writes the patch', async () => {
    const root = await createWorkspace();
    const fresh = (await hash(root, 'chats/sample.md')).toUpperCase();

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Renamed chat' },
      expectedHash: fresh,
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(true);
    expect(await read(root, 'chats/sample.md')).toContain(
      'title: Renamed chat',
    );
  });

  it('reports stale hashes as conflicts whether uppercase or lowercase', async () => {
    const root = await createWorkspace();
    const current = await hash(root, 'chats/sample.md');

    const uppercase = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Renamed chat' },
      expectedHash: 'ab'.repeat(32).toUpperCase(),
    });
    const lowercase = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Renamed chat' },
      expectedHash: 'ab'.repeat(32),
    });

    expect(uppercase.status).toBe('conflict');
    expect(uppercase.contentHash).toBe(current);
    expect(
      uppercase.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
    ).toBe(true);
    expect(lowercase.status).toBe('conflict');
    expect(lowercase.contentHash).toBe(current);
    expect(await hash(root, 'chats/sample.md')).toBe(current);
  });

  it('reports a mid-write race as a conflict', async () => {
    const root = await createWorkspace();

    const outcome = await applyFrontmatterPatch(
      root,
      {
        path: 'chats/sample.md',
        changes: { title: 'Renamed chat' },
        expectedHash: null,
      },
      {
        beforeConflictCheck: async (file) => {
          await writeFile(file, `${await readFile(file, 'utf8')}race\n`);
        },
      },
    );

    expect(outcome.status).toBe('conflict');
    expect(
      outcome.diagnostics.some((entry) => entry.code === 'write.conflict'),
    ).toBe(true);
    expect(await read(root, 'chats/sample.md')).toContain('race\n');
  });

  it('refuses the patch when the file changes after the precondition check', async () => {
    const root = await createWorkspace();
    const fresh = await hash(root, 'chats/sample.md');
    const attacker = [
      '---',
      'id: chat_attacker',
      'title: Attacker write',
      '---',
      '',
      'Intervening note from another writer.',
      '',
    ].join('\n');

    const outcome = await applyFrontmatterPatch(
      root,
      {
        path: 'chats/sample.md',
        changes: { title: 'Renamed chat' },
        expectedHash: fresh,
      },
      {
        afterPreconditionCheck: async (file) => {
          await writeFile(file, attacker);
        },
      },
    );

    const attackerHash = hashOf(Buffer.from(attacker, 'utf8'));
    expect(outcome.status).toBe('conflict');
    expect(
      outcome.diagnostics.some((entry) => entry.code === 'write.conflict'),
    ).toBe(true);
    expect(outcome.contentHash).toBe(attackerHash);
    expect(await read(root, 'chats/sample.md')).toBe(attacker);
    expect(await hash(root, 'chats/sample.md')).toBe(attackerHash);
  });

  it('is a no-op when nothing changes', async () => {
    const root = await createWorkspace();
    const before = await hash(root, 'chats/sample.md');

    const outcome = await applyFrontmatterPatch(root, {
      path: 'chats/sample.md',
      changes: { title: 'Sample chat' },
      expectedHash: before,
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(false);
    expect(outcome.contentHash).toBe(before);
  });
});

describe('applyBodyEdit', () => {
  it('replaces the body verbatim and keeps the frontmatter bytes', async () => {
    const root = await createWorkspace();
    const before = await read(root, 'topics/overview.md');

    const outcome = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\n# Overview\n\nRewritten summary body.\n',
      expectedHash: hashOf(Buffer.from(before, 'utf8')),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(true);
    const after = await read(root, 'topics/overview.md');
    expect(frontmatterSlice(after)).toBe(frontmatterSlice(before));
    expect(bodySlice(after)).toBe(
      '\n---\n\n# Overview\n\nRewritten summary body.\n',
    );
  });

  it('normalizes the trailing newline to exactly one', async () => {
    const root = await createWorkspace();

    const outcome = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: 'Trailing text.\n\n\n\n',
      expectedHash: null,
    });

    expect(outcome.status).toBe('ok');
    const after = await read(root, 'topics/overview.md');
    expect(after.endsWith('Trailing text.\n')).toBe(true);
    expect(after.endsWith('Trailing text.\n\n')).toBe(false);
  });

  it('is a no-op for an identical body', async () => {
    const root = await createWorkspace();
    const before = await read(root, 'topics/overview.md');

    const outcome = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\nSummary body.\n',
      expectedHash: hashOf(Buffer.from(before, 'utf8')),
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(false);
    expect(outcome.contentHash).toBe(hashOf(Buffer.from(before, 'utf8')));
  });

  it('refuses stale loads without writing', async () => {
    const root = await createWorkspace();
    const current = await hash(root, 'topics/overview.md');

    const outcome = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\nRewritten.\n',
      expectedHash: 'f'.repeat(64),
    });

    expect(outcome.status).toBe('conflict');
    expect(await hash(root, 'topics/overview.md')).toBe(current);
  });

  it('accepts an uppercase fresh hash and writes the body', async () => {
    const root = await createWorkspace();
    const fresh = (await hash(root, 'topics/overview.md')).toUpperCase();

    const outcome = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\nRewritten.\n',
      expectedHash: fresh,
    });

    expect(outcome.status).toBe('ok');
    expect(outcome.changed).toBe(true);
    expect(await read(root, 'topics/overview.md')).toContain('Rewritten.');
  });

  it('reports stale hashes as conflicts whether uppercase or lowercase', async () => {
    const root = await createWorkspace();
    const current = await hash(root, 'topics/overview.md');

    const uppercase = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\nRewritten.\n',
      expectedHash: 'ab'.repeat(32).toUpperCase(),
    });
    const lowercase = await applyBodyEdit(root, {
      path: 'topics/overview.md',
      body: '\nRewritten.\n',
      expectedHash: 'ab'.repeat(32),
    });

    expect(uppercase.status).toBe('conflict');
    expect(uppercase.contentHash).toBe(current);
    expect(
      uppercase.diagnostics.some((entry) => entry.code === 'edit.stale_hash'),
    ).toBe(true);
    expect(lowercase.status).toBe('conflict');
    expect(lowercase.contentHash).toBe(current);
    expect(await hash(root, 'topics/overview.md')).toBe(current);
  });

  it('refuses the body edit when the file changes after the precondition check', async () => {
    const root = await createWorkspace();
    const fresh = await hash(root, 'topics/overview.md');
    const attacker = 'Intervening note from another writer.\n';

    const outcome = await applyBodyEdit(
      root,
      {
        path: 'topics/overview.md',
        body: '\nRewritten.\n',
        expectedHash: fresh,
      },
      {
        afterPreconditionCheck: async (file) => {
          await writeFile(file, attacker);
        },
      },
    );

    const attackerHash = hashOf(Buffer.from(attacker, 'utf8'));
    expect(outcome.status).toBe('conflict');
    expect(
      outcome.diagnostics.some((entry) => entry.code === 'write.conflict'),
    ).toBe(true);
    expect(outcome.contentHash).toBe(attackerHash);
    expect(await read(root, 'topics/overview.md')).toBe(attacker);
    expect(await hash(root, 'topics/overview.md')).toBe(attackerHash);
  });

  it('rejects out-of-scope paths', async () => {
    const root = await createWorkspace();

    const manifest = await applyBodyEdit(root, {
      path: 'projects/demo/project.yml',
      body: 'text\n',
      expectedHash: null,
    });
    expect(manifest.status).toBe('outOfScope');

    const missing = await applyBodyEdit(root, {
      path: 'chats/nope.md',
      body: 'text\n',
      expectedHash: null,
    });
    expect(missing.status).toBe('notFound');
  });
});
