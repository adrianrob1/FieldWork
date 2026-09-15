import { diagnostic } from '../domain/diagnostics.js';
import {
  defaultServeHost,
  defaultServePort,
  startServer,
  type ServerHandle,
} from '../server/server.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ServeCommandOptions {
  port?: number;
  host?: string;
}

export async function serveCommand(
  context: CommandContext,
  options: ServeCommandOptions = {},
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'serve', failureOutcome(resolution.diagnostic));
    return 1;
  }

  let handle: ServerHandle;
  try {
    handle = await startServer(resolution.root, {
      host: options.host ?? defaultServeHost,
      port: options.port ?? defaultServePort,
    });
  } catch (error) {
    emitResult(
      context,
      'serve',
      failureOutcome(
        diagnostic(
          resolution.root,
          'serve.start_failed',
          'error',
          `Could not start the local server: ${messageOf(error)}`,
        ),
      ),
    );
    return 1;
  }

  if (context.json) {
    const outcome: CommandOutcome = {
      success: true,
      data: { url: handle.url, port: handle.port, host: handle.host },
      diagnostics: [],
      human: '',
    };
    emitResult(context, 'serve', outcome);
  } else {
    context.io.out(`serving ${resolution.root} at ${handle.url}\n`);
  }

  await waitForShutdownSignal();
  await handle.stop();
  if (!context.json) context.io.out('stopped serving\n');
  return 0;
}

function waitForShutdownSignal(): Promise<void> {
  return new Promise((resolve) => {
    const onSigint = (): void => {
      process.off('SIGTERM', onSigterm);
      resolve();
    };
    const onSigterm = (): void => {
      process.off('SIGINT', onSigint);
      resolve();
    };
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
