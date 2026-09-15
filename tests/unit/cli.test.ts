import { cp, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { commanderExitCode, createProgram } from '../../src/cli.js';

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

function captureExitOverride(command: Command, errors: CommanderError[]): void {
  command.configureOutput({
    writeOut: () => undefined,
    writeErr: () => undefined,
  });
  command.exitOverride((error) => {
    errors.push(error);
    throw error;
  });
  for (const child of command.commands) {
    captureExitOverride(child, errors);
  }
}

async function runArgv(argv: string[]): Promise<CommanderError | null> {
  const run = createProgram();
  const errors: CommanderError[] = [];
  captureExitOverride(run.program, errors);
  try {
    await run.program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
  }
  return errors.length === 1 ? (errors[0] ?? null) : null;
}

describe('CLI usage errors', () => {
  it('maps unknown commands to exit code 2', async () => {
    const error = await runArgv(['frobnicate']);

    expect(error).toBeInstanceOf(CommanderError);
    expect(error?.code).toBe('commander.unknownCommand');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps unknown options to exit code 2', async () => {
    const error = await runArgv(['validate', '--nope']);

    expect(error?.code).toBe('commander.unknownOption');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps missing required arguments to exit code 2', async () => {
    const error = await runArgv(['project', 'show']);

    expect(error?.code).toBe('commander.missingArgument');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps unknown options on nested subcommands to exit code 2', async () => {
    const error = await runArgv(['project', 'list', '--nope']);

    expect(error?.code).toBe('commander.unknownOption');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps an invalid watch debounce option to exit code 2', async () => {
    const error = await runArgv(['watch', '--debounce', 'nope']);

    expect(error?.code).toBe('commander.invalidArgument');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps conflicting context scopes to exit code 2', async () => {
    const error = await runArgv([
      'context',
      'query',
      '--project',
      'project_a',
      '--chat',
      'chat_a',
    ]);

    expect(error?.code).toBe('commander.conflictingOption');
    expect(commanderExitCode(error)).toBe(2);
  });

  it('maps help and version requests to exit code 0', async () => {
    const help = await runArgv(['--help']);
    expect(commanderExitCode(help)).toBe(0);

    const version = await runArgv(['--version']);
    expect(commanderExitCode(version)).toBe(0);
  });
});

describe('CLI command wiring', () => {
  it('runs validate through the program and records its exit code', async () => {
    const run = createProgram();

    await run.program.parseAsync(
      [
        'validate',
        '--workspace',
        `${repositoryRoot}/examples/sample-workspace`,
        '--json',
      ],
      { from: 'user' },
    );

    expect(run.exitCode()).toBe(0);
  });

  it('records a failed command exit code', async () => {
    const run = createProgram();

    await run.program.parseAsync(
      ['validate', '--workspace', 'fieldwork-missing-workspace'],
      { from: 'user' },
    );

    expect(run.exitCode()).toBe(1);
  });

  it('runs rebuild through the program and records its exit code', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-cli-'));
    temporaryDirectories.push(root);
    await cp(sampleWorkspace, root, { recursive: true });
    const run = createProgram();

    await run.program.parseAsync(['rebuild', '--workspace', root, '--json'], {
      from: 'user',
    });

    expect(run.exitCode()).toBe(0);
  }, 20_000);
});
