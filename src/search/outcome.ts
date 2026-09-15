import type { Diagnostic } from '../domain/diagnostics.js';

const fatalReadCodes = new Set([
  'index.missing',
  'index.refresh_failed',
  'index.rebuild_failed',
  'index.schema_version_unknown',
  'index.query_invalid',
  'index.query_failed',
  'project.missing',
  'chat.missing',
]);

export function isOperationalFailure(
  diagnostics: Diagnostic[],
  rgFatal: boolean,
): boolean {
  return diagnostics.some((entry) => {
    if (entry.severity !== 'error') return false;
    if (fatalReadCodes.has(entry.code)) return true;
    return rgFatal && entry.code === 'rg.failed';
  });
}

export function dedupeDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((entry) => {
    const key = [
      entry.code,
      entry.severity,
      entry.file,
      entry.fieldPath,
      entry.line,
      entry.column,
      entry.message,
    ].join('');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
