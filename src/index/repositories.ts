import { spawn } from 'node:child_process';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  parseWorkspace,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import type { WorkspaceDatabase } from './database.js';

export interface RepositoryMatch {
  repositoryId: string;
  path: string;
  line: number;
  text: string;
}

export interface RepositorySearchResult {
  rgAvailable: boolean;
  matches: RepositoryMatch[];
  counts: Record<string, number>;
  diagnostics: Diagnostic[];
}

export interface RepositorySearchOptions {
  repositories?: string[];
}

export function repositoryIdsForProject(
  database: WorkspaceDatabase,
  projectId: string,
): string[] {
  return database
    .all<{ id: string }>(
      `SELECT id FROM repositories WHERE source_path = (SELECT path FROM objects WHERE id = ? AND type = 'project') ORDER BY id`,
      projectId,
    )
    .map((row) => row.id);
}

interface RepositoryTarget {
  id: string;
  absolutePath: string;
}

interface ProcessOutput {
  error: Error | null;
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function searchRepositories(
  root: string,
  query: string,
  options: RepositorySearchOptions = {},
): Promise<RepositorySearchResult> {
  const parsed = await parseWorkspace(root);
  const targets = collectRepositories(parsed.files).filter(
    (target) =>
      options.repositories === undefined ||
      options.repositories.includes(target.id),
  );
  const probe = await runProcess('rg', ['--version']);
  if (probe.error !== null) {
    return {
      rgAvailable: false,
      matches: [],
      counts: {},
      diagnostics: [
        ...parsed.diagnostics,
        diagnostic(
          parsed.root,
          'rg.missing',
          'warning',
          "The 'rg' executable was not found on PATH; repository search is unavailable. Install ripgrep: https://github.com/BurntSushi/ripgrep",
        ),
      ],
    };
  }
  if (targets.length === 0 || query.trim() === '') {
    return {
      rgAvailable: true,
      matches: [],
      counts: Object.fromEntries(targets.map((target) => [target.id, 0])),
      diagnostics: parsed.diagnostics,
    };
  }

  const output = await runProcess('rg', [
    '--json',
    '-e',
    query,
    ...targets.map((target) => target.absolutePath),
  ]);
  const matches: RepositoryMatch[] = [];
  for (const line of output.stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    const event = parseEvent(line);
    if (event === null) continue;
    const target = ownerOf(targets, event.file);
    if (target === null) continue;
    matches.push({
      repositoryId: target.id,
      path: path
        .relative(target.absolutePath, event.file)
        .split(path.sep)
        .join('/'),
      line: event.line,
      text: event.text,
    });
  }
  matches.sort(compareMatches);
  const counts: Record<string, number> = Object.fromEntries(
    targets.map((target) => [target.id, 0]),
  );
  for (const match of matches) {
    counts[match.repositoryId] = (counts[match.repositoryId] ?? 0) + 1;
  }

  const diagnostics = [...parsed.diagnostics];
  if (output.error !== null || (output.code !== 0 && output.code !== 1)) {
    diagnostics.push(
      diagnostic(
        parsed.root,
        'rg.failed',
        'error',
        `ripgrep exited unexpectedly: ${summarizeError(output)}`,
      ),
    );
  }
  return { rgAvailable: true, matches, counts, diagnostics };
}

function collectRepositories(files: ParsedWorkspaceFile[]): RepositoryTarget[] {
  const targets = new Map<string, RepositoryTarget>();
  for (const file of files) {
    if (file.kind !== 'project') continue;
    const entries = Array.isArray(file.metadata?.repositories)
      ? file.metadata.repositories
      : [];
    entries.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      if (typeof entry.id !== 'string' || typeof entry.path !== 'string') {
        return;
      }
      const resolution = file.resolvedPaths.find(
        (candidate) => candidate.fieldPath === `repositories.${index}.path`,
      );
      if (!resolution || !resolution.accessible) return;
      targets.set(entry.id, {
        id: entry.id,
        absolutePath: resolution.resolvedPath,
      });
    });
  }
  return [...targets.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function ownerOf(
  targets: RepositoryTarget[],
  file: string,
): RepositoryTarget | null {
  const resolved = path.resolve(file);
  for (const target of targets) {
    const relative = path.relative(target.absolutePath, resolved);
    if (
      relative !== '' &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative)
    ) {
      return target;
    }
  }
  return null;
}

function parseEvent(
  line: string,
): { file: string; line: number; text: string } | null {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(event) || event.type !== 'match' || !isRecord(event.data)) {
    return null;
  }
  const data = event.data;
  if (!isRecord(data.path) || typeof data.path.text !== 'string') return null;
  if (!isRecord(data.lines) || typeof data.lines.text !== 'string') return null;
  if (typeof data.line_number !== 'number') return null;
  return {
    file: data.path.text,
    line: data.line_number,
    text: data.lines.text.replace(/\r?\n$/, ''),
  };
}

function runProcess(command: string, args: string[]): Promise<ProcessOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (error) {
      resolve({
        error: error instanceof Error ? error : new Error(String(error)),
        code: null,
        stdout: '',
        stderr: '',
      });
      return;
    }
    let stdout = '';
    let stderr = '';
    let failure: Error | null = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error: Error) => {
      failure = error;
    });
    child.on('close', (code: number | null) => {
      resolve({ error: failure, code, stdout, stderr });
    });
  });
}

function summarizeError(output: ProcessOutput): string {
  if (output.error !== null) return output.error.message;
  const detail = output.stderr.trim().split(/\r?\n/)[0] ?? '';
  return `exit code ${String(output.code)}${detail === '' ? '' : `: ${detail}`}`;
}

function compareMatches(left: RepositoryMatch, right: RepositoryMatch): number {
  if (left.repositoryId !== right.repositoryId) {
    return left.repositoryId < right.repositoryId ? -1 : 1;
  }
  if (left.path !== right.path) return left.path < right.path ? -1 : 1;
  return left.line - right.line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
