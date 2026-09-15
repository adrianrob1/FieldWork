import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCmdLine,
  resolveCommandFile,
  resolveSpawn,
  spawning,
} from '../../src/backends/command.js';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fieldwork-command-'));
  tempDirs.push(dir);
  return dir;
}

function makeFile(dir: string, name: string, body = 'stub'): string {
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

// Models a Windows-style case-insensitive filesystem backed by an explicit set
// of fake absolute paths. The pure tests never touch the real filesystem.
function fakeExists(...paths: string[]): (absolutePath: string) => boolean {
  const known = new Set(paths.map((path) => path.toLowerCase()));
  return (absolutePath) => known.has(absolutePath.toLowerCase());
}

function samePath(actual: string | null, expected: string): void {
  expect(actual?.toLowerCase()).toBe(expected.toLowerCase());
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveCommandFile platform gating', () => {
  it('returns the command unchanged off win32', () => {
    const neverProbed = fakeExists();
    expect(
      resolveCommandFile('opencode', {
        path: '',
        pathExt: '.CMD',
        platform: 'linux',
        exists: neverProbed,
      }),
    ).toBe('opencode');
    expect(
      resolveCommandFile('opencode', {
        path: '',
        pathExt: '.CMD',
        platform: 'darwin',
        exists: neverProbed,
      }),
    ).toBe('opencode');
    expect(resolveSpawn('opencode', ['acp'], { platform: 'linux' })).toEqual({
      file: 'opencode',
      argsPrefix: [],
    });
    expect(resolveSpawn('opencode', ['acp'], { platform: 'darwin' })).toEqual({
      file: 'opencode',
      argsPrefix: [],
    });
  });

  it('does not apply win32 PATHEXT probing off win32', () => {
    const win32Shaped = fakeExists('/usr/bin/opencode.CMD');
    samePath(
      resolveCommandFile('opencode', {
        path: '/usr/bin',
        pathExt: '.CMD',
        platform: 'linux',
        exists: win32Shaped,
      }),
      'opencode',
    );
  });

  it('resolves a bare command through a colon-separated PATH off win32', () => {
    const exists = fakeExists('/usr/bin/opencode');
    expect(
      resolveCommandFile('opencode', {
        path: '/opt/bin:/usr/bin',
        platform: 'linux',
        exists,
      }),
    ).toBe('/usr/bin/opencode');
  });
});

describe('resolveCommandFile PATH resolution', () => {
  it('resolves a bare command in PATHEXT order', () => {
    const exists = fakeExists(
      'C:\\Tools\\tool.exe',
      'C:\\Tools\\tool.bat',
      'C:\\Tools\\tool.cmd',
    );

    samePath(
      resolveCommandFile('tool', {
        path: 'C:\\Tools',
        pathExt: '.COM;.EXE;.BAT;.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.exe',
    );
    samePath(
      resolveCommandFile('tool', {
        path: 'C:\\Tools',
        pathExt: '.BAT;.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.bat',
    );
    samePath(
      resolveCommandFile('tool', {
        path: 'C:\\Tools',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.cmd',
    );
  });

  it('searches PATH left to right and skips empty entries', () => {
    const exists = fakeExists('C:\\Second\\tool.cmd');
    samePath(
      resolveCommandFile('tool', {
        path: ';C:\\First;;C:\\Second;',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Second\\tool.cmd',
    );
  });

  it('handles PATHEXT entries without a leading dot and odd casing', () => {
    const exists = fakeExists('C:\\Tools\\tool.cmd');
    samePath(
      resolveCommandFile('tool', {
        path: 'C:\\Tools',
        pathExt: 'cmd;exe',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.cmd',
    );
  });

  it('defaults PATHEXT to .COM;.EXE;.BAT;.CMD when unset', () => {
    const exists = fakeExists('C:\\Tools\\tool.cmd');
    const previous = process.env.PATHEXT;
    delete process.env.PATHEXT;
    try {
      samePath(
        resolveCommandFile('tool', {
          path: 'C:\\Tools',
          platform: 'win32',
          exists,
        }),
        'C:\\Tools\\tool.cmd',
      );
    } finally {
      if (previous === undefined) delete process.env.PATHEXT;
      else process.env.PATHEXT = previous;
    }
  });

  it('probes an extension-explicit command as-is first', () => {
    const exists = fakeExists('C:\\Tools\\tool.cmd', 'C:\\Tools\\tool.exe');
    samePath(
      resolveCommandFile('tool.cmd', {
        path: 'C:\\Tools',
        pathExt: '.EXE;.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.cmd',
    );
  });

  it('prefers an extensionless match for a bare command only when present', () => {
    const exists = fakeExists('C:\\Tools\\tool', 'C:\\Tools\\tool.cmd');
    samePath(
      resolveCommandFile('tool', {
        path: 'C:\\Tools',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool.cmd',
    );
    samePath(
      resolveCommandFile('C:\\Tools\\tool', {
        path: '',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\tool',
    );
  });

  it('probes paths that contain a separator as-is before PATHEXT', () => {
    const exists = fakeExists(
      'C:\\Tools\\fakecli.cmd',
      'C:\\Tools\\plain',
      'C:/Tools/forward.cmd',
    );

    samePath(
      resolveCommandFile('C:\\Tools\\fakecli', {
        path: '',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\fakecli.cmd',
    );
    samePath(
      resolveCommandFile('C:\\Tools\\plain', {
        path: '',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:\\Tools\\plain',
    );
  });

  it('accepts forward slashes in explicit win32 paths', () => {
    const exists = fakeExists('C:/Tools/forward.cmd');
    samePath(
      resolveCommandFile('C:/Tools/forward', {
        path: '',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:/Tools/forward.cmd',
    );
  });

  it('accepts forward slashes when joining win32 PATH entries', () => {
    const exists = fakeExists('C:/Tools\\tool.cmd');
    samePath(
      resolveCommandFile('tool', {
        path: 'C:/Tools',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
      'C:/Tools\\tool.cmd',
    );
  });

  it('treats a .ps1-only match as unresolved', () => {
    const ps1Only = fakeExists('C:\\Tools\\script.ps1');
    expect(
      resolveCommandFile('script', {
        path: 'C:\\Tools',
        pathExt: '.PS1;.CMD',
        platform: 'win32',
        exists: ps1Only,
      }),
    ).toBeNull();

    const withCmd = fakeExists(
      'C:\\Tools\\script.ps1',
      'C:\\Tools\\script.cmd',
    );
    samePath(
      resolveCommandFile('script', {
        path: 'C:\\Tools',
        pathExt: '.PS1;.CMD',
        platform: 'win32',
        exists: withCmd,
      }),
      'C:\\Tools\\script.cmd',
    );
  });

  it('returns null and preserves the original command when unresolved', () => {
    const exists = fakeExists();
    expect(
      resolveCommandFile('definitely-not-a-real-cli-xyz', {
        path: 'C:\\Tools',
        pathExt: '.CMD',
        platform: 'win32',
        exists,
      }),
    ).toBeNull();
    expect(
      resolveSpawn('definitely-not-a-real-cli-xyz', [], {
        platform: 'win32',
        path: 'C:\\Tools',
        pathExt: '.CMD',
        exists,
      }),
    ).toEqual({ file: 'definitely-not-a-real-cli-xyz', argsPrefix: [] });
  });
});

describe('resolveSpawn Windows shell wrapping', () => {
  it('wraps .cmd and .bat in the ComSpec shell, leaves .exe direct', () => {
    const exists = fakeExists(
      'C:\\Tools\\tool.cmd',
      'C:\\Tools\\legacy.bat',
      'C:\\Tools\\native.exe',
    );

    const wrapped = resolveSpawn('tool', ['a b'], {
      platform: 'win32',
      path: 'C:\\Tools',
      pathExt: '.CMD',
      exists,
      comSpec: 'cmd.exe',
    });
    expect(wrapped.file).toBe('cmd.exe');
    expect(wrapped.argsPrefix.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    samePath(wrapped.argsPrefix[3] ?? null, `""C:\\Tools\\tool.cmd" "a b""`);

    const batWrapped = resolveSpawn('legacy', [], {
      platform: 'win32',
      path: 'C:\\Tools',
      pathExt: '.BAT',
      exists,
      comSpec: 'cmd.exe',
    });
    expect(batWrapped.file).toBe('cmd.exe');
    samePath(batWrapped.argsPrefix[3] ?? null, `""C:\\Tools\\legacy.bat""`);

    const direct = resolveSpawn('native', ['--flag'], {
      platform: 'win32',
      path: 'C:\\Tools',
      pathExt: '.EXE',
      exists,
    });
    expect(direct.file.toLowerCase()).toBe('c:\\tools\\native.exe');
    expect(direct.argsPrefix).toEqual([]);
  });

  it('falls back to cmd.exe when ComSpec is unavailable', () => {
    const exists = fakeExists('C:\\Tools\\tool.cmd');
    const previous = process.env.ComSpec;
    delete process.env.ComSpec;
    try {
      const spawnCommand = resolveSpawn('tool', [], {
        platform: 'win32',
        path: 'C:\\Tools',
        pathExt: '.CMD',
        exists,
      });
      expect(spawnCommand.file).toBe('cmd.exe');
      samePath(
        spawnCommand.argsPrefix.at(-1) ?? null,
        `""C:\\Tools\\tool.cmd""`,
      );
    } finally {
      if (previous === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previous;
    }
  });
});

describe('buildCmdLine quoting', () => {
  it('quotes the program path after stripping quotes', () => {
    expect(buildCmdLine('"C:\\Program Files\\tool.cmd"', [])).toBe(
      '""C:\\Program Files\\tool.cmd""',
    );
  });

  it('quotes arguments with spaces and doubles inner quotes', () => {
    expect(buildCmdLine('C:\\tool.cmd', ['hello world'])).toBe(
      '""C:\\tool.cmd" "hello world""',
    );
    expect(buildCmdLine('C:\\tool.cmd', ['say "hi"'])).toBe(
      '""C:\\tool.cmd" "say ""hi""""',
    );
  });

  it('quotes cmd metacharacter and unicode arguments', () => {
    expect(buildCmdLine('C:\\tool.cmd', ['a&b|c'])).toBe(
      '""C:\\tool.cmd" "a&b|c""',
    );
    expect(buildCmdLine('C:\\tool.cmd', ['%PATH%'])).toBe(
      '""C:\\tool.cmd" "%PATH%""',
    );
    expect(buildCmdLine('C:\\tool.cmd', ['café ☕'])).toBe(
      '""C:\\tool.cmd" "café ☕""',
    );
  });
});

function runReal(
  file: string,
  args: string[],
  windowsVerbatimArguments: boolean,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsVerbatimArguments,
    });
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.on('error', reject);
    child.on('close', () => resolve(stdout));
  });
}

describe.skipIf(process.platform !== 'win32')('live cmd shim execution', () => {
  it('runs a .cmd shim found via PATH through the ComSpec wrapper', async () => {
    const dir = makeTempDir();
    makeFile(dir, 'fakecli.cmd', '@echo fake-ok %~1\r\n');
    const previous = process.env.PATH;
    process.env.PATH = `${dir};${previous ?? ''}`;
    try {
      const { file, argsPrefix } = spawning('fakecli', ['hello world']);
      expect(file.toLowerCase()).toContain('cmd.exe');
      const stdout = await runReal(file, argsPrefix, true);
      expect(stdout).toContain('fake-ok hello world');
    } finally {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    }
  });

  it('rejects a missing CLI naming the original command', async () => {
    const { file, argsPrefix } = spawning('definitely-not-a-real-cli-xyz', []);
    await expect(runReal(file, argsPrefix, false)).rejects.toThrow(
      /definitely-not-a-real-cli-xyz/,
    );
  });
});
