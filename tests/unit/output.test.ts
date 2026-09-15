import { describe, expect, it } from 'vitest';

import { diagnostic } from '../../src/domain/diagnostics.js';
import {
  diagnosticLine,
  emitResult,
  type CommandContext,
  type CommandIo,
  type CommandOutcome,
} from '../../src/commands/output.js';

function captureContext(json: boolean): {
  context: CommandContext;
  output: () => { out: string; err: string };
} {
  let out = '';
  let err = '';
  const io: CommandIo = {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  };
  return {
    context: { workspace: undefined, json, io },
    output: () => ({ out, err }),
  };
}

const outcome: CommandOutcome = {
  success: true,
  data: { example: 1 },
  diagnostics: [],
  human: 'example output\n',
};

describe('command envelope', () => {
  it('prints one JSON document with the envelope shape', () => {
    const { context, output } = captureContext(true);

    emitResult(context, 'validate', outcome);

    const parsed = JSON.parse(output().out) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'command',
      'success',
      'data',
      'diagnostics',
    ]);
    expect(parsed.command).toBe('validate');
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ example: 1 });
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(output().err).toBe('');
  });

  it('serializes diagnostics with all fields and keeps stdout JSON-only', () => {
    const { context, output } = captureContext(true);
    const entry = diagnostic(
      'projects/one/project.yml',
      'schema.invalid_string',
      'error',
      'Must be a workspace-wide stable ID.',
      { fieldPath: 'id' },
    );

    emitResult(context, 'validate', { ...outcome, diagnostics: [entry] });

    const parsed = JSON.parse(output().out) as {
      diagnostics: Record<string, unknown>[];
    };
    expect(parsed.diagnostics[0]).toEqual({
      code: 'schema.invalid_string',
      severity: 'error',
      file: 'projects/one/project.yml',
      fieldPath: 'id',
      message: 'Must be a workspace-wide stable ID.',
      line: null,
      column: null,
    });
    expect(output().err).toBe('');
  });

  it('prints failures with success false and data null', () => {
    const { context, output } = captureContext(true);

    emitResult(context, 'project show', {
      success: false,
      data: null,
      diagnostics: [
        diagnostic('workspace', 'project.missing', 'error', 'not found'),
      ],
      human: '',
    });

    const parsed = JSON.parse(output().out) as {
      success: boolean;
      data: unknown;
    };
    expect(parsed.success).toBe(false);
    expect(parsed.data).toBeNull();
  });

  it('writes human output to stdout and diagnostic lines to stderr', () => {
    const { context, output } = captureContext(false);
    const entry = diagnostic(
      'projects/one/project.yml',
      'schema.invalid_string',
      'error',
      'Must be a workspace-wide stable ID.',
      { fieldPath: 'id' },
    );

    emitResult(context, 'validate', { ...outcome, diagnostics: [entry] });

    expect(output().out).toBe('example output\n');
    expect(output().err).toBe(
      'error projects/one/project.yml id: Must be a workspace-wide stable ID. [schema.invalid_string]\n',
    );
  });

  it('omits fieldPath in diagnostic lines when absent', () => {
    expect(
      diagnosticLine(
        diagnostic(
          'chats/a.md',
          'frontmatter.unclosed',
          'error',
          "Markdown frontmatter has no closing '---'.",
          { line: 1, column: 1 },
        ),
      ),
    ).toBe(
      "error chats/a.md: Markdown frontmatter has no closing '---'. [frontmatter.unclosed]",
    );
  });
});
