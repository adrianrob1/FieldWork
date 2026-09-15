import { stat } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { findWorkspaceRoot } from '../files/workspaceRoot.js';

export interface WorkspaceResolution {
  root: string;
  source: 'option' | 'settings' | 'default';
  diagnostic: Diagnostic | null;
}

export async function resolveWorkspaceRoot(
  explicit?: string,
): Promise<WorkspaceResolution> {
  if (explicit !== undefined) {
    const root = path.resolve(explicit);
    if (await isDirectory(root)) {
      return { root, source: 'option', diagnostic: null };
    }
    return {
      root,
      source: 'option',
      diagnostic: diagnostic(
        root,
        'workspace.missing',
        'error',
        `Workspace directory does not exist: ${root}`,
      ),
    };
  }
  const current = process.cwd();
  const found = await findWorkspaceRoot(current);
  if (found !== null) {
    return { root: found, source: 'settings', diagnostic: null };
  }
  return { root: current, source: 'default', diagnostic: null };
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}
