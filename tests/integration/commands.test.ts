import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/domain/diagnostics.js';
import type { CommandContext, CommandIo } from '../../src/commands/output.js';
import {
  projectListCommand,
  projectShowCommand,
} from '../../src/commands/project.js';
import { rebuildCommand } from '../../src/commands/rebuild.js';
import { validateCommand } from '../../src/commands/validate.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const fixturesDirectory = path.join(repositoryRoot, 'tests/fixtures');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface TestEnvelope {
  command: string;
  success: boolean;
  data: unknown;
  diagnostics: Diagnostic[];
}

function captureContext(
  workspace: string | undefined,
  json: boolean,
): { context: CommandContext; output: () => { out: string; err: string } } {
  let out = '';
  let err = '';
  const io: CommandIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  return {
    context: { workspace, json, io },
    output: () => ({ out, err }),
  };
}

function parseEnvelope(text: string): TestEnvelope {
  return JSON.parse(text) as TestEnvelope;
}

async function readFixture(name: string): Promise<TestEnvelope> {
  return JSON.parse(
    await readFile(path.join(fixturesDirectory, name), 'utf8'),
  ) as TestEnvelope;
}

function withoutMachinePaths(envelope: TestEnvelope): TestEnvelope {
  return JSON.parse(
    JSON.stringify(envelope, (key: string, value: unknown) =>
      key === 'resolvedPath' || key === 'file' ? null : value,
    ),
  ) as TestEnvelope;
}

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-cli-'));
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

describe('validate command', () => {
  it('reports a clean sample workspace', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, true);

    const exitCode = await validateCommand(context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect(envelope.command).toBe('validate');
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({
      files: {
        workspace: 1,
        project: 3,
        chat: 3,
        resource: 2,
        summary: 5,
        task: 4,
        link: 0,
      },
      errors: 0,
      warnings: 0,
    });
    expect(envelope.diagnostics).toEqual([]);
    expect(output().err).toBe('');
  });

  it('completes with diagnostics when a file is broken', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'projects/broken/project.yml', 'id: [unclosed\n');
    const { context, output } = captureContext(root, true);

    const exitCode = await validateCommand(context);

    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(false);
    expect(
      (envelope.data as { files: Record<string, number> }).files.project,
    ).toBe(4);
    expect((envelope.data as { errors: number }).errors).toBe(1);
    expect(envelope.diagnostics[0]?.severity).toBe('error');
    expect(envelope.diagnostics[0]?.code).toMatch(/^yaml\./);
  });

  it('writes human output that is not valid JSON', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, false);

    const exitCode = await validateCommand(context);

    expect(exitCode).toBe(0);
    expect(output().out).toContain('errors: 0');
    expect(() => {
      JSON.parse(output().out);
    }).toThrow();
    expect(output().err).toBe('');
  });
});

describe('rebuild command', () => {
  it('rebuilds the index and reports counts in the envelope', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, true);

    const exitCode = await rebuildCommand(context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect(envelope.command).toBe('rebuild');
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({
      files: 18,
      objects: 17,
      references: 20,
      repositories: 2,
      documents: 17,
      rebuilt: true,
    });
    expect(envelope.diagnostics).toEqual([]);
    expect(output().err).toBe('');
  });

  it('succeeds again on a second rebuild', async () => {
    const root = await copySampleWorkspace();
    const first = captureContext(root, true);
    const second = captureContext(root, true);

    const firstExit = await rebuildCommand(first.context);
    const secondExit = await rebuildCommand(second.context);

    expect(firstExit).toBe(0);
    expect(secondExit).toBe(0);
    expect(parseEnvelope(second.output().out).data).toEqual(
      parseEnvelope(first.output().out).data,
    );
  });

  it('succeeds with diagnostics when a workspace file is broken', async () => {
    const root = await copySampleWorkspace();
    await write(root, 'projects/broken/project.yml', 'id: [unclosed\n');
    const { context, output } = captureContext(root, true);

    const exitCode = await rebuildCommand(context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(true);
    expect((envelope.data as { rebuilt: boolean }).rebuilt).toBe(true);
    expect((envelope.data as { objects: number }).objects).toBe(17);
    expect(envelope.diagnostics.length).toBeGreaterThan(0);
  });

  it('writes human output that is not valid JSON', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, false);

    const exitCode = await rebuildCommand(context);

    expect(exitCode).toBe(0);
    expect(output().out).toContain('rebuilt index at');
    expect(output().out).toContain('(17 objects, 20 references)');
    expect(output().out).toContain('.workspace');
    expect(() => {
      JSON.parse(output().out);
    }).toThrow();
    expect(output().err).toBe('');
  });

  it('exits 1 with a workspace.missing diagnostic for a missing root', async () => {
    const { context, output } = captureContext(
      'fieldwork-missing-workspace',
      true,
    );

    const exitCode = await rebuildCommand(context);

    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('workspace.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
  });
});

describe('project list command', () => {
  it('lists projects sorted by stable ID', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, true);

    const exitCode = await projectListCommand(context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({
      projects: [
        {
          id: 'project_evon',
          title: 'Evolutionary optimization',
          directory: 'evolutionary-optimization',
        },
        {
          id: 'project_posterior_diagnostics',
          title: 'Posterior diagnostics',
          directory: 'posterior-diagnostics',
        },
        {
          id: 'project_soap_bubbles',
          title: 'SOAP-Bubbles',
          directory: 'soap-bubbles',
        },
      ],
    });
  });

  it('continues when unrelated files have errors', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'chats/broken.md',
      '---\nid: [bad\nNo closing boundary\n',
    );
    const { context, output } = captureContext(root, true);

    const exitCode = await projectListCommand(context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect((envelope.data as { projects: unknown[] }).projects).toHaveLength(3);
    expect(envelope.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('project show command', () => {
  it('shows repositories and attached chats for a project', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, true);

    const exitCode = await projectShowCommand('project_evon', context);

    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual({
      id: 'project_evon',
      title: 'Evolutionary optimization',
      summary:
        'Structured variational optimization using matrix-valued statistics.',
      topics: ['topic_preconditioning'],
      directory: 'evolutionary-optimization',
      repositories: [
        {
          id: 'resource_repo_evon',
          title: null,
          resolvedPath: path.join(root, 'repositories/evon'),
          accessible: true,
        },
      ],
      resources: ['resource_evon_posterior'],
      links: [],
      chats: [
        {
          id: 'chat_rank_diagnostics',
          title: 'Rank diagnostics',
          file: path.join(root, 'chats/2026-09-02-rank-diagnostics.md'),
        },
        {
          id: 'chat_shared_curvature',
          title: 'Shared curvature statistics',
          file: path.join(root, 'chats/2026-09-02-shared-curvature.md'),
        },
      ],
      readmeSummaryTitle: 'Evolutionary optimization',
    });
  });

  it('exits 1 with a project.missing diagnostic for an unknown ID', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, true);

    const exitCode = await projectShowCommand('project_unknown', context);

    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(output().out);
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('project.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
  });

  it('writes the missing project diagnostic to stderr in human mode', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, false);

    const exitCode = await projectShowCommand('project_unknown', context);

    expect(exitCode).toBe(1);
    expect(output().out).toBe('');
    expect(output().err).toContain('[project.missing]');
    expect(() => {
      JSON.parse(output().err);
    }).toThrow();
  });
});

describe('JSON fixtures', () => {
  it('keeps the validate fixture in sync with actual output', async () => {
    const { context, output } = captureContext(sampleWorkspace, true);

    await validateCommand(context);

    const actual = parseEnvelope(output().out);
    const fixture = await readFixture('validate.sample-workspace.json');
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
    expect(actual).toEqual(fixture);
  });

  it('keeps the project list fixture in sync with actual output', async () => {
    const { context, output } = captureContext(sampleWorkspace, true);

    await projectListCommand(context);

    const actual = parseEnvelope(output().out);
    const fixture = await readFixture('project-list.sample-workspace.json');
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
    expect(actual).toEqual(fixture);
  });

  it('keeps the project show fixture in sync with actual output', async () => {
    const { context, output } = captureContext(sampleWorkspace, true);

    await projectShowCommand('project_evon', context);

    const actual = parseEnvelope(output().out);
    const fixture = await readFixture('project-show.sample-workspace.json');
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
    expect(withoutMachinePaths(actual)).toEqual(withoutMachinePaths(fixture));
  });
});
