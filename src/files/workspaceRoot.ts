import { access } from 'node:fs/promises';
import path from 'node:path';

export async function findWorkspaceRoot(start: string): Promise<string | null> {
  let current = path.resolve(start);
  for (;;) {
    if (await exists(path.join(current, 'workspace.yml'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
