import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import { openDatabase } from '../../src/index/database.js';
import { indexPath } from '../../src/index/paths.js';
import { repositoryIdsForProject } from '../../src/index/repositories.js';
import { hashOf } from '../../src/operations/edit.js';
import { startServer, type ServerHandle } from '../../src/server/server.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: ServerHandle[] = [];
const serverTestTimeout = 20_000;

afterEach(async () => {
  await Promise.all(runningHandles.splice(0).map((handle) => handle.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-register-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split('/')), 'utf8');
}

async function hash(root: string, relativePath: string): Promise<string> {
  return hashOf(await readFile(path.join(root, ...relativePath.split('/'))));
}

async function startTestServer(root?: string): Promise<{
  root: string;
  baseUrl: string;
}> {
  const workspaceRoot = root ?? (await copySampleWorkspace());
  const handle = await startServer(workspaceRoot, {
    host: '127.0.0.1',
    port: 0,
  });
  runningHandles.push(handle);
  return { root: workspaceRoot, baseUrl: handle.url };
}

async function getJson(
  baseUrl: string,
  route: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`);
  const body: unknown = await response.json();
  return { status: response.status, body };
}

async function postJson(
  baseUrl: string,
  route: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

interface FailureBody {
  error: string;
  diagnostics: Diagnostic[];
  currentHash?: string | null;
}

interface ProjectCreateBody {
  project: {
    id: string;
    title: string;
    directory: string;
    path: string;
    repositories: {
      id: string;
      path: string;
      title?: string;
      remote?: string;
      default_branch?: string;
    }[];
  };
  diagnostics: Diagnostic[];
}

describe('project registration API', () => {
  it(
    'creates a project manifest visible in the workspace',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/projects', {
        title: 'Field notes',
        directory: 'field-notes',
        id: 'project_field_notes',
      });
      const view = body as ProjectCreateBody;

      expect(status).toBe(201);
      expect(view.project).toEqual({
        id: 'project_field_notes',
        title: 'Field notes',
        directory: 'field-notes',
        path: 'projects/field-notes/project.yml',
        repositories: [],
      });
      expect(
        view.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const manifest = await read(root, 'projects/field-notes/project.yml');
      expect(manifest).toBe('id: project_field_notes\ntitle: Field notes\n');

      const listed = await getJson(baseUrl, '/api/projects');
      const listView = listed.body as {
        projects: { id: string; title: string }[];
      };
      expect(
        listView.projects.some(
          (project) => project.id === 'project_field_notes',
        ),
      ).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'derives the project id from the title when it is omitted',
    async () => {
      const { baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/projects', {
        title: 'Derived notes',
        directory: 'derived-notes',
      });
      const view = body as ProjectCreateBody;

      expect(status).toBe(201);
      expect(view.project.id).toBe('project_derived_notes');
      expect(view.project.title).toBe('Derived notes');
    },
    serverTestTimeout,
  );

  it(
    'creates a project with a path-only repository entry',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/projects', {
        title: 'Repo notes',
        directory: 'repo-notes',
        id: 'project_repo_notes',
        repository: { path: 'external/field-data' },
      });
      const view = body as ProjectCreateBody;

      expect(status).toBe(201);
      expect(view.project.repositories).toEqual([
        { id: 'resource_repo_field_data', path: '../../external/field-data' },
      ]);

      const manifest = await read(root, 'projects/repo-notes/project.yml');
      expect(manifest).toContain('id: resource_repo_field_data');
      expect(manifest).toContain('path: ../../external/field-data');
    },
    serverTestTimeout,
  );

  it(
    'creates a project with an enriched inline repository entry',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const { status, body } = await postJson(baseUrl, '/api/projects', {
        title: 'Enriched notes',
        directory: 'enriched-notes',
        id: 'project_enriched_notes',
        repository: {
          path: 'repositories/evon',
          id: 'resource_repo_enriched_evon',
          title: 'Evon mirror',
          remote: 'https://example.com/evon.git',
          default_branch: 'trunk',
        },
      });
      const view = body as ProjectCreateBody;

      expect(status).toBe(201);
      expect(view.project.repositories).toEqual([
        {
          id: 'resource_repo_enriched_evon',
          path: '../../repositories/evon',
          title: 'Evon mirror',
          remote: 'https://example.com/evon.git',
          default_branch: 'trunk',
        },
      ]);

      const manifest = await read(root, 'projects/enriched-notes/project.yml');
      expect(manifest).toContain('id: resource_repo_enriched_evon');
      expect(manifest).toContain('path: ../../repositories/evon');
      expect(manifest).toContain('title: Evon mirror');
      expect(manifest).toContain('remote: https://example.com/evon.git');
      expect(manifest).toContain('default_branch: trunk');
    },
    serverTestTimeout,
  );

  it(
    'refuses a duplicate directory with 409 operation.target_exists',
    async () => {
      const { baseUrl } = await startTestServer();
      await postJson(baseUrl, '/api/projects', {
        title: 'Field notes',
        directory: 'field-notes',
        id: 'project_field_notes',
      });
      const second = await postJson(baseUrl, '/api/projects', {
        title: 'Other notes',
        directory: 'field-notes',
        id: 'project_other_notes',
      });

      expect(second.status).toBe(409);
      expect((second.body as FailureBody).diagnostics[0]?.code).toBe(
        'operation.target_exists',
      );
    },
    serverTestTimeout,
  );

  it(
    'refuses a duplicate project id with 409 id.duplicate',
    async () => {
      const { baseUrl } = await startTestServer();
      const second = await postJson(baseUrl, '/api/projects', {
        title: 'Evon copy',
        directory: 'evon-copy',
        id: 'project_evon',
      });

      expect(second.status).toBe(409);
      expect((second.body as FailureBody).diagnostics[0]?.code).toBe(
        'id.duplicate',
      );
    },
    serverTestTimeout,
  );

  it(
    'refuses an invalid directory with 422 and a missing title with 400',
    async () => {
      const { baseUrl } = await startTestServer();
      const invalid = await postJson(baseUrl, '/api/projects', {
        title: 'Escape',
        directory: '../escape',
        id: 'project_escape',
      });
      expect(invalid.status).toBe(422);
      expect((invalid.body as FailureBody).diagnostics[0]?.code).toBe(
        'operation.target_invalid',
      );

      const missing = await postJson(baseUrl, '/api/projects', {
        directory: 'no-title',
      });
      expect(missing.status).toBe(400);
    },
    serverTestTimeout,
  );
});

describe('project repository registration API', () => {
  it(
    'appends a derived repository entry and registers it in the index',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const expectedHash = await hash(
        root,
        'projects/soap-bubbles/project.yml',
      );
      const { status, body } = await postJson(
        baseUrl,
        '/api/projects/project_soap_bubbles/repositories',
        { path: 'repositories/evon', expectedHash },
      );
      const view = body as {
        project: {
          id: string;
          title: string;
          repositories: {
            id: string;
            path: string;
            title?: string;
            remote?: string;
            default_branch?: string;
          }[];
        };
        contentHash: string;
        diagnostics: Diagnostic[];
      };

      expect(status).toBe(200);
      expect(view.project.id).toBe('project_soap_bubbles');
      expect(view.project.title).toBe('SOAP-Bubbles');
      expect(view.project.repositories).toEqual([
        {
          id: 'resource_repo_soap_bubbles',
          path: '../../repositories-archive/soap-bubbles',
        },
        { id: 'resource_repo_evon_2', path: '../../repositories/evon' },
      ]);
      expect(view.contentHash).toBe(
        await hash(root, 'projects/soap-bubbles/project.yml'),
      );
      expect(
        view.diagnostics.every((entry) => entry.severity !== 'error'),
      ).toBe(true);

      const manifest = await read(root, 'projects/soap-bubbles/project.yml');
      expect(manifest).toContain('id: resource_repo_evon_2');
      expect(manifest).toContain('path: ../../repositories/evon');

      const database = openDatabase(indexPath(root), { readonly: true });
      try {
        expect(
          repositoryIdsForProject(database, 'project_soap_bubbles'),
        ).toEqual(['resource_repo_evon_2', 'resource_repo_soap_bubbles']);
      } finally {
        database.close();
      }
    },
    serverTestTimeout,
  );

  it(
    'writes an enriched inline entry with title, remote, and default branch',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const expectedHash = await hash(
        root,
        'projects/soap-bubbles/project.yml',
      );
      const { status, body } = await postJson(
        baseUrl,
        '/api/projects/project_soap_bubbles/repositories',
        {
          path: 'external/notes',
          title: 'Notes mirror',
          remote: 'https://example.com/notes.git',
          default_branch: 'main',
          expectedHash,
        },
      );
      const view = body as {
        project: { repositories: { id: string }[] };
      };

      expect(status).toBe(200);
      expect(view.project.repositories.map((entry) => entry.id)).toEqual([
        'resource_repo_soap_bubbles',
        'resource_repo_notes',
      ]);

      const manifest = await read(root, 'projects/soap-bubbles/project.yml');
      expect(manifest).toContain('id: resource_repo_notes');
      expect(manifest).toContain('title: Notes mirror');
      expect(manifest).toContain('remote: https://example.com/notes.git');
      expect(manifest).toContain('default_branch: main');
    },
    serverTestTimeout,
  );

  it(
    'rejects a stale hash with 409 and the current manifest hash',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const currentHash = await hash(root, 'projects/soap-bubbles/project.yml');
      const before = await read(root, 'projects/soap-bubbles/project.yml');

      const stale = await postJson(
        baseUrl,
        '/api/projects/project_soap_bubbles/repositories',
        { path: 'repositories/evon', expectedHash: '0'.repeat(64) },
      );
      const failure = stale.body as FailureBody;

      expect(stale.status).toBe(409);
      expect(failure.diagnostics[0]?.code).toBe('edit.stale_hash');
      expect(failure.currentHash).toBe(currentHash);
      expect(await read(root, 'projects/soap-bubbles/project.yml')).toBe(
        before,
      );

      const missing = await postJson(
        baseUrl,
        '/api/projects/project_soap_bubbles/repositories',
        { path: 'repositories/evon' },
      );
      expect(missing.status).toBe(400);
      expect((missing.body as FailureBody).diagnostics[0]?.code).toBe(
        'edit.hash_required',
      );
    },
    serverTestTimeout,
  );

  it(
    'answers 404 project.missing for an unknown project',
    async () => {
      const { baseUrl } = await startTestServer();
      const response = await postJson(
        baseUrl,
        '/api/projects/project_unknown/repositories',
        { path: 'repositories/evon', expectedHash: '0'.repeat(64) },
      );

      expect(response.status).toBe(404);
      expect((response.body as FailureBody).diagnostics[0]?.code).toBe(
        'project.missing',
      );
    },
    serverTestTimeout,
  );

  it(
    'refuses a repository id that already exists with 409 id.duplicate',
    async () => {
      const { root, baseUrl } = await startTestServer();
      const expectedHash = await hash(
        root,
        'projects/soap-bubbles/project.yml',
      );
      const before = await read(root, 'projects/soap-bubbles/project.yml');

      const response = await postJson(
        baseUrl,
        '/api/projects/project_soap_bubbles/repositories',
        {
          path: 'external/taken',
          id: 'resource_repo_evon',
          expectedHash,
        },
      );

      expect(response.status).toBe(409);
      expect((response.body as FailureBody).diagnostics[0]?.code).toBe(
        'id.duplicate',
      );
      expect(await read(root, 'projects/soap-bubbles/project.yml')).toBe(
        before,
      );
    },
    serverTestTimeout,
  );
});

describe('topics API', () => {
  it('lists topic summaries with chat and object counts', async () => {
    const { baseUrl } = await startTestServer();
    const { status, body } = await getJson(baseUrl, '/api/topics');
    const view = body as {
      topics: {
        id: string;
        title: string;
        summary: string | null;
        path: string;
        updated: string | null;
        chatCount: number;
        objectCount: number;
      }[];
      diagnostics: Diagnostic[];
    };

    expect(status).toBe(200);
    expect(view.topics).toHaveLength(1);
    const topic = view.topics[0];
    expect(topic?.id).toBe('topic_preconditioning');
    expect(topic?.title).toBe('Matrix preconditioning');
    expect(topic?.summary).toBe(
      'Cross-project notes about matrix-valued optimizer statistics.',
    );
    expect(topic?.path).toBe('topics/preconditioning.md');
    expect(topic?.updated).toBe('2026-09-02');
    expect(topic?.chatCount).toBe(2);
    expect(topic?.objectCount).toBe(7);
  });
});
