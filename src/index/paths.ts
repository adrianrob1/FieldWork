import { access, rename, rm } from 'node:fs/promises';
import path from 'node:path';

export function indexDirectory(root: string): string {
  return path.join(path.resolve(root), '.workspace');
}

export function indexPath(root: string): string {
  return path.join(indexDirectory(root), 'index.sqlite');
}

export function indexNewPath(root: string): string {
  return path.join(indexDirectory(root), 'index.sqlite.new');
}

export function indexOldPath(root: string): string {
  return path.join(indexDirectory(root), 'index.sqlite.old');
}

export async function recoverIndexFiles(root: string): Promise<void> {
  await rm(indexNewPath(root), { force: true });
  if (
    !(await fileExists(indexPath(root))) &&
    (await fileExists(indexOldPath(root)))
  ) {
    await rename(indexOldPath(root), indexPath(root));
  }
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
