import { registerProject } from '../operations/register.js';
import type { OperationResult } from '../operations/result.js';
import type { ProjectRegistration } from '../operations/result.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ProjectRegisterOptions {
  id: string;
  title: string;
  repositories: string[];
}

export async function projectRegisterCommand(
  directory: string,
  options: ProjectRegisterOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(
      context,
      'project register',
      failureOutcome(resolution.diagnostic),
    );
    return 1;
  }

  const result = await registerProject(resolution.root, {
    directory,
    id: options.id,
    title: options.title,
    repositories: options.repositories,
  });
  const outcome = registrationOutcome(result);
  emitResult(context, 'project register', outcome);
  return outcome.success ? 0 : 1;
}

function registrationOutcome(
  result: OperationResult<ProjectRegistration>,
): CommandOutcome {
  if (result.success && result.data !== null) {
    const project = result.data;
    return {
      success: true,
      data: { files: result.files, project },
      diagnostics: result.diagnostics,
      human: `Registered project '${project.id}' at ${project.file}.\n`,
    };
  }
  return {
    success: false,
    data: null,
    diagnostics: result.diagnostics,
    human: '',
  };
}
