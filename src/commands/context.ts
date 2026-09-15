import {
  buildContext,
  type ContextBundle,
  type ContextFile,
  type ContextScope,
  type ContextScopeView,
  type ContextTrail,
} from '../search/context.js';
import type { ScoreComponents } from '../search/routing.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ContextCommandOptions {
  project?: string;
  chat?: string;
}

export async function contextCommand(
  query: string,
  options: ContextCommandOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'context', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await buildContext(resolution.root, query, scopeOf(options));
  const outcome: CommandOutcome =
    result.ok && result.bundle !== null
      ? {
          success: true,
          data: result.bundle,
          diagnostics: result.diagnostics,
          human: renderContext(result.bundle),
        }
      : {
          success: false,
          data: null,
          diagnostics: result.diagnostics,
          human: '',
        };
  emitResult(context, 'context', outcome);
  return outcome.success ? 0 : 1;
}

function scopeOf(options: ContextCommandOptions): ContextScope {
  if (typeof options.chat === 'string') {
    return { kind: 'chat', chatId: options.chat };
  }
  if (typeof options.project === 'string') {
    return { kind: 'project', projectId: options.project };
  }
  return { kind: 'global' };
}

function renderContext(bundle: ContextBundle): string {
  const lines: string[] = [
    `context: ${bundle.query} (scope: ${describeScope(bundle.scope)})`,
  ];
  if (bundle.selectedBranches.length === 0) {
    lines.push('branches: none matched');
  } else {
    lines.push('branches:');
    for (const branch of bundle.selectedBranches) {
      lines.push(
        `  ${branch.id}  score ${branch.score.total.toFixed(2)} (${describeComponents(branch.score)})  ${branch.title}`,
      );
    }
  }
  if (bundle.files.length > 0) {
    lines.push('files:');
    for (const file of bundle.files) lines.push(`  ${describeFile(file)}`);
  }
  return `${lines.join('\n')}\n`;
}

function describeScope(scope: ContextScopeView): string {
  switch (scope.kind) {
    case 'project':
      return `project ${scope.project}`;
    case 'chat':
      return `chat ${scope.chat}`;
    default:
      return 'global';
  }
}

function describeComponents(score: ScoreComponents): string {
  const parts: string[] = [];
  if (score.exactId > 0) parts.push(`exact-id ${score.exactId}`);
  if (score.exactTitle > 0) parts.push(`exact-title ${score.exactTitle}`);
  if (score.keywords > 0) {
    parts.push(
      `keywords ${score.keywords} [${score.keywordMatches.join(', ')}]`,
    );
  }
  if (score.fts > 0) parts.push(`fts ${score.fts.toFixed(2)}`);
  if (score.topic > 0) parts.push(`topic ${score.topic}`);
  return parts.length === 0 ? 'no signal' : parts.join(' + ');
}

function describeFile(file: ContextFile): string {
  const display =
    file.repositoryId === null
      ? file.path
      : `${file.repositoryId}:${file.path}`;
  const ranges =
    file.lineRanges.length === 0
      ? '-'
      : file.lineRanges
          .map((range) =>
            range.start === range.end
              ? `${range.start}`
              : `${range.start}-${range.end}`,
          )
          .join(',');
  return `${display}  lines ${ranges}  score ${file.score.total.toFixed(2)}  ${describeTrail(file.trail)}`;
}

function describeTrail(trail: ContextTrail): string {
  switch (trail.route) {
    case 'summary':
      return `via branch summary ${trail.branch}`;
    case 'source':
      return `via source ${trail.via ?? ''} of ${trail.branch}`;
    case 'link':
      return `via link ${trail.via ?? ''} of ${trail.branch}`;
    case 'project':
      return `via manifest of ${trail.via ?? ''} (branch ${trail.branch})`;
    case 'repository':
      return `via rg match in ${trail.via ?? ''} (branch ${trail.branch})`;
    default:
      return `via FTS match under ${trail.branch}`;
  }
}
