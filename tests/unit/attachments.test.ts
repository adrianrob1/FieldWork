import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { AttachmentReference } from '../../src/domain/transcript.js';
import { parseMarkdownSource } from '../../src/files/frontmatter.js';
import type {
  CanonicalFileKind,
  ParsedWorkspaceFile,
} from '../../src/files/workspace.js';
import { parseWorkspace } from '../../src/files/workspace.js';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  attachmentsBlock,
  messageAttachments,
  resolveAttachmentReferences,
  type ResolvedAttachment,
} from '../../src/operations/attachments.js';
import { chatMessageDiagnostics } from '../../src/operations/message.js';

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

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-attachments-'));
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

function fakeFile(
  root: string,
  relativePath: string,
  kind: string,
  metadata: Record<string, unknown> | null,
  body: string | null,
): ParsedWorkspaceFile {
  return {
    file: path.join(root, ...relativePath.split('/')),
    kind: kind as unknown as CanonicalFileKind,
    area: 'root',
    contentHash: null,
    metadata,
    body,
    document: null,
    resolvedPaths: [],
    diagnostics: [],
  };
}

function inboxNote(id: string, title: string, body: string): string {
  return `---\nid: ${id}\ntitle: ${title}\nkind: note\n---\n${body}`;
}

describe('resolveAttachmentReferences', () => {
  it('resolves each allowed kind by stable id from the sample workspace', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { id: 'task_lab_refresh' },
      { id: 'resource_soap_scaling' },
      { id: 'summary_soap_bubbles' },
      { id: 'chat_lab_agenda' },
      { id: 'project_evon' },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(
      result.resolved.map((attachment) => [
        attachment.kind,
        attachment.id,
        attachment.title,
        attachment.label,
        attachment.mime,
      ]),
    ).toEqual([
      [
        'task',
        'task_lab_refresh',
        'Refresh the lab whiteboard',
        'Refresh the lab whiteboard',
        'text/markdown',
      ],
      [
        'resource',
        'resource_soap_scaling',
        'Scaling notes',
        'Scaling notes',
        'text/markdown',
      ],
      [
        'summary',
        'summary_soap_bubbles',
        'SOAP-Bubbles',
        'SOAP-Bubbles',
        'text/markdown',
      ],
      [
        'chat',
        'chat_lab_agenda',
        'Lab meeting agenda',
        'Lab meeting agenda',
        'text/markdown',
      ],
      [
        'project',
        'project_evon',
        'Evolutionary optimization',
        'Evolutionary optimization',
        'application/yaml',
      ],
    ]);
    expect(result.resolved.map((attachment) => attachment.path)).toEqual([
      'tasks/lab-refresh.md',
      'projects/soap-bubbles/context/scaling.md',
      'projects/soap-bubbles/README.md',
      'chats/2026-09-10-lab-agenda.md',
      'projects/evolutionary-optimization/project.yml',
    ]);
    expect(
      result.resolved.every(
        (attachment) =>
          !attachment.label.includes('/') &&
          !attachment.label.includes(attachment.path),
      ),
    ).toBe(true);
  });

  it('loads the parsed body for markdown and the raw source for yaml', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { id: 'resource_soap_scaling' },
      { id: 'project_evon' },
    ]);

    const scalingSource = await readFile(
      path.join(root, 'projects/soap-bubbles/context/scaling.md'),
      'utf8',
    );
    const scalingBody =
      parseMarkdownSource('scaling.md', scalingSource).body ?? '';
    const projectSource = await readFile(
      path.join(root, 'projects/evolutionary-optimization/project.yml'),
      'utf8',
    );

    const scaling = result.resolved[0];
    expect(scaling?.content).toBe(scalingBody);
    expect(scaling?.content).not.toContain('---');
    expect(scaling?.sizeBytes).toBe(Buffer.byteLength(scalingBody, 'utf8'));
    const project = result.resolved[1];
    expect(project?.content).toBe(projectSource);
    expect(project?.sizeBytes).toBe(Buffer.byteLength(projectSource, 'utf8'));
  });

  it('falls back to the file stem for title and the id for label', async () => {
    const root = await copySampleWorkspace();
    const bare = fakeFile(
      root,
      'inbox/bare-notes.md',
      'resource',
      { id: 'resource_bare' },
      'Body.',
    );
    const unmarked = fakeFile(
      root,
      'inbox/no-meta.md',
      'resource',
      null,
      'Body.',
    );

    const result = await resolveAttachmentReferences(
      root,
      [bare, unmarked],
      [{ id: 'resource_bare' }, { path: 'inbox/no-meta.md' }],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.resolved[0]?.title).toBe('bare-notes');
    expect(result.resolved[0]?.label).toBe('resource_bare');
    expect(result.resolved[1]?.title).toBe('no-meta');
    expect(result.resolved[1]?.label).toBe('no-meta');
    expect(result.resolved[1]?.id).toBeUndefined();
  });

  it('reports attachment.missing for an unknown id', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { id: 'resource_missing' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
    expect(result.diagnostics[0]?.severity).toBe('error');
    expect(result.diagnostics[0]?.message).toContain('resource_missing');
  });

  it('reports attachment.missing for a disallowed kind', async () => {
    const root = await copySampleWorkspace();
    const link = fakeFile(
      root,
      'projects/soap-bubbles/links/notes.yml',
      'link',
      { id: 'link_notes' },
      null,
    );

    const result = await resolveAttachmentReferences(
      root,
      [link],
      [{ id: 'link_notes' }],
    );

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
    expect(result.diagnostics[0]?.message).toContain('link');
  });

  it('resolves a stored-path reference and carries the target id', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: 'topics/preconditioning.md' },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.resolved[0]).toMatchObject({
      kind: 'summary',
      id: 'topic_preconditioning',
      path: 'topics/preconditioning.md',
      title: 'Matrix preconditioning',
      label: 'Matrix preconditioning',
      mime: 'text/markdown',
    });
  });

  it('reports attachment.missing for a path that is not on disk', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: 'inbox/not-there.md' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
  });

  it('reports attachment.unsupported for an on-disk non-canonical path', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: 'repositories/evon/README.md' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.unsupported',
    ]);
  });

  it('reports attachment.missing for unsafe path forms', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: '../outside.md' },
      { path: 'chats\\lab-agenda.md' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
      'attachment.missing',
    ]);
  });

  it('reports attachment.too_large when one attachment exceeds the byte limit', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'inbox/big.md',
      inboxNote(
        'resource_big',
        'Big notes',
        'x'.repeat(MAX_ATTACHMENT_BYTES + 1),
      ),
    );
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: 'inbox/big.md' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.too_large',
    ]);
    expect(result.diagnostics[0]?.message).toContain('inbox/big.md');
  });

  it('reports attachment.limit when the total byte limit is exceeded', async () => {
    const root = await copySampleWorkspace();
    const chunkBytes = 240000;
    for (const index of [0, 1, 2, 3, 4]) {
      await write(
        root,
        `inbox/chunk-${index}.md`,
        inboxNote(
          `resource_chunk_${index}`,
          `Chunk ${index}`,
          'x'.repeat(chunkBytes),
        ),
      );
    }
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(
      root,
      parsed.files,
      [0, 1, 2, 3, 4].map((index) => ({ path: `inbox/chunk-${index}.md` })),
    );

    expect(result.resolved).toHaveLength(4);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.limit',
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      String(MAX_TOTAL_ATTACHMENT_BYTES),
    );
    expect(
      result.resolved.every(
        (attachment) => attachment.sizeBytes === chunkBytes,
      ),
    ).toBe(true);
  });

  it('reports attachment.limit when more references than allowed are given', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);
    const refs: AttachmentReference[] = Array.from(
      { length: MAX_ATTACHMENTS_PER_MESSAGE + 1 },
      () => ({ id: 'resource_soap_scaling' }),
    );

    const result = await resolveAttachmentReferences(root, parsed.files, refs);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.limit',
    ]);
    expect(result.diagnostics[0]?.message).toContain(
      String(MAX_ATTACHMENTS_PER_MESSAGE),
    );
  });

  it('dedupes repeated references to the same target silently', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { id: 'resource_soap_scaling' },
      { id: 'resource_soap_scaling' },
      { path: 'projects/soap-bubbles/context/scaling.md' },
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0]?.id).toBe('resource_soap_scaling');
  });

  it('reports attachment.unreadable when the target cannot be read', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);
    await unlink(
      path.join(root, 'projects/evolutionary-optimization/project.yml'),
    );

    const missingYaml = await resolveAttachmentReferences(root, parsed.files, [
      { id: 'project_evon' },
    ]);
    expect(missingYaml.resolved).toEqual([]);
    expect(missingYaml.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.unreadable',
    ]);

    const unreadableMarkdown = fakeFile(
      root,
      'inbox/locked.md',
      'resource',
      { id: 'resource_locked', title: 'Locked notes' },
      null,
    );
    const result = await resolveAttachmentReferences(
      root,
      [unreadableMarkdown],
      [{ id: 'resource_locked' }],
    );
    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.unreadable',
    ]);
  });

  it('reports attachment.invalid for malformed references', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      {},
      { id: 'resource_soap_scaling', path: 'inbox/extra.md' },
    ]);

    expect(result.resolved).toEqual([]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.invalid',
      'attachment.invalid',
    ]);
  });

  it('reports per-reference failures without dropping the other references', async () => {
    const root = await copySampleWorkspace();
    const parsed = await parseWorkspace(root);

    const result = await resolveAttachmentReferences(root, parsed.files, [
      { path: 'inbox/not-there.md' },
      { id: 'resource_soap_scaling' },
    ]);

    expect(result.resolved.map((attachment) => attachment.id)).toEqual([
      'resource_soap_scaling',
    ]);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.missing',
    ]);
  });
});

describe('attachmentsBlock', () => {
  it('returns an empty string without attachments', () => {
    expect(attachmentsBlock([])).toBe('');
  });

  it('wraps trimmed content in kind and title attributes', () => {
    const attachment: ResolvedAttachment = {
      kind: 'resource',
      id: 'resource_soap_scaling',
      path: 'projects/soap-bubbles/context/scaling.md',
      title: 'Scaling notes',
      label: 'Scaling notes',
      mime: 'text/markdown',
      sizeBytes: 12,
      content: '  # Scaling notes\n\nVary the dimensions.\n\n',
    };

    expect(attachmentsBlock([attachment])).toBe(
      [
        '<attachment kind="resource" title="Scaling notes">',
        '# Scaling notes',
        '',
        'Vary the dimensions.',
        '</attachment>',
      ].join('\n'),
    );
  });

  it('escapes attributes and separates multiple blocks', () => {
    const first: ResolvedAttachment = {
      kind: 'task',
      id: 'task_quoted',
      path: 'tasks/quoted.md',
      title: 'Fix "login" & <logout>',
      label: 'Fix "login" & <logout>',
      mime: 'text/markdown',
      sizeBytes: 6,
      content: 'Body one.',
    };
    const second: ResolvedAttachment = {
      kind: 'chat',
      path: 'chats/plain.md',
      title: 'Plain chat',
      label: 'Plain chat',
      mime: 'text/markdown',
      sizeBytes: 6,
      content: 'Body two.',
    };

    expect(attachmentsBlock([first, second])).toBe(
      [
        '<attachment kind="task" title="Fix &quot;login&quot; &amp; &lt;logout&gt;">',
        'Body one.',
        '</attachment>',
        '',
        '<attachment kind="chat" title="Plain chat">',
        'Body two.',
        '</attachment>',
      ].join('\n'),
    );
  });
});

describe('messageAttachments', () => {
  it('builds the stored metadata shape with the target id', () => {
    const attachment: ResolvedAttachment = {
      kind: 'task',
      id: 'task_lab_refresh',
      path: 'tasks/lab-refresh.md',
      title: 'Refresh the lab whiteboard',
      label: 'Refresh the lab whiteboard',
      mime: 'text/markdown',
      sizeBytes: 64,
      content: 'Wipe the whiteboard.',
    };

    expect(messageAttachments([attachment])).toEqual([
      {
        id: 'task_lab_refresh',
        path: 'tasks/lab-refresh.md',
        label: 'Refresh the lab whiteboard',
        mime: 'text/markdown',
        kind: 'task',
        title: 'Refresh the lab whiteboard',
        size: 64,
      },
    ]);
  });

  it('omits the id when the target has none', () => {
    const attachment: ResolvedAttachment = {
      kind: 'resource',
      path: 'inbox/bare.md',
      title: 'bare',
      label: 'bare',
      mime: 'text/markdown',
      sizeBytes: 1,
      content: 'x',
    };

    const stored = messageAttachments([attachment])[0];
    expect(stored).toEqual({
      path: 'inbox/bare.md',
      label: 'bare',
      mime: 'text/markdown',
      kind: 'resource',
      title: 'bare',
      size: 1,
    });
    expect('id' in stored).toBe(false);
  });
});

describe('chatMessageDiagnostics attachment metadata', () => {
  it('surfaces attachment.invalid for malformed stored attachments', () => {
    const diagnostics = chatMessageDiagnostics('root', {
      role: 'user',
      text: 'Hello.',
      metadata: { attachments: [{ label: 'no target' }] },
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.invalid',
    ]);
  });

  it('keeps transcript.metadata for non-attachment metadata issues', () => {
    const diagnostics = chatMessageDiagnostics('root', {
      role: 'assistant',
      text: 'Hello.',
      metadata: { at: 'yesterday' },
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'transcript.metadata',
    ]);
  });

  it('reports both codes when attachments and other metadata are invalid', () => {
    const diagnostics = chatMessageDiagnostics('root', {
      role: 'user',
      text: 'Hello.',
      metadata: { at: 'yesterday', attachments: [{ label: 'no target' }] },
    });

    expect(diagnostics.map((entry) => entry.code)).toEqual([
      'attachment.invalid',
      'transcript.metadata',
    ]);
  });

  it('accepts stored attachments with kind, title, and size', () => {
    const diagnostics = chatMessageDiagnostics('root', {
      role: 'user',
      text: 'Hello.',
      metadata: {
        attachments: [
          {
            id: 'resource_soap_scaling',
            path: 'projects/soap-bubbles/context/scaling.md',
            label: 'Scaling notes',
            mime: 'text/markdown',
            kind: 'resource',
            title: 'Scaling notes',
            size: 120,
          },
        ],
      },
    });

    expect(diagnostics).toEqual([]);
  });
});
