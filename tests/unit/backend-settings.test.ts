import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backendNameSchema } from '../../src/domain/schemas.js';
import {
  addBackendEntry,
  readBackendSettings,
  setDefaultBackend,
} from '../../src/operations/backendSettings.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fieldwork-backends-'));
  temporaryDirectories.push(root);
  await writeFile(path.join(root, 'workspace.yml'), 'version: 1\n');
  return root;
}

async function add(
  root: string,
  name: string,
  model = 'gpt-5-mini',
): Promise<ReturnType<typeof addBackendEntry>> {
  return addBackendEntry(root, {
    name,
    type: 'openai',
    config: { model },
  });
}

async function listedNames(root: string): Promise<string[]> {
  const result = await readBackendSettings(root);
  if (!result.success || result.data === null) {
    throw new Error('The backend settings could not be read.');
  }
  return result.data.backends.map((entry) => entry.name);
}

describe('backend name validation', () => {
  it('accepts free-form names and rejects empty, over-long, and control names', () => {
    for (const name of [
      'GPT-5 mini',
      'Qwen3 32B local',
      '채팅용 모델',
      '32B local',
      'a',
    ]) {
      expect(backendNameSchema.safeParse(name).success, name).toBe(true);
    }
    expect(backendNameSchema.safeParse('').success).toBe(false);
    expect(backendNameSchema.safeParse('a'.repeat(100)).success).toBe(true);
    expect(backendNameSchema.safeParse('a'.repeat(101)).success).toBe(false);
    expect(
      backendNameSchema.safeParse(`bad${String.fromCharCode(0)}name`).success,
    ).toBe(false);
    expect(
      backendNameSchema.safeParse(`bad${String.fromCharCode(0x7f)}name`)
        .success,
    ).toBe(false);
  });
});

describe('backend settings operations', () => {
  it('stores trimmed free-form names and round-trips them through YAML', async () => {
    const root = await createWorkspace();

    const addResult = await add(root, '  GPT 5 mini (local)  ');
    expect(addResult.success).toBe(true);
    expect(addResult.data?.backends.map((entry) => entry.name)).toContain(
      'GPT 5 mini (local)',
    );

    const contents = await readFile(path.join(root, 'workspace.yml'), 'utf8');
    expect(contents).toContain('GPT 5 mini (local)');
    expect(contents).not.toContain('  GPT 5 mini (local)  ');

    expect(await listedNames(root)).toEqual(['GPT 5 mini (local)']);
  });

  it('round-trips tricky YAML keys and resolves each entry', async () => {
    const root = await createWorkspace();
    const names = ['yes', 'a: b', 'with-quote"', '채팅용 모델'];
    for (const name of names) {
      const result = await add(root, name);
      expect(result.success, name).toBe(true);
    }

    const reloaded = await listedNames(root);
    expect(new Set(reloaded)).toEqual(new Set(names));
  });

  it('lets default reference a spaced name and resolves it', async () => {
    const root = await createWorkspace();
    await add(root, 'GPT 5 mini (local)');

    const result = await setDefaultBackend(root, {
      name: 'GPT 5 mini (local)',
    });
    expect(result.success).toBe(true);
    expect(result.data?.default).toBe('GPT 5 mini (local)');
    expect(result.data?.backends.find((entry) => entry.isDefault)?.name).toBe(
      'GPT 5 mini (local)',
    );
  });

  it('keeps uniqueness exact-match on the trimmed value', async () => {
    const root = await createWorkspace();
    expect((await add(root, 'Spaced Name')).success).toBe(true);

    const duplicate = await add(root, '  Spaced Name  ');
    expect(duplicate.success).toBe(false);
    expect(
      duplicate.diagnostics.some(
        (entry) => entry.code === 'backend.target_exists',
      ),
    ).toBe(true);
  });

  it('rejects empty, whitespace-only, over-long, and control names', async () => {
    const root = await createWorkspace();
    const cases: unknown[] = [
      '',
      '   ',
      'a'.repeat(101),
      `bad${String.fromCharCode(7)}name`,
    ];
    for (const name of cases) {
      const result = await add(root, name as string);
      expect(result.success, JSON.stringify(name)).toBe(false);
      expect(
        result.diagnostics.some(
          (entry) => entry.code === 'backend.name_invalid',
        ),
        JSON.stringify(name),
      ).toBe(true);
    }
    expect(await listedNames(root)).toEqual([]);
  });
});
