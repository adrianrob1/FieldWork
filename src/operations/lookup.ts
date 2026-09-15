import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { stableIdSchema } from '../domain/schemas.js';
import type {
  CanonicalFileKind,
  ParsedWorkspaceFile,
} from '../files/workspace.js';

export function findFileById(
  files: ParsedWorkspaceFile[],
  kind: CanonicalFileKind,
  id: string,
): ParsedWorkspaceFile | null {
  return (
    files.find((file) => file.kind === kind && file.metadata?.id === id) ?? null
  );
}

export function missingObjectDiagnostic(
  root: string,
  kind: 'chat' | 'project' | 'task',
  id: string,
): Diagnostic {
  const label =
    kind === 'chat' ? 'Chat' : kind === 'project' ? 'Project' : 'Task';
  return diagnostic(
    root,
    `${kind}.missing`,
    'error',
    `${label} '${id}' was not found in this workspace.`,
  );
}

export function invalidStableIdDiagnostic(
  root: string,
  label: string,
  value: unknown,
): Diagnostic | null {
  if (stableIdSchema.safeParse(value).success) return null;
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    `${label} '${String(value)}' is not a valid stable ID.`,
  );
}

const invalidDirectoryPattern = /[\\/<>:"|?*]/;

export function invalidDirectoryDiagnostic(
  root: string,
  directory: unknown,
): Diagnostic | null {
  if (
    typeof directory === 'string' &&
    directory.length > 0 &&
    directory !== '.' &&
    directory !== '..' &&
    directory.trim() === directory &&
    !invalidDirectoryPattern.test(directory)
  ) {
    return null;
  }
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    `Project directory '${String(directory)}' must be a single non-empty directory name.`,
  );
}

export function hasError(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((entry) => entry.severity === 'error');
}
