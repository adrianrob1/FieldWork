import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  contextCommand,
  type ContextCommandOptions,
} from '../../src/commands/context.js';
import type { CommandContext, CommandIo } from '../../src/commands/output.js';
import {
  searchCommand,
  type SearchCommandOptions,
} from '../../src/commands/search.js';
import type { Diagnostic } from '../../src/domain/diagnostics.js';
import {
  MAX_CONTEXT_FILE_BYTES,
  type ContextBundle,
  type ContextFile,
} from '../../src/search/context.js';
import type { LexicalSearchData } from '../../src/search/lexical.js';

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

function withoutVolatile(envelope: TestEnvelope): TestEnvelope {
  return JSON.parse(
    JSON.stringify(envelope, (key: string, value: unknown) => {
      if (key === 'timings' || key === 'file') return null;
      return key === 'content' && typeof value === 'string'
        ? value.replace(/\r\n/g, '\n')
        : value;
    }),
  ) as TestEnvelope;
}

async function copySampleWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-retrieval-'));
  temporaryDirectories.push(root);
  await cp(sampleWorkspace, root, { recursive: true });
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-empty-'));
  temporaryDirectories.push(directory);
  return directory;
}

function rgAvailable(): boolean {
  const probe = spawnSync('rg', ['--version']);
  return probe.error === undefined && probe.status === 0;
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

async function withoutRipgrep<T>(run: () => Promise<T>): Promise<T> {
  const empty = await temporaryDirectory();
  const original = process.env.PATH;
  process.env.PATH = empty;
  try {
    return await run();
  } finally {
    process.env.PATH = original;
  }
}

async function runSearch(
  root: string,
  query: string,
  options: SearchCommandOptions = {},
): Promise<{ exitCode: number; envelope: TestEnvelope; err: string }> {
  const { context, output } = captureContext(root, true);
  const exitCode = await searchCommand(query, options, context);
  return { exitCode, envelope: parseEnvelope(output().out), err: output().err };
}

async function runContext(
  root: string,
  query: string,
  options: ContextCommandOptions = {},
): Promise<{ exitCode: number; envelope: TestEnvelope; err: string }> {
  const { context, output } = captureContext(root, true);
  const exitCode = await contextCommand(query, options, context);
  return { exitCode, envelope: parseEnvelope(output().out), err: output().err };
}

function bundleOf(envelope: TestEnvelope): ContextBundle {
  return envelope.data as ContextBundle;
}

const trailRoutes = new Set([
  'summary',
  'source',
  'link',
  'project',
  'fts',
  'repository',
]);

function expectTrails(bundle: ContextBundle): void {
  const branchIds = new Set(bundle.selectedBranches.map((branch) => branch.id));
  for (const file of bundle.files) {
    expect(branchIds.has(file.trail.branch)).toBe(true);
    expect(trailRoutes.has(file.trail.route)).toBe(true);
    expect(file.score.total).toBeCloseTo(
      file.score.branch + file.score.text,
      5,
    );
  }
}

function probeNote(): string {
  return [
    '---',
    'id: resource_probe_note',
    'title: Probe note',
    'kind: note',
    'projects:',
    '  - project_evon',
    'topics:',
    '  - topic_preconditioning',
    '---',
    '',
    'The quokka probe holds.',
    '',
    'Another quokka probe line.',
    '',
  ].join('\n');
}

async function lineAt(
  root: string,
  storedPath: string,
  line: number,
): Promise<string> {
  const content = await readFile(
    path.join(root, ...storedPath.split('/')),
    'utf8',
  );
  return (content.split(/\r?\n/)[line - 1] ?? '').toLowerCase();
}

describe('search command', () => {
  it('returns one ordered result list with duration and index freshness', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runSearch(root, 'posterior');

    expect(exitCode).toBe(0);
    expect(envelope.command).toBe('search');
    expect(envelope.success).toBe(true);
    const data = envelope.data as LexicalSearchData;
    expect(Object.keys(data).sort()).toEqual([
      'diagnostics',
      'durationMs',
      'hasMore',
      'index',
      'limit',
      'offset',
      'query',
      'results',
      'returnedResults',
      'scope',
      'totalResults',
    ]);
    expect(data.query).toBe('posterior');
    expect(data.scope).toEqual({ kind: 'workspace' });
    expect(data.limit).toBe(50);
    expect(data.offset).toBe(0);
    expect(data.durationMs).toBeGreaterThanOrEqual(0);
    expect(data.index.path.replace(/\\/g, '/')).toContain(
      '.workspace/index.sqlite',
    );
    expect(Number.isNaN(Date.parse(data.index.modifiedAt))).toBe(false);
    expect(data.index.counts?.documents).toBeGreaterThan(0);
    expect(Array.isArray(data.diagnostics)).toBe(true);
    expect(data.returnedResults).toBe(data.results.length);
    expect(data.totalResults).toBe(data.results.length);
    expect(data.hasMore).toBe(false);

    const paths = data.results.map((entry) => entry.path);
    expect(paths).toContain(
      'projects/evolutionary-optimization/context/posterior.md',
    );
    expect(paths).toContain('chats/2026-09-02-rank-diagnostics.md');
    for (const entry of data.results) {
      expect(entry.source).toBe('workspace');
      expect(entry.objectId).toBeDefined();
      expect(entry.snippet).toContain('[');
      expect(entry.snippet).toContain(']');
      expect(entry.matchCount).toBeGreaterThanOrEqual(1);
      expect(entry.lineStart).toBeDefined();
      expect(entry.lineEnd).toBe(entry.lineStart);
    }
    const posterior = data.results.find(
      (entry) =>
        entry.path ===
        'projects/evolutionary-optimization/context/posterior.md',
    );
    expect(posterior).toMatchObject({
      kind: 'resource',
      objectId: 'resource_evon_posterior',
      title: 'Posterior update notes',
    });
    expect(posterior?.matchCount).toBeGreaterThanOrEqual(1);
    expect(
      await lineAt(root, posterior?.path ?? '', posterior?.lineStart ?? 0),
    ).toContain('posterior');
  });

  it('enriches a workspace hit with kind, identity, line range, and match count', async () => {
    const root = await copySampleWorkspace();
    await write(
      root,
      'projects/evolutionary-optimization/context/probe-note.md',
      probeNote(),
    );

    const { exitCode, envelope } = await runSearch(root, 'quokka');

    expect(exitCode).toBe(0);
    const data = envelope.data as LexicalSearchData;
    expect(data.totalResults).toBe(1);
    expect(data.returnedResults).toBe(1);
    const entry = data.results[0];
    expect(entry).toMatchObject({
      source: 'workspace',
      kind: 'resource',
      path: 'projects/evolutionary-optimization/context/probe-note.md',
      objectId: 'resource_probe_note',
      title: 'Probe note',
      lineStart: 11,
      lineEnd: 11,
      matchCount: 2,
    });
    expect(entry?.snippet).toContain('[quokka]');
    expect(entry?.repositoryId).toBeUndefined();
    expect(
      await lineAt(root, entry?.path ?? '', entry?.lineStart ?? 0),
    ).toContain('quokka');
  });

  it.runIf(rgAvailable())(
    'aggregates repository matches per file behind workspace hits',
    async () => {
      const root = await copySampleWorkspace();
      await write(
        root,
        'projects/evolutionary-optimization/context/probe-note.md',
        probeNote(),
      );
      await write(
        root,
        'repositories/evon/quokka.txt',
        'quokka leader\nplain text\nquokka follower\n',
      );
      await write(root, 'repositories/evon/aaa-quokka.txt', 'lone quokka\n');

      const { exitCode, envelope } = await runSearch(root, 'quokka');

      expect(exitCode).toBe(0);
      const data = envelope.data as LexicalSearchData;
      expect(data.totalResults).toBe(3);
      expect(data.results[0]?.source).toBe('workspace');
      expect(data.results[0]?.path).toBe(
        'projects/evolutionary-optimization/context/probe-note.md',
      );
      expect(
        data.results.slice(1).every((entry) => entry.source === 'repository'),
      ).toBe(true);
      expect(data.results[1]).toMatchObject({
        source: 'repository',
        kind: 'repository',
        repositoryId: 'resource_repo_evon',
        path: 'quokka.txt',
        title: 'quokka',
        snippet: '[quokka] leader',
        lineStart: 1,
        lineEnd: 1,
        matchCount: 2,
      });
      expect(data.results[1]?.objectId).toBeUndefined();
      expect(data.results[2]).toMatchObject({
        source: 'repository',
        repositoryId: 'resource_repo_evon',
        path: 'aaa-quokka.txt',
        snippet: 'lone [quokka]',
        lineStart: 1,
        lineEnd: 1,
        matchCount: 1,
      });
    },
  );

  it('scopes workspace results to a project tree plus referencing objects', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runSearch(root, 'posterior', {
      project: 'project_evon',
    });

    expect(exitCode).toBe(0);
    const data = envelope.data as LexicalSearchData;
    expect(data.scope).toEqual({ kind: 'project', project: 'project_evon' });
    expect(data.results.length).toBeGreaterThan(0);
    for (const entry of data.results) {
      const inTree = entry.path.startsWith(
        'projects/evolutionary-optimization/',
      );
      const referencing = [
        'chat_rank_diagnostics',
        'chat_shared_curvature',
        'resource_evon_posterior',
        'summary_evon',
      ].includes(entry.objectId ?? '');
      expect(inTree || referencing || entry.source === 'repository').toBe(true);
    }
  });

  it.runIf(rgAvailable())(
    'restricts repository results to repositories registered by the project',
    async () => {
      const root = await copySampleWorkspace();
      await write(root, 'repositories/evon/project-hit.txt', 'scope needle\n');
      await write(
        root,
        'repositories-archive/soap-bubbles/other-hit.txt',
        'scope needle\n',
      );

      const { exitCode, envelope } = await runSearch(root, 'scope needle', {
        project: 'project_evon',
      });

      expect(exitCode).toBe(0);
      const data = envelope.data as LexicalSearchData;
      expect(data.scope).toEqual({ kind: 'project', project: 'project_evon' });
      const repositoryEntries = data.results.filter(
        (entry) => entry.source === 'repository',
      );
      expect(repositoryEntries).toHaveLength(1);
      expect(repositoryEntries[0]).toMatchObject({
        repositoryId: 'resource_repo_evon',
        path: 'project-hit.txt',
        snippet: '[scope] [needle]',
        lineStart: 1,
        lineEnd: 1,
        matchCount: 1,
      });
      expect(data.results.some((entry) => entry.path === 'other-hit.txt')).toBe(
        false,
      );
    },
  );

  it('pages the merged list with limit and offset', async () => {
    const root = await copySampleWorkspace();

    const full = await runSearch(root, 'posterior');
    const data = full.envelope.data as LexicalSearchData;
    expect(data.totalResults).toBeGreaterThan(1);

    const page = await runSearch(root, 'posterior', { limit: 1, offset: 1 });
    const pageData = page.envelope.data as LexicalSearchData;
    expect(pageData.limit).toBe(1);
    expect(pageData.offset).toBe(1);
    expect(pageData.returnedResults).toBe(1);
    expect(pageData.results[0]).toEqual(data.results[1]);
    expect(pageData.totalResults).toBe(data.totalResults);
    expect(pageData.hasMore).toBe(data.totalResults > 2);

    const last = await runSearch(root, 'posterior', {
      limit: 1,
      offset: data.totalResults - 1,
    });
    const lastData = last.envelope.data as LexicalSearchData;
    expect(lastData.returnedResults).toBe(1);
    expect(lastData.hasMore).toBe(false);

    const past = await runSearch(root, 'posterior', {
      offset: data.totalResults + 5,
    });
    const pastData = past.envelope.data as LexicalSearchData;
    expect(pastData.results).toEqual([]);
    expect(pastData.returnedResults).toBe(0);
    expect(pastData.hasMore).toBe(false);

    const clamped = await runSearch(root, 'posterior', {
      limit: 500,
      offset: -4,
    });
    const clampedData = clamped.envelope.data as LexicalSearchData;
    expect(clampedData.limit).toBe(200);
    expect(clampedData.offset).toBe(0);

    const zero = await runSearch(root, 'posterior', { limit: 0 });
    expect((zero.envelope.data as LexicalSearchData).limit).toBe(1);
  });

  it('exits 1 with project.missing for an unknown project scope', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runSearch(root, 'posterior', {
      project: 'project_unknown',
    });

    expect(exitCode).toBe(1);
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('project.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
  });

  it('exits 0 with an empty result list for a query that matches nothing', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runSearch(root, 'quokka zephyr');

    expect(exitCode).toBe(0);
    const data = envelope.data as LexicalSearchData;
    expect(data.results).toEqual([]);
    expect(data.totalResults).toBe(0);
    expect(data.returnedResults).toBe(0);
    expect(data.hasMore).toBe(false);
    expect(data.index.counts?.files).toBeGreaterThan(0);
  });

  it('exits 0 with an empty result list for an empty query', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runSearch(root, '');

    expect(exitCode).toBe(0);
    const data = envelope.data as LexicalSearchData;
    expect(data.results).toEqual([]);
    expect(data.totalResults).toBe(0);
    expect(data.hasMore).toBe(false);
  });

  it('degrades to workspace-only results with an rg.missing warning when rg is not on PATH', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await withoutRipgrep(() =>
      runSearch(root, 'posterior'),
    );

    expect(exitCode).toBe(0);
    const data = envelope.data as LexicalSearchData;
    expect(data.results.length).toBeGreaterThan(0);
    expect(data.results.every((entry) => entry.source === 'workspace')).toBe(
      true,
    );
    const rgMissing = (entry: Diagnostic) =>
      entry.code === 'rg.missing' && entry.severity === 'warning';
    expect(envelope.diagnostics.some(rgMissing)).toBe(true);
    expect(data.diagnostics.some(rgMissing)).toBe(true);
  });

  it('prints one line per result in human mode', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, false);

    const exitCode = await searchCommand('posterior', {}, context);

    expect(exitCode).toBe(0);
    const lines = output()
      .out.split('\n')
      .filter((line) => line !== '');
    expect(lines[0]).toBe('search: posterior (scope: workspace)');
    expect(lines.length).toBeGreaterThan(1);
    expect(
      lines.some((line) =>
        line.startsWith(
          'projects/evolutionary-optimization/context/posterior.md',
        ),
      ),
    ).toBe(true);
    expect(() => {
      JSON.parse(output().out);
    }).toThrow();
  });

  it.runIf(rgAvailable())(
    'prints repository results with repository, path, and line in human mode',
    async () => {
      const root = await copySampleWorkspace();
      await write(root, 'repositories/evon/project-hit.txt', 'scope needle\n');
      const { context, output } = captureContext(root, false);

      const exitCode = await searchCommand(
        'scope needle',
        { project: 'project_evon' },
        context,
      );

      expect(exitCode).toBe(0);
      expect(output().out).toContain(
        'resource_repo_evon:project-hit.txt:1: [scope] [needle]',
      );
    },
  );
});

describe('context command', () => {
  it('selects the project branch and returns files with trails for a project scope', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'posterior', {
      project: 'project_evon',
    });

    expect(exitCode).toBe(0);
    expect(envelope.command).toBe('context');
    expect(envelope.success).toBe(true);
    const bundle = bundleOf(envelope);
    expect(bundle.query).toBe('posterior');
    expect(bundle.scope).toEqual({ kind: 'project', project: 'project_evon' });
    expect(bundle.selectedBranches.map((branch) => branch.id)).toEqual([
      'summary_evon',
    ]);
    const branch = bundle.selectedBranches[0];
    expect(branch?.score.fts).toBeGreaterThan(0);
    expect(branch?.score.total).toBeCloseTo(
      (branch?.score.exactId ?? 0) +
        (branch?.score.exactTitle ?? 0) +
        (branch?.score.keywords ?? 0) +
        (branch?.score.fts ?? 0) +
        (branch?.score.topic ?? 0),
      5,
    );
    expect(bundle.files.length).toBeGreaterThan(0);
    expect(bundle.files.length).toBeLessThanOrEqual(10);
    const referencing = new Set([
      'chat_rank_diagnostics',
      'chat_shared_curvature',
      'resource_evon_posterior',
      'summary_evon',
    ]);
    for (const file of bundle.files) {
      const inTree = file.path.startsWith(
        'projects/evolutionary-optimization/',
      );
      const attached =
        file.repositoryId === 'resource_repo_evon' ||
        referencing.has(file.objectId ?? '');
      expect(inTree || attached).toBe(true);
      expect(file.contentTruncated).toBe(false);
      if (file.repositoryId === null) {
        expect(file.content).toBe(
          await readFile(path.join(root, ...file.path.split('/')), 'utf8'),
        );
      }
    }
    expectTrails(bundle);
    expect(Object.keys(bundle.timings).sort()).toEqual([
      'refreshMs',
      'routingMs',
      'searchMs',
      'totalMs',
    ]);
  });

  it('shows why a branch was selected through its score components', async () => {
    const root = await copySampleWorkspace();

    const { envelope } = await runContext(root, 'matrix preconditioning', {
      project: 'project_evon',
    });

    const bundle = bundleOf(envelope);
    expect(bundle.selectedBranches.length).toBeGreaterThan(0);
    const summary = bundle.selectedBranches.find(
      (branch) => branch.id === 'summary_evon',
    );
    expect(summary).toBeDefined();
    expect(Object.keys(summary?.score ?? {}).sort()).toEqual([
      'exactId',
      'exactTitle',
      'fts',
      'keywordMatches',
      'keywords',
      'topic',
      'total',
    ]);
  });

  it('seeds the same branches from a chat attached to one project', async () => {
    const root = await copySampleWorkspace();

    const scoped = await runContext(root, 'posterior', {
      project: 'project_evon',
    });
    const seeded = await runContext(root, 'posterior', {
      chat: 'chat_shared_curvature',
    });

    expect(seeded.exitCode).toBe(0);
    const bundle = bundleOf(seeded.envelope);
    expect(bundle.scope).toEqual({
      kind: 'chat',
      chat: 'chat_shared_curvature',
    });
    expect(bundle.selectedBranches.map((branch) => branch.id)).toEqual(
      bundleOf(scoped.envelope).selectedBranches.map((branch) => branch.id),
    );
  });

  it('can select branches from two projects for a chat attached to both', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'posterior', {
      chat: 'chat_rank_diagnostics',
    });

    expect(exitCode).toBe(0);
    const bundle = bundleOf(envelope);
    expect(bundle.selectedBranches.map((branch) => branch.id)).toEqual([
      'summary_evon',
      'summary_posterior_diagnostics',
    ]);
    expect(bundle.selectedBranches.length).toBeLessThanOrEqual(2);
    expectTrails(bundle);
  });

  it('routes a global query through project and topic summaries only', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'preconditioning');

    expect(exitCode).toBe(0);
    const bundle = bundleOf(envelope);
    expect(bundle.scope).toEqual({ kind: 'global' });
    expect(bundle.selectedBranches.length).toBeGreaterThan(0);
    expect(bundle.selectedBranches.length).toBeLessThanOrEqual(2);
    const allowed = new Set([
      'summary_evon',
      'summary_posterior_diagnostics',
      'summary_soap_bubbles',
      'topic_preconditioning',
    ]);
    for (const branch of bundle.selectedBranches) {
      expect(allowed.has(branch.id)).toBe(true);
      expect(branch.kind).not.toBe('root');
    }
    expect(
      bundle.selectedBranches.some(
        (branch) => branch.id === 'topic_preconditioning',
      ),
    ).toBe(true);
    expectTrails(bundle);
  });

  it('never exceeds two branches or ten files even with many matches', async () => {
    const root = await copySampleWorkspace();
    for (let index = 1; index <= 12; index += 1) {
      const id = `resource_evon_note_${String(index).padStart(2, '0')}`;
      await write(
        root,
        `projects/evolutionary-optimization/notes/note-${index}.md`,
        `---\nid: ${id}\ntitle: Posterior note ${index}\nkind: note\n---\n\nPosterior accumulation note ${index}.\n`,
      );
    }

    const { exitCode, envelope } = await runContext(root, 'posterior', {
      chat: 'chat_rank_diagnostics',
    });

    expect(exitCode).toBe(0);
    const bundle = bundleOf(envelope);
    expect(bundle.selectedBranches.map((branch) => branch.id)).toEqual([
      'summary_evon',
      'summary_posterior_diagnostics',
    ]);
    expect(bundle.files).toHaveLength(10);
    const totals = bundle.files.map((file) => file.score.total);
    expect([...totals].sort((a, b) => b - a)).toEqual(totals);
    expectTrails(bundle);
  });

  it('bounds large content at a complete UTF-8 character and marks truncation', async () => {
    const root = await copySampleWorkspace();
    const relative = 'projects/evolutionary-optimization/README.md';
    const prefix =
      '---\nid: summary_evon\ntitle: Evolutionary optimization\nkind: project\nproject: project_evon\n---\n\nOversized marker.\n';
    const remainder =
      (MAX_CONTEXT_FILE_BYTES - Buffer.byteLength(prefix, 'utf8')) % 4;
    const padding = 'x'.repeat((remainder + 1) % 4);
    const source = `${prefix}${padding}${'😀'.repeat(MAX_CONTEXT_FILE_BYTES)}\n`;
    await write(root, relative, source);

    const { exitCode, envelope } = await runContext(root, 'oversized', {
      project: 'project_evon',
    });

    expect(exitCode).toBe(0);
    const file = bundleOf(envelope).files.find(
      (entry) => entry.objectId === 'summary_evon',
    );
    expect(file).toBeDefined();
    expect(file?.contentTruncated).toBe(true);
    expect(Buffer.byteLength(file?.content ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_CONTEXT_FILE_BYTES,
    );
    expect(source.startsWith(file?.content ?? '')).toBe(true);
    expect(file?.content.endsWith('\ufffd')).toBe(false);
  });

  it('returns an empty bundle with a diagnostic for a query no branch matches', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'quokka zephyr');

    expect(exitCode).toBe(0);
    expect(envelope.success).toBe(true);
    const bundle = bundleOf(envelope);
    expect(bundle.selectedBranches).toEqual([]);
    expect(bundle.files).toEqual([]);
    expect(
      envelope.diagnostics.some(
        (entry) =>
          entry.code === 'context.no_branch' && entry.severity === 'warning',
      ),
    ).toBe(true);
  });

  it('exits 1 with chat.missing for an unknown chat scope', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'posterior', {
      chat: 'chat_unknown',
    });

    expect(exitCode).toBe(1);
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('chat.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
  });

  it('exits 1 with project.missing for an unknown project scope', async () => {
    const root = await copySampleWorkspace();

    const { exitCode, envelope } = await runContext(root, 'posterior', {
      project: 'project_unknown',
    });

    expect(exitCode).toBe(1);
    expect(envelope.success).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.diagnostics[0]?.code).toBe('project.missing');
    expect(envelope.diagnostics[0]?.severity).toBe('error');
  });

  it('reports branch and file lines with trail reasons in human mode', async () => {
    const root = await copySampleWorkspace();
    const { context, output } = captureContext(root, false);

    const exitCode = await contextCommand(
      'posterior',
      { project: 'project_evon' },
      context,
    );

    expect(exitCode).toBe(0);
    const out = output().out;
    expect(out).toContain('context: posterior (scope: project project_evon)');
    expect(out).toContain('branches:');
    expect(out).toContain('summary_evon');
    expect(out).toContain('files:');
    expect(out).toContain('via ');
    expect(() => {
      JSON.parse(out);
    }).toThrow();
  });

  it('keeps human output from the same typed result as the JSON data', async () => {
    const root = await copySampleWorkspace();
    const jsonRun = captureContext(root, true);
    const humanRun = captureContext(root, false);

    await contextCommand('quokka zephyr', {}, jsonRun.context);
    await contextCommand('quokka zephyr', {}, humanRun.context);

    const bundle = bundleOf(parseEnvelope(jsonRun.output().out));
    expect(bundle.files).toEqual([]);
    expect(humanRun.output().out).toContain('branches: none matched');
    expect(humanRun.output().out).not.toContain('files:');
  });
});

describe('context JSON fixtures', () => {
  it('keeps the project-scoped posterior fixture in sync with actual output', async () => {
    const root = await copySampleWorkspace();

    const result = await withoutRipgrep(async () => {
      const { context, output } = captureContext(root, true);
      await contextCommand('posterior', { project: 'project_evon' }, context);
      return output();
    });

    const actual = parseEnvelope(result.out);
    const fixture = await readFixture(
      'context-project-posterior.sample-workspace.json',
    );
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
    expect(withoutVolatile(actual)).toEqual(withoutVolatile(fixture));
  });

  it('keeps the global preconditioning fixture in sync with actual output', async () => {
    const root = await copySampleWorkspace();

    const result = await withoutRipgrep(async () => {
      const { context, output } = captureContext(root, true);
      await contextCommand('preconditioning', {}, context);
      return output();
    });

    const actual = parseEnvelope(result.out);
    const fixture = await readFixture(
      'context-global-preconditioning.sample-workspace.json',
    );
    expect(Object.keys(actual).sort()).toEqual(Object.keys(fixture).sort());
    expect(withoutVolatile(actual)).toEqual(withoutVolatile(fixture));
  });
});

describe('repository search restriction', () => {
  it.runIf(rgAvailable())(
    'limits context repository matches to the selected project and includes their content',
    async () => {
      const root = await copySampleWorkspace();
      await write(
        root,
        'repositories/evon/hits.txt',
        'matrix stand-in for evon only\n',
      );
      await write(
        root,
        'repositories-archive/soap-bubbles/hits.txt',
        'matrix stand-in for soap bubbles only\n',
      );

      const { exitCode, envelope } = await runContext(root, 'matrix', {
        project: 'project_evon',
      });

      expect(exitCode).toBe(0);
      const bundle = bundleOf(envelope);
      const repositoryFiles = bundle.files.filter(
        (file: ContextFile) => file.repositoryId !== null,
      );
      expect(repositoryFiles.length).toBeGreaterThan(0);
      for (const file of repositoryFiles) {
        expect(file.repositoryId).toBe('resource_repo_evon');
        expect(file.content).toBe('matrix stand-in for evon only\n');
        expect(file.contentTruncated).toBe(false);
      }
    },
  );
});
