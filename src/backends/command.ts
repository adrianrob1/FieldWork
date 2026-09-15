import { existsSync } from 'node:fs';

const DEFAULT_PATH_EXT = '.COM;.EXE;.BAT;.CMD';

export interface SpawnCommand {
  file: string;
  argsPrefix: string[];
}

export interface CommandResolutionOptions {
  path?: string | undefined;
  pathExt?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  exists?: ((absolutePath: string) => boolean) | undefined;
  separator?: ';' | ':' | undefined;
}

export interface SpawnContext extends CommandResolutionOptions {
  comSpec?: string | undefined;
}

export function spawning(command: string, args: string[]): SpawnCommand {
  return resolveSpawn(command, args);
}

export function resolveSpawn(
  command: string,
  args: string[],
  context: SpawnContext = {},
): SpawnCommand {
  const platform = context.platform ?? process.platform;
  if (platform !== 'win32') {
    return { file: command, argsPrefix: [] };
  }
  const resolved = resolveCommandFile(command, {
    path: context.path,
    pathExt: context.pathExt,
    platform,
    exists: context.exists,
    separator: context.separator,
  });
  if (resolved === null) {
    return { file: command, argsPrefix: [] };
  }
  const lower = resolved.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return {
      file: context.comSpec ?? process.env.ComSpec ?? 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', buildCmdLine(resolved, args)],
    };
  }
  return { file: resolved, argsPrefix: [] };
}

export function resolveCommandFile(
  command: string,
  options: CommandResolutionOptions = {},
): string | null {
  const platform = options.platform ?? process.platform;
  const separator = options.separator ?? (platform === 'win32' ? ';' : ':');
  const exists = options.exists ?? existsSync;
  if (platform !== 'win32') {
    return resolvePosixCommand(command, options.path, exists, separator);
  }
  const extensions = pathExtensions(options.pathExt);
  if (hasPathSeparator(command)) {
    return probeCandidates(command, extensions, true, exists);
  }
  const namedWithExtension = hasKnownExtension(command, extensions);
  const path = options.path ?? process.env.PATH ?? '';
  for (const dir of path.split(separator)) {
    if (dir.length === 0) continue;
    const found = probeCandidates(
      joinWin32Path(dir, command),
      extensions,
      namedWithExtension,
      exists,
    );
    if (found !== null) return found;
  }
  return null;
}

export function buildCmdLine(program: string, args: string[]): string {
  const parts = [`"${program.replace(/"/g, '')}"`];
  for (const arg of args) {
    parts.push(`"${arg.replace(/"/g, '""')}"`);
  }
  return `"${parts.join(' ')}"`;
}

function resolvePosixCommand(
  command: string,
  envPath: string | undefined,
  exists: (absolutePath: string) => boolean,
  separator: ';' | ':',
): string {
  if (hasPathSeparator(command)) return command;
  const path = envPath ?? process.env.PATH ?? '';
  for (const dir of path.split(separator)) {
    if (dir.length === 0) continue;
    const candidate = joinPosixPath(dir, command);
    if (exists(candidate)) return candidate;
  }
  return command;
}

function pathExtensions(envPathExt: string | undefined): string[] {
  const raw = envPathExt ?? process.env.PATHEXT ?? DEFAULT_PATH_EXT;
  const seen = new Set<string>();
  const extensions: string[] = [];
  for (const part of raw.split(';')) {
    const ext = part.trim();
    if (ext.length === 0) continue;
    const withDot = ext.startsWith('.') ? ext : `.${ext}`;
    const key = withDot.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    extensions.push(withDot);
  }
  return extensions;
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\');
}

function hasKnownExtension(command: string, extensions: string[]): boolean {
  const lower = command.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext.toLowerCase()));
}

function trimTrailingSeparator(dir: string): string {
  return dir.endsWith('/') || dir.endsWith('\\') ? dir.slice(0, -1) : dir;
}

function joinWin32Path(dir: string, command: string): string {
  return `${trimTrailingSeparator(dir)}\\${command}`;
}

function joinPosixPath(dir: string, command: string): string {
  return `${dir.endsWith('/') ? dir.slice(0, -1) : dir}/${command}`;
}

function probeCandidates(
  base: string,
  extensions: string[],
  includeBaseAsIs: boolean,
  exists: (absolutePath: string) => boolean,
): string | null {
  if (includeBaseAsIs && isExecutableFile(base, exists)) return base;
  for (const ext of extensions) {
    const candidate = `${base}${ext}`;
    if (isExecutableFile(candidate, exists)) return candidate;
  }
  return null;
}

function isExecutableFile(
  candidate: string,
  exists: (absolutePath: string) => boolean,
): boolean {
  if (!exists(candidate)) return false;
  // PowerShell scripts are intentionally not run: npm ships a sibling .cmd
  // shim and PATHEXT ordering prefers it, so a .ps1-only match is unresolved.
  if (candidate.toLowerCase().endsWith('.ps1')) return false;
  return true;
}
