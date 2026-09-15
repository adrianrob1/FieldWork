import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';

// Shared cancellation decisions for the streaming exchange/submit operations.
// The HTTP layer aborts a signal when the client connection closes mid-stream;
// these helpers keep the "nothing persists on cancel" rule in one place and
// unit-testable.

export function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function cancelledDiagnostic(
  file: string,
  operation: 'chat' | 'draft',
): Diagnostic {
  return diagnostic(
    file,
    'operation.cancelled',
    'warning',
    `The ${operation} was cancelled before the transcript was written; nothing was saved.`,
  );
}
