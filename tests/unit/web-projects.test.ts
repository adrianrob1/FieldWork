import { describe, expect, it } from 'vitest';

import type { DiagnosticView } from '../../web/src/shared/types.js';
import {
  chatCountLabel,
  chatDateOf,
  fileCountLabel,
  newProjectPayload,
  ownedFilesTotalSize,
  projectFormErrorsOf,
  projectRepoLabel,
  projectRowMeta,
  repositoryName,
  repositoryPayload,
  repositoryStateLabel,
  toChatListEntries,
  toProjectDetail,
  toProjectListEntries,
  type RepositoryEntry,
} from '../../web/src/pages/projectsModel.js';

const now = new Date(2026, 8, 10, 10, 0, 0);
const sameDay = new Date(2026, 8, 10, 9, 30, 0).toISOString();
const hash = 'ab'.repeat(32);

function repositoryOf(overrides: Partial<RepositoryEntry>): RepositoryEntry {
  return {
    id: 'resource_repo_evon',
    title: 'evon',
    path: null,
    state: 'live',
    ...overrides,
  };
}

function diagnosticOf(
  fieldPath: string | null,
  message: string,
): DiagnosticView {
  return {
    code: 'schema.invalid',
    severity: 'error',
    file: 'project.yml',
    fieldPath,
    message,
    line: null,
    column: null,
  };
}

describe('toProjectListEntries', () => {
  it('parses repository accessibility and paths', () => {
    const projects = toProjectListEntries({
      projects: [
        {
          id: 'project_evon',
          title: 'Evolutionary optimization',
          summary: 'Surrogates.',
          topics: ['topic_preconditioning'],
          path: 'projects/evon/project.yml',
          repositories: [
            {
              id: 'resource_repo_evon',
              title: null,
              storedPath: '../../repositories/evon',
              resolvedPath: 'C:/w/repositories/evon',
              accessible: true,
            },
            {
              id: 'resource_repo_gone',
              title: 'gone',
              storedPath: '../gone',
              resolvedPath: null,
              accessible: false,
            },
          ],
        },
      ],
    });
    expect(projects).toHaveLength(1);
    expect(projects[0]?.repositories[0]?.state).toBe('live');
    expect(projects[0]?.repositories[0]?.path).toBe('C:/w/repositories/evon');
    expect(projects[0]?.repositories[1]?.state).toBe('missing');
  });

  it('tolerates malformed bodies', () => {
    expect(toProjectListEntries(null)).toEqual([]);
    expect(toProjectListEntries({ projects: 'nope' })).toEqual([]);
    expect(toProjectListEntries({ projects: [{ title: 'no id' }] })).toEqual(
      [],
    );
  });
});

describe('toProjectDetail', () => {
  it('parses the live detail shape', () => {
    const detail = toProjectDetail({
      id: 'project_evon',
      title: 'Evolutionary optimization',
      summary: 'Surrogates.',
      topics: ['topic_preconditioning'],
      path: 'projects/evon/project.yml',
      repositories: [
        {
          id: 'resource_repo_evon',
          path: 'C:/w/repositories/evon',
          exists: true,
        },
        { id: 'resource_repo_gone', path: 'C:/w/gone', exists: false },
      ],
      resources: [
        {
          id: 'resource_posterior',
          title: 'Posterior update notes',
          kind: 'resource',
          path: 'projects/evon/context/posterior.md',
          targetPath: null,
          url: null,
        },
      ],
      chats: [{ id: 'chat_rank', title: 'Rank diagnostics', created: sameDay }],
      summaryDocument: {
        path: 'projects/evon/README.md',
        title: 'Evolutionary optimization',
        body: 'Body.',
      },
      chatCount: 1,
      ownedFiles: [
        {
          path: 'projects/evon/README.md',
          kind: 'summary',
          title: 'Evolutionary optimization',
          sizeBytes: 348,
          modifiedAt: sameDay,
        },
      ],
      lastActivity: sameDay,
      inboundReferences: [
        {
          sourceKind: 'chat',
          sourceId: 'chat_rank',
          sourceTitle: 'Rank diagnostics',
          sourcePath: 'chats/rank.md',
          relation: 'project',
        },
      ],
      contentHash: hash,
    });
    expect(detail.repositories[0]?.state).toBe('live');
    expect(detail.repositories[1]?.state).toBe('missing');
    expect(detail.summaryDocument?.path).toBe('projects/evon/README.md');
    expect(detail.ownedFiles[0]?.sizeBytes).toBe(348);
    expect(detail.inboundReferences[0]?.sourceId).toBe('chat_rank');
    expect(detail.contentHash).toBe(hash);
  });

  it('tolerates malformed bodies', () => {
    const detail = toProjectDetail(null);
    expect(detail.id).toBe('');
    expect(detail.repositories).toEqual([]);
    expect(detail.chats).toEqual([]);
    expect(detail.summaryDocument).toBeNull();
    expect(detail.contentHash).toBeNull();
  });
});

describe('repositoryStateLabel', () => {
  it('shows none for an empty list', () => {
    expect(repositoryStateLabel([])).toEqual({ text: 'none', className: '' });
  });

  it('shows the name and state for one repository', () => {
    expect(repositoryStateLabel([repositoryOf({})])).toEqual({
      text: 'evon · live',
      className: 'proj',
    });
    expect(
      repositoryStateLabel([repositoryOf({ title: null, state: 'missing' })]),
    ).toEqual({ text: 'resource_repo_evon · missing', className: 'inbox' });
  });

  it('appends the remaining count for several repositories', () => {
    expect(
      repositoryStateLabel([repositoryOf({}), repositoryOf({ id: 'r2' })]),
    ).toEqual({ text: 'evon · live +1', className: 'proj' });
  });

  it('names unnamed repositories by id', () => {
    expect(repositoryName(repositoryOf({ title: null }))).toBe(
      'resource_repo_evon',
    );
  });

  it('prefers a title, then the path basename, then the id', () => {
    expect(repositoryName(repositoryOf({ title: 'Evon' }))).toBe('Evon');
    expect(
      repositoryName(
        repositoryOf({
          title: null,
          path: 'C:\\w\\repositories\\evon',
        }),
      ),
    ).toBe('evon');
    expect(
      repositoryName(repositoryOf({ title: null, path: 'repositories/evon' })),
    ).toBe('evon');
    expect(repositoryName(repositoryOf({ title: null, path: null }))).toBe(
      'resource_repo_evon',
    );
  });
});

describe('projectRepoLabel', () => {
  it('returns null when the project has no repositories', () => {
    expect(projectRepoLabel([])).toBeNull();
  });

  it('shows the repository name while it is live', () => {
    expect(projectRepoLabel([repositoryOf({})])).toBe('repo evon');
  });

  it('shows archived once the repository is missing', () => {
    expect(projectRepoLabel([repositoryOf({ state: 'missing' })])).toBe(
      'repo archived',
    );
    expect(projectRepoLabel([repositoryOf({ state: 'unknown' })])).toBe(
      'repo archived',
    );
  });
});

describe('project meta labels', () => {
  it('formats counts with singular and plural nouns', () => {
    expect(chatCountLabel(1)).toBe('1 chat');
    expect(chatCountLabel(4)).toBe('4 chats');
    expect(fileCountLabel(1)).toBe('1 file');
    expect(fileCountLabel(6)).toBe('6 files');
  });

  it('builds the mobile meta line', () => {
    expect(projectRowMeta(4, 6, sameDay, now)).toBe(
      '4 chats · 6 files · 09:30',
    );
    expect(projectRowMeta(1, 1, null, now)).toBe('1 chat · 1 file');
  });

  it('totals owned file sizes', () => {
    expect(
      ownedFilesTotalSize([
        {
          path: 'a',
          kind: 'summary',
          title: 'a',
          sizeBytes: 100,
          modifiedAt: sameDay,
        },
        {
          path: 'b',
          kind: 'resource',
          title: 'b',
          sizeBytes: 250,
          modifiedAt: sameDay,
        },
      ]),
    ).toBe(350);
  });

  it('prefers updated over created for chat dates', () => {
    const base = {
      id: 'c',
      title: 'C',
      created: '2026-01-01',
      updated: null,
      projects: [],
      topics: [],
      provider: null,
      model: null,
      path: 'c.md',
    };
    expect(chatDateOf(base)).toBe('2026-01-01');
    expect(chatDateOf({ ...base, updated: '2026-09-10' })).toBe('2026-09-10');
  });
});

describe('toChatListEntries', () => {
  it('parses chats and drops malformed entries', () => {
    const chats = toChatListEntries({
      chats: [{ id: 'c1', title: 'One', projects: ['p1'] }, { title: 'no id' }],
    });
    expect(chats).toHaveLength(1);
    expect(chats[0]?.projects).toEqual(['p1']);
  });
});

describe('newProjectPayload', () => {
  it('builds a minimal payload', () => {
    expect(
      newProjectPayload({
        title: ' New ',
        directory: 'new-dir',
        repositoryPath: '',
      }),
    ).toEqual({ ok: true, payload: { title: 'New', directory: 'new-dir' } });
  });

  it('includes an optional repository path', () => {
    const built = newProjectPayload({
      title: 'New',
      directory: 'new-dir',
      repositoryPath: ' repos/x ',
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.repository).toEqual({ path: 'repos/x' });
    }
  });

  it('rejects missing title and directory', () => {
    expect(
      newProjectPayload({ title: '', directory: 'd', repositoryPath: '' }).ok,
    ).toBe(false);
    expect(
      newProjectPayload({ title: 'T', directory: '', repositoryPath: '' }).ok,
    ).toBe(false);
  });
});

describe('repositoryPayload', () => {
  const values = {
    path: ' repositories/evon ',
    id: '',
    title: '',
    remote: '',
  };

  it('builds a minimal payload with the expected hash', () => {
    expect(repositoryPayload(values, hash)).toEqual({
      ok: true,
      payload: { path: 'repositories/evon', expectedHash: hash },
    });
  });

  it('includes the optional metadata fields when set', () => {
    const built = repositoryPayload(
      {
        path: 'repos/evon',
        id: 'resource_repo_evon',
        title: 'evon',
        remote: 'origin',
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload).toEqual({
        path: 'repos/evon',
        expectedHash: hash,
        id: 'resource_repo_evon',
        title: 'evon',
        remote: 'origin',
      });
    }
  });

  it('refuses an empty path or a missing project hash', () => {
    expect(repositoryPayload({ ...values, path: ' ' }, hash).ok).toBe(false);
    expect(repositoryPayload(values, null).ok).toBe(false);
  });
});

describe('projectFormErrorsOf', () => {
  it('maps field paths to the rendered form fields', () => {
    const errors = projectFormErrorsOf([
      diagnosticOf('id', 'The id is taken.'),
      diagnosticOf('title', 'The title is required.'),
      diagnosticOf('repositories.0.path', 'The path is invalid.'),
      diagnosticOf(null, 'Unrelated.'),
    ]);
    expect(errors.id).toEqual(['The id is taken.']);
    expect(errors.title).toEqual(['The title is required.']);
    expect(errors.repositoryPath).toEqual(['The path is invalid.']);
    expect(errors.unassigned.map((entry) => entry.message)).toEqual([
      'Unrelated.',
    ]);
  });

  it('falls back to the quoted field name in the message', () => {
    const errors = projectFormErrorsOf([
      diagnosticOf(
        null,
        "Project directory '../evil' must be a single non-empty directory name.",
      ),
    ]);
    expect(errors.directory).toHaveLength(1);
    expect(errors.unassigned).toEqual([]);
  });
});
