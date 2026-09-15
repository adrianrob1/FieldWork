export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  file: string;
  fieldPath: string | null;
  message: string;
  line: number | null;
  column: number | null;
}

export function diagnostic(
  file: string,
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  options: {
    fieldPath?: string | null;
    line?: number | null;
    column?: number | null;
  } = {},
): Diagnostic {
  return {
    code,
    severity,
    file,
    fieldPath: options.fieldPath ?? null,
    message,
    line: options.line ?? null,
    column: options.column ?? null,
  };
}
