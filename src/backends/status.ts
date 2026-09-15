import { stat } from 'node:fs/promises';
import path from 'node:path';

import type { ResolvedBackendConfig } from './config.js';

export async function backendStatus(
  backend: ResolvedBackendConfig,
): Promise<string> {
  switch (backend.type) {
    case 'openai':
      return openAiStatus(backend.apiKeyEnv);
    case 'opencode':
      return commandStatus(backend.command);
    default: {
      const command = (backend as { command?: unknown }).command;
      if (typeof command === 'string') return commandStatus(command);
      const type = (backend as { type?: unknown }).type;
      return `backend type '${String(type)}' cannot be checked`;
    }
  }
}

export function openAiStatus(apiKeyEnv: string | undefined): string {
  return apiKeyEnv === undefined
    ? 'no api key required'
    : process.env[apiKeyEnv] !== undefined && process.env[apiKeyEnv] !== ''
      ? `api key env ${apiKeyEnv} is set`
      : `api key env ${apiKeyEnv} is not set`;
}

export async function commandStatus(command: string): Promise<string> {
  return commandStatusText(command, await commandResolvesOnPath(command));
}

export function commandStatusText(command: string, resolves: boolean): string {
  return resolves
    ? `command '${command}' resolves on PATH`
    : `command '${command}' not found on PATH`;
}

export async function commandResolvesOnPath(command: string): Promise<boolean> {
  if (
    command.includes('/') ||
    command.includes('\\') ||
    path.isAbsolute(command)
  ) {
    for (const candidate of candidateNames(command)) {
      if (await isFile(candidate)) return true;
    }
    return false;
  }
  const directories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((directory) => directory.length > 0);
  for (const directory of directories) {
    for (const candidate of candidateNames(command)) {
      if (await isFile(path.join(directory, candidate))) return true;
    }
  }
  return false;
}

function candidateNames(command: string): string[] {
  if (process.platform !== 'win32') return [command];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.length > 0);
  return [command, ...extensions.map((extension) => command + extension)];
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}
