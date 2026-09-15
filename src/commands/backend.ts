import path from 'node:path';

import {
  resolveBackends,
  type ResolvedBackendConfig,
} from '../backends/config.js';
import { backendStatus } from '../backends/status.js';
import { parseWorkspace } from '../files/workspace.js';
import { hasError } from '../operations/lookup.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface BackendView {
  name: string;
  type: 'openai' | 'opencode' | 'agent';
  model: string | null;
  default: boolean;
  status: string;
}

export async function backendListCommand(
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'backend list', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const parsed = await parseWorkspace(resolution.root);
  const settings =
    parsed.files.find((file) => file.kind === 'workspace') ?? null;
  const backends = resolveBackends(
    settings?.file ?? path.join(resolution.root, 'workspace.yml'),
    settings?.metadata ?? null,
  );
  const views: BackendView[] = [];
  for (const backend of backends.entries) {
    views.push(await backendView(backend, backends.defaultName));
  }

  const success = !hasError(backends.diagnostics);
  const outcome: CommandOutcome = {
    success,
    data: { backends: views },
    diagnostics: backends.diagnostics,
    human: renderBackendViews(views),
  };
  emitResult(context, 'backend list', outcome);
  return success ? 0 : 1;
}

async function backendView(
  backend: ResolvedBackendConfig,
  defaultName: string | null,
): Promise<BackendView> {
  const status = await backendStatus(backend);
  if (backend.type === 'openai') {
    return {
      name: backend.name,
      type: 'openai',
      model: backend.model,
      default: backend.name === defaultName,
      status,
    };
  }
  return {
    name: backend.name,
    type: backend.type,
    model: backend.model ?? null,
    default: backend.name === defaultName,
    status,
  };
}

function renderBackendViews(views: BackendView[]): string {
  if (views.length === 0) {
    return 'No backends are configured in this workspace.\n';
  }
  const lines = views.map((view) => {
    const model =
      view.model === null ? 'model: (none)' : `model: ${view.model}`;
    const flag = view.default ? 'default' : '-';
    return `${view.name}  ${view.type}  ${model}  ${flag}  ${view.status}\n`;
  });
  return lines.join('');
}
