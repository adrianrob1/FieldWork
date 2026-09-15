import { rebuildIndex } from '../index/build.js';
import type { IndexCounts } from '../index/result.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export async function rebuildCommand(context: CommandContext): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'rebuild', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await rebuildIndex(resolution.root);
  const failed = result.diagnostics.some(
    (entry) =>
      entry.severity === 'error' &&
      (entry.code === 'index.rebuild_failed' ||
        entry.code.startsWith('index.schema')),
  );
  const outcome: CommandOutcome = {
    success: !failed,
    data: { ...result.counts, rebuilt: result.rebuilt },
    diagnostics: result.diagnostics,
    human: failed ? '' : renderRebuild(result.indexPath, result.counts),
  };
  emitResult(context, 'rebuild', outcome);
  return failed ? 1 : 0;
}

function renderRebuild(indexPath: string, counts: IndexCounts): string {
  return `rebuilt index at ${indexPath} (${String(counts.objects)} objects, ${String(counts.references)} references)\n`;
}
