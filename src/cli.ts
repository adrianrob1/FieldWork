#!/usr/bin/env node

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Command,
  CommanderError,
  InvalidArgumentError,
  Option,
} from 'commander';

import {
  chatAttachCommand,
  chatDetachCommand,
  chatPromoteCommand,
  chatShowCommand,
} from './commands/chat.js';
import { contextCommand } from './commands/context.js';
import {
  chatSendCommand,
  chatStartCommand,
  type ChatStartOptions,
} from './commands/exchange.js';
import { backendListCommand } from './commands/backend.js';
import { projectListCommand, projectShowCommand } from './commands/project.js';
import { processIo, type CommandContext } from './commands/output.js';
import { rebuildCommand } from './commands/rebuild.js';
import { projectRegisterCommand } from './commands/register.js';
import { searchCommand } from './commands/search.js';
import { serveCommand, type ServeCommandOptions } from './commands/serve.js';
import { validateCommand } from './commands/validate.js';
import { watchCommand, type WatchCommandOptions } from './commands/watch.js';

export interface ProgramRun {
  program: Command;
  exitCode(): number;
}

export function createProgram(): ProgramRun {
  let commandExitCode = 0;
  const program = new Command();
  program.exitOverride((error) => {
    throw error;
  });

  const facts = readPackageFacts();
  program
    .name('fieldwork')
    .description(facts.description)
    .version(facts.version);
  program.option(
    '--workspace <path>',
    'workspace root directory; without it, search upward from the current directory for workspace.yml',
  );

  const validate = program
    .command('validate')
    .description('Report file counts and diagnostics for the workspace');
  addCommandOptions(validate);
  validate.action(async () => {
    commandExitCode = await validateCommand(contextOf(validate));
  });

  const project = program
    .command('project')
    .description('Inspect workspace projects');

  const list = project
    .command('list')
    .description('List projects sorted by stable ID');
  addCommandOptions(list);
  list.action(async () => {
    commandExitCode = await projectListCommand(contextOf(list));
  });

  const show = project
    .command('show <project-id>')
    .description('Show one project by stable ID');
  addCommandOptions(show);
  show.action(async (projectId: string) => {
    commandExitCode = await projectShowCommand(projectId, contextOf(show));
  });

  const watch = program
    .command('watch')
    .description('Watch workspace files and keep the derived index current');
  watch.option(
    '--workspace <path>',
    'workspace root directory; without it, search upward from the current directory for workspace.yml',
  );
  watch.option(
    '--debounce <ms>',
    'debounce window in milliseconds for change batches',
    parseNonNegativeInteger,
  );
  watch.action(async () => {
    commandExitCode = await watchCommand(
      contextOf(watch),
      watchOptionsOf(watch),
    );
  });

  const serve = program
    .command('serve')
    .description(
      'Serve the local web interface with project, chat, inbox, and search views',
    );
  serve.option('--port <n>', 'TCP port to listen on', parsePort);
  serve.option('--host <addr>', 'address to bind');
  addCommandOptions(serve);
  serve.action(async () => {
    commandExitCode = await serveCommand(
      contextOf(serve),
      serveOptionsOf(serve),
    );
  });

  const rebuild = program
    .command('rebuild')
    .description('Rebuild the derived index from workspace files');
  addCommandOptions(rebuild);
  rebuild.action(async () => {
    commandExitCode = await rebuildCommand(contextOf(rebuild));
  });

  const register = project
    .command('register <directory>')
    .description('Register a new project manifest')
    .requiredOption('--id <id>', 'stable project ID')
    .requiredOption('--title <title>', 'project title')
    .option(
      '--repository <path>',
      'local repository path; repeat to add several',
      repeatable,
      [],
    );
  addCommandOptions(register);
  register.action(async (directory: string) => {
    const options = register.opts<{
      id: string;
      title: string;
      repository?: string[];
    }>();
    commandExitCode = await projectRegisterCommand(
      directory,
      {
        id: options.id,
        title: options.title,
        repositories: options.repository ?? [],
      },
      contextOf(register),
    );
  });

  const backend = program
    .command('backend')
    .description('Inspect configured chat backends');

  const backendList = backend
    .command('list')
    .description('List configured chat backends with a status line');
  addCommandOptions(backendList);
  backendList.action(async () => {
    commandExitCode = await backendListCommand(contextOf(backendList));
  });

  const chat = program.command('chat').description('Manage workspace chats');

  const chatStart = chat
    .command('start')
    .description('Create a new chat file with an optional first user message')
    .requiredOption('--id <id>', 'stable chat ID')
    .requiredOption('--title <title>', 'chat title')
    .option(
      '--topic <topic>',
      'topic label; repeat to add several',
      repeatable,
      [],
    )
    .option(
      '--project <project-id>',
      'project to attach; repeat to add several',
      repeatable,
      [],
    )
    .option('--message <text>', 'seed the transcript with one user message');
  addCommandOptions(chatStart);
  chatStart.action(async () => {
    const options = chatStart.opts<{
      id: string;
      title: string;
      topic?: string[];
      project?: string[];
      message?: string;
    }>();
    const input: ChatStartOptions = {
      id: options.id,
      title: options.title,
      topics: options.topic ?? [],
      projects: options.project ?? [],
      message: options.message,
    };
    commandExitCode = await chatStartCommand(input, contextOf(chatStart));
  });

  const chatSend = chat
    .command('send <chat-id>')
    .description('Continue a chat through a configured backend')
    .requiredOption('--message <text>', 'message text to send')
    .option(
      '--backend <name>',
      'backend entry to use; defaults to the configured default backend',
    );
  addCommandOptions(chatSend);
  chatSend.action(async (chatId: string) => {
    const options = chatSend.opts<{ message: string; backend?: string }>();
    commandExitCode = await chatSendCommand(
      chatId,
      { message: options.message, backend: options.backend },
      contextOf(chatSend),
    );
  });

  const chatShow = chat
    .command('show <chat-id>')
    .description('Show one chat transcript by stable ID');
  addCommandOptions(chatShow);
  chatShow.action(async (chatId: string) => {
    commandExitCode = await chatShowCommand(chatId, contextOf(chatShow));
  });

  const attach = chat
    .command('attach <chat-id>')
    .description('Attach a chat to a project')
    .requiredOption('--project <project-id>', 'stable project ID');
  addCommandOptions(attach);
  attach.action(async (chatId: string) => {
    const options = attach.opts<{ project: string }>();
    commandExitCode = await chatAttachCommand(
      chatId,
      options.project,
      contextOf(attach),
    );
  });

  const detach = chat
    .command('detach <chat-id>')
    .description('Detach a chat from a project')
    .requiredOption('--project <project-id>', 'stable project ID');
  addCommandOptions(detach);
  detach.action(async (chatId: string) => {
    const options = detach.opts<{ project: string }>();
    commandExitCode = await chatDetachCommand(
      chatId,
      options.project,
      contextOf(detach),
    );
  });

  const promote = chat
    .command('promote <chat-id>')
    .description('Create a project from a chat and attach the chat to it')
    .requiredOption('--id <id>', 'stable ID for the new project')
    .requiredOption('--title <title>', 'project title')
    .option(
      '--directory <name>',
      'project directory name; defaults to the project ID',
    );
  addCommandOptions(promote);
  promote.action(async (chatId: string) => {
    const options = promote.opts<{
      id: string;
      title: string;
      directory?: string;
    }>();
    commandExitCode = await chatPromoteCommand(
      chatId,
      options,
      contextOf(promote),
    );
  });

  const search = program
    .command('search <query>')
    .description(
      'Run a lexical search over the workspace and registered repositories',
    );
  search.option(
    '--project <project-id>',
    'restrict index matches to one project and its referencing objects',
  );
  addCommandOptions(search);
  search.action(async (query: string) => {
    commandExitCode = await searchCommand(
      query,
      search.opts<{ project?: string }>(),
      contextOf(search),
    );
  });

  const context = program
    .command('context <query>')
    .description(
      'Build a bounded context bundle: at most two summary branches and ten documents with trails',
    );
  context.option(
    '--project <project-id>',
    'route within the summaries of one project',
  );
  context.addOption(
    new Option(
      '--chat <chat-id>',
      "seed branches from a chat's attached projects",
    ).conflicts('project'),
  );
  addCommandOptions(context);
  context.action(async (query: string) => {
    commandExitCode = await contextCommand(
      query,
      context.opts<{ project?: string; chat?: string }>(),
      contextOf(context),
    );
  });

  return {
    program,
    exitCode: () => commandExitCode,
  };
}

function repeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function commanderExitCode(error: CommanderError): number {
  return error.exitCode === 0 ? 0 : 2;
}

function addCommandOptions(command: Command): void {
  command.option(
    '--json',
    'emit one JSON document instead of human-readable output',
  );
  command.option(
    '--workspace <path>',
    'workspace root directory; without it, search upward from the current directory for workspace.yml',
  );
}

function contextOf(command: Command): CommandContext {
  const values = command.optsWithGlobals<Record<string, unknown>>();
  return {
    workspace:
      typeof values.workspace === 'string' ? values.workspace : undefined,
    json: values.json === true,
    io: processIo(),
  };
}

function watchOptionsOf(command: Command): WatchCommandOptions {
  const values = command.opts<{ debounce?: number }>();
  return values.debounce === undefined ? {} : { debounceMs: values.debounce };
}

function serveOptionsOf(command: Command): ServeCommandOptions {
  const values = command.opts<{ port?: number; host?: string }>();
  const options: ServeCommandOptions = {};
  if (values.port !== undefined) options.port = values.port;
  if (values.host !== undefined) options.host = values.host;
  return options;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new InvalidArgumentError(
      `expected a TCP port between 0 and 65535, got '${value}'`,
    );
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(
      `expected a non-negative integer number of milliseconds, got '${value}'`,
    );
  }
  return parsed;
}

interface PackageFacts {
  version: string;
  description: string;
}

function readPackageFacts(): PackageFacts {
  const file = fileURLToPath(new URL('../package.json', import.meta.url));
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    isRecord(parsed) &&
    typeof parsed.version === 'string' &&
    typeof parsed.description === 'string'
  ) {
    return { version: parsed.version, description: parsed.description };
  }
  return {
    version: '0.0.0',
    description: 'Local-first research workspace core',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const run = createProgram();
  try {
    await run.program.parseAsync(process.argv);
    process.exitCode = run.exitCode();
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exitCode = commanderExitCode(error);
      return;
    }
    process.stderr.write(`Unexpected error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(path.resolve(entry)) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (isEntry()) {
  await main();
}
