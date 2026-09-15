import { diagnostic } from '../domain/diagnostics.js';
import {
  startWorkspaceWatcher,
  type WatchBatchResult,
  type WatcherHandle,
} from '../watch/watcher.js';
import {
  diagnosticLine,
  emitResult,
  failureOutcome,
  type CommandContext,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface WatchCommandOptions {
  debounceMs?: number;
}

export async function watchCommand(
  context: CommandContext,
  options: WatchCommandOptions = {},
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'watch', failureOutcome(resolution.diagnostic));
    return 1;
  }
  const root = resolution.root;

  let handle: WatcherHandle;
  try {
    handle = await startWorkspaceWatcher(root, {
      ...options,
      onBatch: (batch) => {
        printBatch(context, batch);
      },
    });
  } catch (error) {
    emitResult(
      context,
      'watch',
      failureOutcome(
        diagnostic(
          root,
          'watch.start_failed',
          'error',
          `Could not start the workspace watcher: ${messageOf(error)}`,
        ),
      ),
    );
    return 1;
  }

  const { counts } = handle.scan;
  for (const entry of handle.scan.diagnostics) {
    context.io.err(`${diagnosticLine(entry)}\n`);
  }
  context.io.out(
    `watching ${root} (${String(counts.files)} files, ${String(counts.objects)} objects indexed)\n`,
  );

  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => {
      void handle
        .stop()
        .then(resolve)
        .catch(() => resolve());
    });
  });
  context.io.out('stopped watching\n');
  return 0;
}

function printBatch(context: CommandContext, batch: WatchBatchResult): void {
  if (batch.applied) {
    const { added, changed, deleted } = batch.paths;
    const total = added.length + changed.length + deleted.length;
    context.io.out(
      `applied ${String(total)} file(s): ${String(added.length)} added, ${String(changed.length)} changed, ${String(deleted.length)} deleted\n`,
    );
  }
  for (const entry of batch.diagnostics) {
    context.io.err(`${diagnosticLine(entry)}\n`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
