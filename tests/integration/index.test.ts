import { spawnSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../src/index/database.js';
import { rebuildIndex } from '../../src/index/build.js';
import { runMigrations } from '../../src/index/migrations.js';
import {
  indexDirectory,
  indexNewPath,
  indexOldPath,
  indexPath,
} from '../../src/index/paths.js';
import { refreshIndex } from '../../src/index/refresh.js';
import { searchRepositories } from '../../src/index/repositories.js';
import { searchIndex } from '../../src/index/search.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-index-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
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

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-tmp-'));
  temporaryDirectories.push(directory);
  return directory;
}

function rgAvailable(): boolean {
  const probe = spawnSync('rg', ['--version']);
  return probe.error === undefined && probe.status === 0;
}

describe('migrations', () => {
  it('creates all version 1 tables and records the schema version', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'index.sqlite');
    const database = openDatabase(file);

    const first = runMigrations(database, file);
    const second = runMigrations(database, file);

    expect(first.applied).toEqual([1]);
    expect(first.diagnostics).toEqual([]);
    expect(second.applied).toEqual([]);
    const tables = database
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .map((row) => row.name);
    for (const table of [
      'schema_version',
      'files',
      'objects',
      'references',
      'repositories',
      'documents_fts',
    ]) {
      expect(tables).toContain(table);
    }
    expect(
      database.get<{ version: number }>('SELECT version FROM schema_version')
        ?.version,
    ).toBe(1);
    database.close();
  });

  it('rejects a database from a newer schema version', async () => {
    const directory = await temporaryDirectory();
    const file = path.join(directory, 'index.sqlite');
    const database = openDatabase(file);
    runMigrations(database, file);
    database.run('UPDATE schema_version SET version = 99');

    const outcome = runMigrations(database, file);

    expect(outcome.applied).toEqual([]);
    expect(outcome.diagnostics[0]?.code).toBe('index.schema_version_unknown');
    expect(outcome.diagnostics[0]?.severity).toBe('error');
    database.close();
  });
});

describe('rebuildIndex', () => {
  it('indexes the sample workspace with expected counts', async () => {
    const root = await copySampleWorkspace();

    const result = await rebuildIndex(root);

    expect(result.diagnostics).toEqual([]);
    expect(result.rebuilt).toBe(true);
    expect(result.counts).toEqual({
      files: 18,
      objects: 17,
      references: 20,
      repositories: 2,
      documents: 17,
    });
    await expect(readFile(indexPath(root))).resolves.toBeInstanceOf(Buffer);

    const database = openDatabase(indexPath(root), { readonly: true });
    const byType = database.all<{ type: string; n: number }>(
      'SELECT type, count(*) AS n FROM objects GROUP BY type ORDER BY type',
    );
    expect(Object.fromEntries(byType.map((row) => [row.type, row.n]))).toEqual({
      chat: 3,
      project: 3,
      resource: 2,
      summary: 5,
      task: 4,
    });
    const repositories = database.all<{ id: string; path: string }>(
      'SELECT id, path FROM repositories ORDER BY id',
    );
    expect(repositories.map((row) => row.id)).toEqual([
      'resource_repo_evon',
      'resource_repo_soap_bubbles',
    ]);
    expect(repositories[0]?.path).toBe(path.join(root, 'repositories', 'evon'));
    const files = database.all<{ path: string }>(
      'SELECT path FROM files ORDER BY path',
    );
    expect(files.map((row) => row.path)).toContain('workspace.yml');
    expect(files.map((row) => row.path)).toContain(
      'projects/soap-bubbles/project.yml',
    );
    database.close();
  });

  it('keeps files with parse errors in the inventory but out of the objects table', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'projects/broken/project.yml',
      'id: project_broken\ntitle: 42\n',
    );
    await write(
      root,
      'chats/orphan.md',
      '---\nid: chat_orphan\ntitle: Orphan\ncreated: 2026-09-03\nprojects:\n  - project_broken\n---\nBody\n',
    );

    const result = await rebuildIndex(root);

    expect(result.counts.files).toBe(20);
    expect(result.counts.objects).toBe(18);
    const database = openDatabase(indexPath(root), { readonly: true });
    expect(
      database.get<{ path: string }>(
        'SELECT path FROM files WHERE path = ?',
        'projects/broken/project.yml',
      ),
    ).toBeDefined();
    expect(
      database.get<{ id: string }>(
        'SELECT id FROM objects WHERE id = ?',
        'project_broken',
      ),
    ).toBeUndefined();
    expect(
      database.get<{ id: string }>(
        'SELECT id FROM objects WHERE id = ?',
        'chat_orphan',
      ),
    ).toBeDefined();
    database.close();
    const dangling = result.diagnostics.filter(
      (entry) => entry.code === 'index.reference_dangling',
    );
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.severity).toBe('warning');
    expect(dangling[0]?.message).toContain('project_broken');
  });

  it('rebuilds identically after the index is deleted', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);
    const before = await searchIndex(root, 'preconditioning');

    await rm(indexPath(root));
    const rebuilt = await rebuildIndex(root);
    const after = await searchIndex(root, 'preconditioning');

    expect(rebuilt.counts).toEqual({
      files: 18,
      objects: 17,
      references: 20,
      repositories: 2,
      documents: 17,
    });
    expect(after.hits.length).toBeGreaterThan(0);
    expect(after.hits).toEqual(before.hits);
  });

  it('recovers from a leftover .old file and removes stale .new files', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);
    await rename(indexPath(root), indexOldPath(root));
    await writeFile(indexNewPath(root), 'stale garbage');

    const result = await searchIndex(root, 'preconditioning');

    expect(result.diagnostics).toEqual([]);
    expect(result.hits.length).toBeGreaterThan(0);
    await expect(readdir(indexDirectory(root))).resolves.toEqual([
      'index.sqlite',
    ]);
  });

  it('leaves the previous index untouched when the build fails', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);
    const before = await searchIndex(root, 'preconditioning');

    const result = await rebuildIndex(root, {
      parse: () => Promise.reject(new Error('injected failure')),
    });

    expect(result.rebuilt).toBe(false);
    expect(
      result.diagnostics.some(
        (entry) =>
          entry.code === 'index.rebuild_failed' && entry.severity === 'error',
      ),
    ).toBe(true);
    const after = await searchIndex(root, 'preconditioning');
    expect(after.hits).toEqual(before.hits);
    await expect(readdir(indexDirectory(root))).resolves.toEqual([
      'index.sqlite',
    ]);
  });
});

describe('refreshIndex', () => {
  it('rebuilds when the index is missing', async () => {
    const root = await copySampleWorkspace();

    const result = await refreshIndex(root);

    expect(result.rebuilt).toBe(true);
    expect(result.counts.objects).toBe(17);
  });

  it('is a no-op when nothing changed', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await refreshIndex(root);

    expect(result.rebuilt).toBe(false);
    expect(result.diagnostics).toEqual([]);
    expect(result.counts).toEqual({
      files: 18,
      objects: 17,
      references: 20,
      repositories: 2,
      documents: 17,
    });
  });

  it('reindexes changed, added, and deleted files without a full rebuild', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);
    const chat = await readFile(
      path.join(root, 'chats/2026-09-02-rank-diagnostics.md'),
      'utf8',
    );
    await write(
      root,
      'chats/2026-09-02-rank-diagnostics.md',
      chat
        .replace(
          '  - topic_preconditioning',
          '  - topic_preconditioning\n  - topic_refresh_label',
        )
        .replace('became the basis', 'became the zephyr basis'),
    );
    await write(
      root,
      'chats/2026-09-03-new-chat.md',
      '---\nid: chat_new\ntitle: New chat\ncreated: 2026-09-03\nprojects:\n  - project_soap_bubbles\n---\n\nA quartz lantern note.\n',
    );
    await rm(path.join(root, 'chats/2026-09-02-shared-curvature.md'));

    const result = await refreshIndex(root);

    expect(result.rebuilt).toBe(false);
    expect(result.counts.files).toBe(18);
    expect(result.counts.objects).toBe(17);
    const changed = await searchIndex(root, 'zephyr');
    expect(changed.hits).toHaveLength(1);
    expect(changed.hits[0]?.path).toBe('chats/2026-09-02-rank-diagnostics.md');
    const topicScoped = await searchIndex(root, 'zephyr', {
      kind: 'topic',
      topic: 'topic_refresh_label',
    });
    expect(topicScoped.hits).toHaveLength(1);
    const added = await searchIndex(root, 'quartz');
    expect(added.hits.map((hit) => hit.objectId)).toEqual(['chat_new']);
    const removed = await searchIndex(root, 'curvature');
    expect(
      removed.hits.some((hit) => hit.path.includes('shared-curvature')),
    ).toBe(false);
    const membership = await searchIndex(root, 'quartz', {
      kind: 'project',
      projectId: 'project_soap_bubbles',
    });
    expect(membership.hits).toHaveLength(1);
  });
});

describe('searchIndex', () => {
  it('finds objects across the workspace and reports snippets', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await searchIndex(root, 'matrix');

    expect(result.hits.length).toBeGreaterThan(0);
    const paths = result.hits.map((hit) => hit.path);
    expect(
      paths.some((hit) =>
        hit.startsWith('projects/evolutionary-optimization/'),
      ),
    ).toBe(true);
    expect(paths.some((hit) => hit.startsWith('projects/soap-bubbles/'))).toBe(
      true,
    );
    expect(result.hits[0]?.snippet).toMatch(/\[matrix\]/i);
    expect(result.hits[0]?.objectId).not.toBeNull();
    const ranks = result.hits.map((hit) => hit.rank);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  it('scopes a search to a project tree plus referencing objects', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const scoped = await searchIndex(root, 'matrix', {
      kind: 'project',
      projectId: 'project_evon',
    });

    expect(scoped.hits.length).toBeGreaterThan(0);
    for (const hit of scoped.hits) {
      const inTree = hit.path.startsWith('projects/evolutionary-optimization/');
      const referencing = [
        'chat_rank_diagnostics',
        'chat_shared_curvature',
        'resource_evon_posterior',
        'summary_evon',
      ].includes(hit.objectId ?? '');
      expect(inTree || referencing).toBe(true);
      expect(hit.path.startsWith('projects/soap-bubbles/')).toBe(false);
    }
    const attachedChat = await searchIndex(root, 'curvature', {
      kind: 'project',
      projectId: 'project_evon',
    });
    expect(
      attachedChat.hits.some((hit) => hit.objectId === 'chat_shared_curvature'),
    ).toBe(true);
  });

  it('reports a project.missing diagnostic for an unknown project scope', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await searchIndex(root, 'matrix', {
      kind: 'project',
      projectId: 'project_unknown',
    });

    expect(result.hits).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('project.missing');
    expect(result.diagnostics[0]?.severity).toBe('error');
  });

  it('scopes a search to a topic label', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await searchIndex(root, 'statistics', {
      kind: 'topic',
      topic: 'topic_preconditioning',
    });

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect([
        'chat_rank_diagnostics',
        'chat_shared_curvature',
        'resource_evon_posterior',
        'resource_soap_scaling',
        'project_evon',
        'project_posterior_diagnostics',
        'project_soap_bubbles',
      ]).toContain(hit.objectId);
    }
  });

  it('scopes a search to a path prefix', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await searchIndex(root, 'matrix', {
      kind: 'path',
      prefix: 'projects/soap-bubbles',
    });

    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      expect(hit.path.startsWith('projects/soap-bubbles/')).toBe(true);
    }
  });

  it.each(['"unbalanced', '*', 'NEAR ('])(
    'does not throw or misbehave for query %j',
    async (query) => {
      const root = await copySampleWorkspace();
      await rebuildIndex(root);

      const result = await searchIndex(root, query);

      expect(result.diagnostics).toEqual([]);
      expect(result.hits).toEqual([]);
    },
  );

  it('reports index.missing when there is no index', async () => {
    const root = await copySampleWorkspace();

    const result = await searchIndex(root, 'matrix');

    expect(result.hits).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe('index.missing');
  });
});

describe('searchRepositories', () => {
  it('reports rg.missing when ripgrep is not on PATH', async () => {
    const root = await copySampleWorkspace();
    const nowhere = await temporaryDirectory();
    const original = process.env.PATH;
    process.env.PATH = nowhere;
    try {
      const result = await searchRepositories(root, 'matrix');

      expect(result.rgAvailable).toBe(false);
      expect(result.matches).toEqual([]);
      expect(
        result.diagnostics.some(
          (entry) =>
            entry.code === 'rg.missing' &&
            entry.message.includes('https://github.com/BurntSushi/ripgrep'),
        ),
      ).toBe(true);
    } finally {
      process.env.PATH = original;
    }
  });

  it.runIf(rgAvailable())(
    'finds matches in registered repositories with file and line',
    async () => {
      const root = await copySampleWorkspace();

      const result = await searchRepositories(root, 'stand-in');

      expect(result.rgAvailable).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.counts).toEqual({
        resource_repo_evon: 1,
        resource_repo_soap_bubbles: 1,
      });
      expect(result.matches).toHaveLength(2);
      const evon = result.matches.find(
        (match) => match.repositoryId === 'resource_repo_evon',
      );
      expect(evon?.path).toBe('README.md');
      expect(evon?.line).toBe(1);
      expect(evon?.text).toContain('EVON repository stand-in');
    },
  );

  it.runIf(rgAvailable())(
    'restricts the search to the given repository IDs',
    async () => {
      const root = await copySampleWorkspace();

      const result = await searchRepositories(root, 'stand-in', {
        repositories: ['resource_repo_evon'],
      });

      expect(result.rgAvailable).toBe(true);
      expect(result.diagnostics).toEqual([]);
      expect(result.counts).toEqual({ resource_repo_evon: 1 });
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.repositoryId).toBe('resource_repo_evon');
    },
  );

  it.runIf(rgAvailable())(
    'respects ignore files inside repositories',
    async () => {
      const root = await copySampleWorkspace();
      await mkdir(path.join(root, 'repositories/evon/.git'));
      await write(root, 'repositories/evon/.gitignore', 'secret.txt\n');
      await write(root, 'repositories/evon/secret.txt', 'needle hidden\n');
      await write(root, 'repositories/evon/visible.txt', 'needle visible\n');

      const result = await searchRepositories(root, 'needle');

      expect(result.rgAvailable).toBe(true);
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.repositoryId).toBe('resource_repo_evon');
      expect(result.matches[0]?.path).toBe('visible.txt');
      expect(result.matches[0]?.line).toBe(1);
    },
  );
});
