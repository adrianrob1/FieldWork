import type { Diagnostic } from '../domain/diagnostics.js';

export interface CommandIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CommandContext {
  workspace: string | undefined;
  json: boolean;
  io: CommandIo;
}

export interface CommandEnvelope {
  command: string;
  success: boolean;
  data: unknown;
  diagnostics: Diagnostic[];
}

export interface CommandOutcome {
  success: boolean;
  data: unknown;
  diagnostics: Diagnostic[];
  human: string;
}

export function processIo(): CommandIo {
  return {
    out(text) {
      process.stdout.write(text);
    },
    err(text) {
      process.stderr.write(text);
    },
  };
}

export function failureOutcome(entry: Diagnostic): CommandOutcome {
  return {
    success: false,
    data: null,
    diagnostics: [entry],
    human: '',
  };
}

export function emitResult(
  context: CommandContext,
  command: string,
  outcome: CommandOutcome,
): void {
  if (context.json) {
    const envelope: CommandEnvelope = {
      command,
      success: outcome.success,
      data: outcome.data,
      diagnostics: outcome.diagnostics,
    };
    context.io.out(`${JSON.stringify(envelope, null, 2)}\n`);
    return;
  }
  if (outcome.human !== '') context.io.out(outcome.human);
  for (const entry of outcome.diagnostics) {
    context.io.err(`${diagnosticLine(entry)}\n`);
  }
}

export function diagnosticLine(entry: Diagnostic): string {
  const location =
    entry.fieldPath === null ? entry.file : `${entry.file} ${entry.fieldPath}`;
  return `${entry.severity} ${location}: ${entry.message} [${entry.code}]`;
}
