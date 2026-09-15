import type { CanonicalFileKind } from '../files/workspace.js';
import {
  parseWorkspace,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

const fileKinds: CanonicalFileKind[] = [
  'workspace',
  'project',
  'chat',
  'resource',
  'summary',
  'link',
  'task',
];

export async function validateCommand(
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'validate', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const parsed = await parseWorkspace(resolution.root);
  const files = countByKind(parsed.files);
  const errors = parsed.diagnostics.filter(
    ({ severity }) => severity === 'error',
  ).length;
  const warnings = parsed.diagnostics.length - errors;
  const success = errors === 0;
  const outcome: CommandOutcome = {
    success,
    data: { files, errors, warnings },
    diagnostics: parsed.diagnostics,
    human: renderValidate(resolution.root, files, errors, warnings),
  };
  emitResult(context, 'validate', outcome);
  return success ? 0 : 1;
}

function countByKind(
  files: ParsedWorkspaceFile[],
): Record<CanonicalFileKind, number> {
  const counts: Record<CanonicalFileKind, number> = {
    workspace: 0,
    project: 0,
    chat: 0,
    resource: 0,
    summary: 0,
    link: 0,
    task: 0,
  };
  for (const file of files) counts[file.kind] += 1;
  return counts;
}

function renderValidate(
  root: string,
  counts: Record<CanonicalFileKind, number>,
  errors: number,
  warnings: number,
): string {
  const total = fileKinds.reduce((sum, kind) => sum + counts[kind], 0);
  const breakdown = fileKinds
    .map((kind) => `${kind} ${counts[kind]}`)
    .join(', ');
  return `workspace: ${root}\nfiles: ${total} (${breakdown})\nerrors: ${errors}\nwarnings: ${warnings}\n`;
}
