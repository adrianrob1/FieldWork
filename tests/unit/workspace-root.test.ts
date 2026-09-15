import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveWorkspaceRoot } from '../../src/commands/workspace-root.js';
import { findWorkspaceRoot } from '../../src/files/workspaceRoot.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-root-'));
  temporaryDirectories.push(root);
  return root;
}

describe('workspace root resolution', () => {
  it('uses an explicit workspace path when the directory exists', async () => {
    const root = await createDirectory();

    const resolution = await resolveWorkspaceRoot(root);

    expect(resolution).toEqual({
      root: path.resolve(root),
      source: 'option',
      diagnostic: null,
    });
  });

  it('reports a missing explicit workspace with a diagnostic', async () => {
    const base = await createDirectory();

    const resolution = await resolveWorkspaceRoot(path.join(base, 'missing'));

    expect(resolution.source).toBe('option');
    expect(resolution.diagnostic).toMatchObject({
      code: 'workspace.missing',
      severity: 'error',
    });
  });

  it('finds workspace.yml by walking upward from the current directory', async () => {
    const root = await createDirectory();
    await writeFile(path.join(root, 'workspace.yml'), 'version: 1\n');
    const nested = path.join(root, 'projects', 'one');
    await mkdir(nested, { recursive: true });
    const canonicalRoot = await realpath(root);
    const previous = process.cwd();
    process.chdir(await realpath(nested));
    try {
      const resolution = await resolveWorkspaceRoot();

      expect(resolution).toEqual({
        root: canonicalRoot,
        source: 'settings',
        diagnostic: null,
      });
    } finally {
      process.chdir(previous);
    }
  });

  it('falls back to the current directory when no workspace.yml is found', async () => {
    const isolated = await createDirectory();
    const canonical = await realpath(isolated);
    const previous = process.cwd();
    process.chdir(canonical);
    try {
      const resolution = await resolveWorkspaceRoot();

      expect(resolution).toEqual({
        root: canonical,
        source: 'default',
        diagnostic: null,
      });
    } finally {
      process.chdir(previous);
    }
  });
});

describe('findWorkspaceRoot', () => {
  it('returns the nearest ancestor containing workspace.yml', async () => {
    const root = await createDirectory();
    await writeFile(path.join(root, 'workspace.yml'), 'version: 1\n');

    expect(await findWorkspaceRoot(path.join(root, 'a', 'b'))).toBe(
      path.resolve(root),
    );
  });

  it('returns null when no ancestor contains workspace.yml', async () => {
    const root = await createDirectory();

    expect(await findWorkspaceRoot(root)).toBeNull();
  });
});
