import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseWorkspace } from '../../src/files/workspace.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe('workspace parsing', () => {
  it('parses the Phase 0 sample without errors', async () => {
    const result = await parseWorkspace(
      path.join(repositoryRoot, 'examples/sample-workspace'),
    );

    expect(
      result.diagnostics.filter(({ severity }) => severity === 'error'),
    ).toEqual([]);
    expect(countKinds(result.files)).toEqual({
      workspace: 1,
      project: 3,
      chat: 3,
      resource: 2,
      summary: 5,
      task: 4,
    });
    const evon = result.files.find(
      ({ metadata }) => metadata?.id === 'project_evon',
    );
    expect(evon?.resolvedPaths[0]).toMatchObject({
      fieldPath: 'repositories.0.path',
      accessible: true,
    });
    expect(evon?.resolvedPaths[0]?.resolvedPath).toBe(
      path.join(repositoryRoot, 'examples/sample-workspace/repositories/evon'),
    );
  });

  it('collects schema, duplicate ID, missing reference, and path diagnostics', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'projects/one/project.yml',
      'id: duplicate\ntitle: One\n',
    );
    await write(
      root,
      'projects/two/project.yml',
      'id: duplicate\ntitle: Two\nrepositories:\n  - id: resource_repo\n    path: ../../missing/repo\n',
    );
    await write(
      root,
      'chats/broken.md',
      '---\nid: Bad-ID\ntitle: 42\ncreated: yesterday\nprojects: [missing_project]\n---\nBody\n',
    );

    const result = await parseWorkspace(root);
    const codes = new Set(result.diagnostics.map(({ code }) => code));

    expect(codes.has('id.duplicate')).toBe(true);
    expect(codes.has('reference.missing')).toBe(true);
    expect(codes.has('path.inaccessible')).toBe(true);
    expect([...codes].some((code) => code.startsWith('schema.'))).toBe(true);
    expect(
      result.diagnostics.find(({ code }) => code === 'path.inaccessible')
        ?.severity,
    ).toBe('warning');
  });

  it('uses workspace directory overrides', async () => {
    const root = await createWorkspace(
      'version: 1\npaths:\n  projects: work\n',
    );
    await mkdir(path.join(root, 'work', 'alpha'), { recursive: true });
    await write(
      root,
      'work/alpha/project.yml',
      'id: project_alpha\ntitle: Alpha\n',
    );

    const result = await parseWorkspace(root);

    expect(
      result.files.find(({ kind }) => kind === 'project')?.metadata?.id,
    ).toBe('project_alpha');
  });

  it('keeps metadata and bodies available when unrelated files fail', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'chats/good.md',
      '---\nid: chat_good\ntitle: Good\ncreated: 2026-09-02\nx-extra: kept\n---\nGood body\n',
    );
    await write(root, 'chats/bad.md', '---\nid: [bad\nNo closing boundary\n');

    const result = await parseWorkspace(root);
    const good = result.files.find(
      ({ metadata }) => metadata?.id === 'chat_good',
    );
    const bad = result.files.find(({ file }) => file.endsWith('bad.md'));

    expect(good?.metadata?.['x-extra']).toBe('kept');
    expect(good?.body).toContain('Good body');
    expect(bad?.body).toContain('No closing boundary');
    expect(bad?.diagnostics[0]?.code).toBe('frontmatter.unclosed');
  });

  it('rejects directory overrides that escape the workspace', async () => {
    const root = await createWorkspace();
    const sibling = `outside-${path.basename(root)}`;
    const outside = path.join(root, '..', sibling);
    temporaryDirectories.push(outside);
    await write(
      root,
      'workspace.yml',
      `version: 1\npaths:\n  projects: ../${sibling}\n`,
    );
    await write(outside, 'one/project.yml', 'id: project_one\ntitle: One\n');

    const result = await parseWorkspace(root);

    expect(result.files.some(({ kind }) => kind === 'project')).toBe(false);
    expect(
      result.diagnostics.some(
        ({ code, fieldPath }) =>
          code === 'path.invalid' && fieldPath === 'paths.projects',
      ),
    ).toBe(true);
  });

  it('points duplicate ID diagnostics at the declaring field', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'projects/one/project.yml',
      'id: project_one\ntitle: One\nrepositories:\n  - id: chat_dup\n    path: repo\n',
    );
    await write(
      root,
      'chats/dup.md',
      '---\nid: chat_dup\ntitle: Dup\ncreated: 2026-09-02\n---\nBody\n',
    );

    const result = await parseWorkspace(root);

    const fieldPaths = result.diagnostics
      .filter(({ code }) => code === 'id.duplicate')
      .map(({ fieldPath }) => fieldPath)
      .sort();
    expect(fieldPaths).toEqual(['id', 'repositories.0.id']);
  });

  it('rejects directory overrides that point at the workspace root', async () => {
    const root = await createWorkspace('version: 1\npaths:\n  projects: .\n');
    await write(root, 'note.md', 'No frontmatter\n');

    const result = await parseWorkspace(root);

    expect(result.files.some(({ file }) => file.endsWith('note.md'))).toBe(
      false,
    );
    expect(
      result.diagnostics.some(
        ({ code, fieldPath }) =>
          code === 'path.invalid' && fieldPath === 'paths.projects',
      ),
    ).toBe(true);
  });

  it('reports unreadable directories as diagnostics', async () => {
    const root = await createWorkspace(
      'version: 1\npaths:\n  chats: chats.txt\n',
    );
    await write(root, 'chats.txt', 'not a directory\n');

    const result = await parseWorkspace(root);

    expect(
      result.diagnostics.some(({ code }) => code === 'directory.unreadable'),
    ).toBe(true);
  });

  it('reports files with empty metadata', async () => {
    const root = await createWorkspace();
    await write(root, 'projects/empty/project.yml', '');
    await write(root, 'chats/emptyfm.md', '---\n---\nBody\n');

    const result = await parseWorkspace(root);

    const empty = result.diagnostics.filter(
      ({ code }) => code === 'metadata.empty',
    );
    expect(empty).toHaveLength(2);
    expect(empty.every(({ severity }) => severity === 'error')).toBe(true);
  });

  it('ignores files whose extensions are not lowercase', async () => {
    const root = await createWorkspace();
    await write(
      root,
      'chats/NOTE.MD',
      '---\nid: chat_note\ntitle: Note\ncreated: 2026-09-02\n---\nBody\n',
    );

    const result = await parseWorkspace(root);

    expect(result.files.some(({ file }) => file.endsWith('NOTE.MD'))).toBe(
      false,
    );
  });

  it('scopes link classification to the projects tree', async () => {
    const parent = path.join(os.tmpdir(), 'links');
    await mkdir(parent, { recursive: true });
    temporaryDirectories.push(parent);
    const root = await mkdtemp(path.join(parent, 'ws-'));
    await write(root, 'workspace.yml', 'version: 1\n');
    await Promise.all(
      ['projects', 'chats', 'topics', 'inbox', 'external'].map((name) =>
        mkdir(path.join(root, name)),
      ),
    );
    await write(root, 'projects/one/notes/data.yml', 'key: value\n');

    const result = await parseWorkspace(root);

    expect(result.files.some(({ file }) => file.endsWith('data.yml'))).toBe(
      false,
    );
  });

  it('honors directory overrides when the settings schema fails', async () => {
    const root = await createWorkspace(
      'version: 2\npaths:\n  projects: work\n',
    );
    await write(
      root,
      'work/alpha/project.yml',
      'id: project_alpha\ntitle: Alpha\n',
    );

    const result = await parseWorkspace(root);

    expect(
      result.files.find(({ kind }) => kind === 'project')?.metadata?.id,
    ).toBe('project_alpha');
    expect(
      result.diagnostics.some(({ code }) => code.startsWith('schema.')),
    ).toBe(true);
  });
});

async function createWorkspace(workspace = 'version: 1\n'): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-'));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, 'workspace.yml'), workspace);
  await Promise.all(
    ['projects', 'chats', 'topics', 'inbox', 'external'].map((name) =>
      mkdir(path.join(root, name)),
    ),
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

function countKinds(files: { kind: string }[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of files) result[file.kind] = (result[file.kind] ?? 0) + 1;
  return result;
}
