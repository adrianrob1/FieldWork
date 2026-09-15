import type { DiagnosticView } from './types.js';

export function parseDiagnostics(body: unknown): DiagnosticView[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(list)) return [];
  return list.filter(isDiagnosticLike).map((value) => toDiagnostic(value));
}

type DiagnosticLike = { code: string; message: string } & Record<
  string,
  unknown
>;

function isDiagnosticLike(value: unknown): value is DiagnosticLike {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.code === 'string' && typeof entry.message === 'string';
}

function toDiagnostic(value: DiagnosticLike): DiagnosticView {
  return {
    code: value.code,
    message: value.message,
    severity: typeof value.severity === 'string' ? value.severity : 'error',
    file: typeof value.file === 'string' ? value.file : '',
    fieldPath: typeof value.fieldPath === 'string' ? value.fieldPath : null,
    line: typeof value.line === 'number' ? value.line : null,
    column: typeof value.column === 'number' ? value.column : null,
  };
}

export function errorTextOf(body: unknown): string | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
  ) {
    return (body as { error: string }).error;
  }
  return null;
}

export function currentHashOf(body: unknown): string | null {
  if (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { currentHash?: unknown }).currentHash === 'string'
  ) {
    return (body as { currentHash: string }).currentHash;
  }
  return null;
}
