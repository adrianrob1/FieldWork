import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseWorkspace,
  parseWorkspaceFile,
} from '../../src/files/workspace.js';
import { rebuildIndex } from '../../src/index/build.js';
import { searchIndex } from '../../src/index/search.js';
import { createProgram } from '../../src/cli.js';
import { attachChat } from '../../src/operations/attach.js';
import { detachChat } from '../../src/operations/detach.js';
import { hashOf } from '../../src/operations/edit.js';
import { promoteChat } from '../../src/operations/promote.js';
import { registerProject } from '../../src/operations/register.js';

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-lifecycle-'));
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

async function fileHash(file: string): Promise<string> {
  return hashOf(await readFile(file));
}

async function chatMetadata(
  root: string,
  relativePath: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(root, ...relativePath.split('/'));
  const parsed = await parseWorkspaceFile(file, 'chat', 'chats', root);
  return parsed.metadata;
}

function bodySlice(content: string): string {
  const closing = content.indexOf('\n---\n');
  return closing < 0 ? content : content.slice(closing);
}

function errorsOf(diagnostics: { severity: string }[]): {
  severity: string;
}[] {
  return diagnostics.filter((entry) => entry.severity === 'error');
}

interface CapturedIo {
  out: string[];
  err: string[];
  restore(): void;
}

function captureProcessIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  const stderr = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  return {
    out,
    err,
    restore: () => {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

async function runProgram(
  argv: string[],
): Promise<{ code: number; out: string; err: string }> {
  const io = captureProcessIo();
  const run = createProgram();
  try {
    await run.program.parseAsync(argv, { from: 'user' });
  } finally {
    io.restore();
  }
  return { code: run.exitCode(), out: io.out.join(''), err: io.err.join('') };
}

describe('registerProject', () => {
  it('creates a manifest with inline repositories in a new directory', async () => {
    const root = await copySampleWorkspace();
    const outside = path.join(os.tmpdir(), 'fieldwork-external-repo');

    const result = await registerProject(root, {
      directory: 'field-notes',
      id: 'project_field_notes',
      title: 'Field notes',
      repositories: ['repositories/field', outside],
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    const manifest = path.join(root, 'projects/field-notes/project.yml');
    expect(result.files).toEqual([manifest]);
    expect(result.data).toEqual({
      id: 'project_field_notes',
      title: 'Field notes',
      directory: 'field-notes',
      file: manifest,
      repositories: [
        { id: 'resource_repo_field', path: '../../repositories/field' },
        {
          id: 'resource_repo_fieldwork_external_repo',
          path: outside.split(path.sep).join('/'),
        },
      ],
    });

    const content = await readFile(manifest, 'utf8');
    expect(content).toBe(
      'id: project_field_notes\n' +
        'title: Field notes\n' +
        'repositories:\n' +
        '  - id: resource_repo_field\n' +
        '    path: ../../repositories/field\n' +
        '  - id: resource_repo_fieldwork_external_repo\n' +
        `    path: ${outside.split(path.sep).join('/')}\n`,
    );

    const parsed = await parseWorkspace(root);
    expect(errorsOf(parsed.diagnostics)).toEqual([]);
  });

  it('refuses when the directory already contains a project manifest', async () => {
    const root = await copySampleWorkspace();
    const manifest = path.join(root, 'projects/field-notes/project.yml');
    await registerProject(root, {
      directory: 'field-notes',
      id: 'project_field_notes',
      title: 'Field notes',
      repositories: [],
    });
    const before = await readFile(manifest, 'utf8');

    const second = await registerProject(root, {
      directory: 'field-notes',
      id: 'project_other',
      title: 'Other',
      repositories: [],
    });

    expect(second.success).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.files).toEqual([]);
    expect(second.diagnostics[0]?.code).toBe('operation.target_exists');
    expect(await readFile(manifest, 'utf8')).toBe(before);
  });

  it('refuses a project ID that already exists in another directory', async () => {
    const root = await copySampleWorkspace();

    const result = await registerProject(root, {
      directory: 'evon-copy',
      id: 'project_evon',
      title: 'Copy',
      repositories: [],
    });

    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((entry) => entry.code === 'id.duplicate'),
    ).toBe(true);
    await expect(
      readFile(path.join(root, 'projects/evon-copy/project.yml')),
    ).rejects.toThrow();
  });

  it('refuses an invalid stable ID before touching the workspace', async () => {
    const root = await copySampleWorkspace();

    const result = await registerProject(root, {
      directory: 'bad',
      id: 'Project Bad',
      title: 'Bad',
      repositories: [],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.code).toBe('operation.target_invalid');
  });

  it('refuses a directory that escapes the projects area', async () => {
    const root = await copySampleWorkspace();

    const result = await registerProject(root, {
      directory: '../escape',
      id: 'project_escape',
      title: 'Escape',
      repositories: [],
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('operation.target_invalid');
  });

  it('makes the new project searchable after refreshing the index', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const result = await registerProject(root, {
      directory: 'field-notes',
      id: 'project_field_notes',
      title: 'Quantum field notes',
      repositories: [],
    });
    expect(result.success).toBe(true);

    const found = await searchIndex(root, 'quantum');
    expect(found.diagnostics).toEqual([]);
    expect(
      found.hits.some(
        (hit) =>
          hit.path === 'projects/field-notes/project.yml' &&
          hit.objectId === 'project_field_notes',
      ),
    ).toBe(true);
  });
});

describe('attachChat and detachChat', () => {
  it('attaches one chat to several projects without duplicating IDs', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-02-shared-curvature.md');

    const first = await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_posterior_diagnostics',
    });
    expect(first.success).toBe(true);
    expect(first.changed).toBe(true);
    expect(first.files).toEqual([file]);

    const second = await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_soap_bubbles',
    });
    expect(second.success).toBe(true);

    const metadata = await chatMetadata(
      root,
      'chats/2026-09-02-shared-curvature.md',
    );
    expect(metadata?.projects).toEqual([
      'project_evon',
      'project_posterior_diagnostics',
      'project_soap_bubbles',
    ]);
    const content = await readFile(file, 'utf8');
    expect(content.match(/project_soap_bubbles/gu)).toHaveLength(1);
  });

  it('is an idempotent no-op when the chat is already attached', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-02-shared-curvature.md');
    await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_soap_bubbles',
    });
    const before = await fileHash(file);

    const repeated = await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_soap_bubbles',
    });

    expect(repeated.success).toBe(true);
    expect(repeated.changed).toBe(false);
    expect(repeated.files).toEqual([]);
    expect(await fileHash(file)).toBe(before);
  });

  it('detaches a chat and is an idempotent no-op afterwards', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-02-shared-curvature.md');

    const detached = await detachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_evon',
    });
    expect(detached.success).toBe(true);
    expect(detached.changed).toBe(true);
    expect(detached.files).toEqual([file]);
    const metadata = await chatMetadata(
      root,
      'chats/2026-09-02-shared-curvature.md',
    );
    expect(metadata?.projects).toBeUndefined();

    const before = await fileHash(file);
    const repeated = await detachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_evon',
    });
    expect(repeated.success).toBe(true);
    expect(repeated.changed).toBe(false);
    expect(repeated.files).toEqual([]);
    expect(await fileHash(file)).toBe(before);
  });

  it('removes the projects key when the last membership is detached', async () => {
    const root = await copySampleWorkspace();

    const detached = await detachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_evon',
    });

    expect(detached.success).toBe(true);
    const content = await readFile(
      path.join(root, 'chats/2026-09-02-shared-curvature.md'),
      'utf8',
    );
    expect(content).not.toContain('projects:');
  });
});

describe('promoteChat', () => {
  const transcript = [
    '---',
    'id: chat_unassigned',
    'title: Unassigned transcript',
    'created: 2026-09-05',
    '---',
    '',
    '# Transcript',
    '',
    'Memorable transcript body, never copied.',
    '',
  ].join('\n');

  it('creates a manifest and attaches the chat without copying or renaming it', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/unassigned.md', transcript);
    const chatFile = path.join(root, 'chats/unassigned.md');
    const before = (await readdir(path.join(root, 'chats'))).sort();

    const result = await promoteChat(root, {
      chatId: 'chat_unassigned',
      id: 'project_notes',
      title: 'Notes',
    });

    expect(result.success).toBe(true);
    expect(result.changed).toBe(true);
    const manifest = path.join(root, 'projects/project_notes/project.yml');
    expect(result.files).toEqual([manifest, chatFile]);
    expect(result.data?.project).toEqual({
      id: 'project_notes',
      title: 'Notes',
      directory: 'project_notes',
      file: manifest,
      repositories: [],
    });

    const manifestContent = await readFile(manifest, 'utf8');
    expect(manifestContent).toBe('id: project_notes\ntitle: Notes\n');
    expect(manifestContent).not.toContain('resources');

    const after = await readFile(chatFile, 'utf8');
    expect(after).toContain('projects:\n  - project_notes\n');
    expect(bodySlice(after)).toBe(bodySlice(transcript));
    expect((await readdir(path.join(root, 'chats'))).sort()).toEqual(before);
  });

  it('honors an explicit project directory', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/unassigned.md', transcript);

    const result = await promoteChat(root, {
      chatId: 'chat_unassigned',
      id: 'project_notes',
      title: 'Notes',
      directory: 'notes-dir',
    });

    expect(result.success).toBe(true);
    expect(result.data?.project.directory).toBe('notes-dir');
    await expect(
      readFile(path.join(root, 'projects/notes-dir/project.yml'), 'utf8'),
    ).resolves.toContain('id: project_notes');
  });

  it('rolls back the manifest after a chat write conflict so promotion can be retried', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/unassigned.md', transcript);
    const chatFile = path.join(root, 'chats/unassigned.md');
    const manifest = path.join(root, 'projects/project_notes/project.yml');
    const concurrent = `${transcript}Concurrent note.\n`;

    const failed = await promoteChat(
      root,
      {
        chatId: 'chat_unassigned',
        id: 'project_notes',
        title: 'Notes',
      },
      {
        beforeConflictCheck: async (target) => {
          await writeFile(target, concurrent);
        },
      },
    );

    expect(failed.success).toBe(false);
    expect(failed.changed).toBe(false);
    expect(failed.files).toEqual([]);
    expect(failed.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    expect(await readFile(chatFile, 'utf8')).toBe(concurrent);
    await expect(readFile(manifest, 'utf8')).rejects.toThrow();

    const retried = await promoteChat(root, {
      chatId: 'chat_unassigned',
      id: 'project_notes',
      title: 'Notes',
    });

    expect(retried.success).toBe(true);
    await expect(readFile(manifest, 'utf8')).resolves.toBe(
      'id: project_notes\ntitle: Notes\n',
    );
    await expect(readFile(chatFile, 'utf8')).resolves.toContain(
      'projects:\n  - project_notes\n',
    );
  });

  it('keeps a concurrently edited manifest when rolling back a chat write conflict', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/unassigned.md', transcript);
    const chatFile = path.join(root, 'chats/unassigned.md');
    const manifest = path.join(root, 'projects/project_notes/project.yml');
    const concurrentChat = `${transcript}Concurrent note.\n`;
    const concurrentManifest = [
      'id: project_notes',
      'title: Notes',
      'x-owner: concurrent writer',
      '',
    ].join('\n');

    const failed = await promoteChat(
      root,
      {
        chatId: 'chat_unassigned',
        id: 'project_notes',
        title: 'Notes',
      },
      {
        beforeConflictCheck: async (target) => {
          await writeFile(manifest, concurrentManifest);
          await writeFile(target, concurrentChat);
        },
      },
    );

    expect(failed.success).toBe(false);
    expect(failed.changed).toBe(true);
    expect(failed.files).toEqual([manifest]);
    expect(failed.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
      'rollback.failed',
    ]);
    expect(await readFile(chatFile, 'utf8')).toBe(concurrentChat);
    expect(await readFile(manifest, 'utf8')).toBe(concurrentManifest);
  });

  it('refuses when the proposed project ID already exists', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'chats/unassigned.md', transcript);

    const result = await promoteChat(root, {
      chatId: 'chat_unassigned',
      id: 'project_evon',
      title: 'Duplicate',
    });

    expect(result.success).toBe(false);
    expect(
      result.diagnostics.some((entry) => entry.code === 'id.duplicate'),
    ).toBe(true);
    await expect(
      readFile(path.join(root, 'projects/project_notes/project.yml')),
    ).rejects.toThrow();
    const after = await readFile(
      path.join(root, 'chats/unassigned.md'),
      'utf8',
    );
    expect(after).toBe(transcript);
  });
});

describe('preservation', () => {
  it('keeps unknown fields, comments, and the Markdown body after attach', async () => {
    const root = await copySampleWorkspace();
    const original = [
      '---',
      'id: chat_preserve',
      'title: Preserve me',
      'created: 2026-09-04',
      '# Attachments below.',
      'projects:',
      '  - project_evon  # primary project',
      'x-review-state: flagged',
      'x-review-notes:',
      '  - keep: this',
      '---',
      '',
      'Body with *markup*.',
      '',
      'Final paragraph.',
      '',
    ].join('\n');
    await write(root, 'chats/preserve.md', original);
    const file = path.join(root, 'chats/preserve.md');

    const result = await attachChat(root, {
      chatId: 'chat_preserve',
      projectId: 'project_soap_bubbles',
    });

    expect(result.success).toBe(true);
    const after = await readFile(file, 'utf8');
    expect(after).toContain('# Attachments below.');
    expect(after).toContain('- project_evon # primary project');
    expect(after).toContain('- project_soap_bubbles');
    expect(after).toContain('x-review-state: flagged');
    expect(after).toContain('x-review-notes:');
    expect(after).toContain('- keep: this');
    expect(bodySlice(after)).toBe(bodySlice(original));
  });
});

describe('refusals', () => {
  it('reports chat.missing for an unknown chat ID', async () => {
    const root = await copySampleWorkspace();

    const result = await attachChat(root, {
      chatId: 'chat_unknown',
      projectId: 'project_evon',
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'chat.missing',
    ]);
  });

  it('reports project.missing for an unknown project ID', async () => {
    const root = await copySampleWorkspace();

    const result = await detachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_unknown',
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'project.missing',
    ]);
  });

  it('refuses a malformed --project value before writing', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-02-shared-curvature.md');
    const before = await fileHash(file);

    const result = await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'NOT_AN_ID',
    });

    expect(result.success).toBe(false);
    expect(result.diagnostics[0]?.code).toBe('operation.target_invalid');
    expect(await fileHash(file)).toBe(before);
  });

  it('refuses a concurrent edit recorded after the initial read', async () => {
    const root = await copySampleWorkspace();
    const file = path.join(root, 'chats/2026-09-02-shared-curvature.md');
    const tampered = `${await readFile(file, 'utf8')}concurrent line\n`;

    const result = await attachChat(
      root,
      {
        chatId: 'chat_shared_curvature',
        projectId: 'project_soap_bubbles',
      },
      {
        beforeConflictCheck: async (target) => {
          await writeFile(target, tampered);
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'write.conflict',
    ]);
    expect(await readFile(file, 'utf8')).toBe(tampered);
  });
});

describe('index freshness', () => {
  it('finds an attached chat through a project-scoped search', async () => {
    const root = await copySampleWorkspace();
    await rebuildIndex(root);

    const scopedBefore = await searchIndex(root, 'curvature', {
      kind: 'project',
      projectId: 'project_soap_bubbles',
    });
    expect(
      scopedBefore.hits.some((hit) => hit.objectId === 'chat_shared_curvature'),
    ).toBe(false);

    const attached = await attachChat(root, {
      chatId: 'chat_shared_curvature',
      projectId: 'project_soap_bubbles',
    });
    expect(attached.success).toBe(true);

    const scopedAfter = await searchIndex(root, 'curvature', {
      kind: 'project',
      projectId: 'project_soap_bubbles',
    });
    expect(
      scopedAfter.hits.some((hit) => hit.objectId === 'chat_shared_curvature'),
    ).toBe(true);
  });
});

describe('CLI wiring', () => {
  it('registers a project with repeated --repository flags and exit 0', async () => {
    const root = await copySampleWorkspace();

    const { code, out } = await runProgram([
      'project',
      'register',
      'field-notes',
      '--id',
      'project_field_notes',
      '--title',
      'Field notes',
      '--repository',
      'repositories/field',
      '--repository',
      'repositories/other',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      command: string;
      success: boolean;
      data: {
        files: string[];
        project: { id: string; repositories: { id: string }[] };
      };
      diagnostics: unknown[];
    };
    expect(envelope.command).toBe('project register');
    expect(envelope.success).toBe(true);
    expect(envelope.data.files).toEqual([
      path.join(root, 'projects/field-notes/project.yml'),
    ]);
    expect(envelope.data.project.id).toBe('project_field_notes');
    expect(envelope.data.project.repositories.map((entry) => entry.id)).toEqual(
      ['resource_repo_field', 'resource_repo_other'],
    );
  });

  it('attaches, reports the no-op, and detaches through the program', async () => {
    const root = await copySampleWorkspace();

    const attached = await runProgram([
      'chat',
      'attach',
      'chat_shared_curvature',
      '--project',
      'project_soap_bubbles',
      '--workspace',
      root,
      '--json',
    ]);
    expect(attached.code).toBe(0);
    const attachEnvelope = JSON.parse(attached.out) as {
      command: string;
      success: boolean;
      data: { changed: boolean; chatId: string; projectId: string };
    };
    expect(attachEnvelope.command).toBe('chat attach');
    expect(attachEnvelope.success).toBe(true);
    expect(attachEnvelope.data).toMatchObject({
      changed: true,
      chatId: 'chat_shared_curvature',
      projectId: 'project_soap_bubbles',
    });

    const repeated = await runProgram([
      'chat',
      'attach',
      'chat_shared_curvature',
      '--project',
      'project_soap_bubbles',
      '--workspace',
      root,
    ]);
    expect(repeated.code).toBe(0);
    expect(repeated.out).toBe(
      "No change: chat 'chat_shared_curvature' is already attached to project 'project_soap_bubbles'.\n",
    );

    const detached = await runProgram([
      'chat',
      'detach',
      'chat_shared_curvature',
      '--project',
      'project_soap_bubbles',
      '--workspace',
      root,
      '--json',
    ]);
    expect(detached.code).toBe(0);
    const detachEnvelope = JSON.parse(detached.out) as {
      command: string;
      success: boolean;
      data: { changed: boolean };
    };
    expect(detachEnvelope.command).toBe('chat detach');
    expect(detachEnvelope.success).toBe(true);
    expect(detachEnvelope.data.changed).toBe(true);
  });

  it('promotes a chat through the program', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'chats/unassigned.md',
      '---\nid: chat_unassigned\ntitle: Unassigned\ncreated: 2026-09-05\n---\n\nBody.\n',
    );

    const { code, out } = await runProgram([
      'chat',
      'promote',
      'chat_unassigned',
      '--id',
      'project_notes',
      '--title',
      'Notes',
      '--workspace',
      root,
      '--json',
    ]);

    expect(code).toBe(0);
    const envelope = JSON.parse(out) as {
      command: string;
      success: boolean;
      data: {
        files: string[];
        chatId: string;
        project: { id: string; title: string };
      };
    };
    expect(envelope.command).toBe('chat promote');
    expect(envelope.success).toBe(true);
    expect(envelope.data.chatId).toBe('chat_unassigned');
    expect(envelope.data.project).toMatchObject({
      id: 'project_notes',
      title: 'Notes',
    });
    expect(envelope.data.files).toEqual([
      path.join(root, 'projects/project_notes/project.yml'),
      path.join(root, 'chats/unassigned.md'),
    ]);
  });

  it('exits 1 for unknown chat and project IDs with a well-formed envelope', async () => {
    const root = await copySampleWorkspace();

    const unknownChat = await runProgram([
      'chat',
      'attach',
      'chat_unknown',
      '--project',
      'project_evon',
      '--workspace',
      root,
      '--json',
    ]);
    expect(unknownChat.code).toBe(1);
    const chatEnvelope = JSON.parse(unknownChat.out) as {
      success: boolean;
      data: null;
      diagnostics: { code: string; severity: string }[];
    };
    expect(chatEnvelope.success).toBe(false);
    expect(chatEnvelope.data).toBeNull();
    expect(chatEnvelope.diagnostics[0]?.code).toBe('chat.missing');
    expect(chatEnvelope.diagnostics[0]?.severity).toBe('error');

    const unknownProject = await runProgram([
      'chat',
      'detach',
      'chat_shared_curvature',
      '--project',
      'project_unknown',
      '--workspace',
      root,
      '--json',
    ]);
    expect(unknownProject.code).toBe(1);
    const projectEnvelope = JSON.parse(unknownProject.out) as {
      success: boolean;
      diagnostics: { code: string }[];
    };
    expect(projectEnvelope.success).toBe(false);
    expect(projectEnvelope.diagnostics[0]?.code).toBe('project.missing');
  });
});
