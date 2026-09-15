import { attachmentsBlock, type ResolvedAttachment } from './attachments.js';

export interface AgentInstructionsOptions {
  serverUrl?: string | undefined;
}

export interface BackendMessageOptions {
  attachments?: readonly ResolvedAttachment[] | undefined;
  serverUrl?: string | undefined;
}

export function buildAgentInstructions(
  options: AgentInstructionsOptions = {},
): string {
  const apiBaseUrl = options.serverUrl ?? 'printed by `fieldwork serve`';
  return [
    '<fieldwork_workspace>',
    'You are running inside FieldWork, a local-first research workspace. The workspace root is your current working directory. Everything is ordinary Markdown files with YAML frontmatter: projects/, chats/, tasks/, topics/, inbox/, plus project resources and repositories.',
    '',
    'Tools you can use:',
    `- HTTP JSON API (base URL: ${apiBaseUrl}): every write is a plain POST with Content-Type: application/json; HTTP verbs like PATCH or PUT do not exist. Do not send an Origin header. Key routes: POST /api/tasks {text, projects?[], deadline?} creates a task; POST /api/tasks/:id/update {expectedHash, title?, body?, projects?, deadline?}; POST /api/tasks/:id/done, /reopen, /snooze {expectedHash, duration?|deadline?}; GET /api/tasks, GET /api/tasks/:id; POST /api/projects {title, directory, id?, repository?}; POST /api/projects/:id/repositories {path, expectedHash}; GET /api/projects, GET /api/projects/:id; POST /api/chats/:id/attach|detach {projectId, expectedHash}; POST /api/chats/:id/messages {message, expectedHash}; GET /api/file?path=, POST /api/edit/body|edit/frontmatter {path, ..., expectedHash}; GET /api/search?q=, GET /api/context?q=. Mutations of existing objects require expectedHash: GET the object first, send its contentHash back; on 409 refetch and retry.`,
    '- CLI, only if `fieldwork` is on PATH (check first, many installs use the HTTP API instead): `fieldwork <command> --json` for chat show/send, chat attach/detach, project list/show/register, search, context, validate, rebuild. cwd is already the workspace root.',
    '',
    'Rules: act only when the user asks; use the exact route shapes above and do not guess alternatives; after changing anything, say briefly what you changed.',
    '</fieldwork_workspace>',
  ].join('\n');
}

export function augmentBackendMessage(
  text: string,
  options: BackendMessageOptions = {},
): string {
  const blocks = [buildAgentInstructions({ serverUrl: options.serverUrl })];
  const attachmentBlock = attachmentsBlock(options.attachments ?? []);
  if (attachmentBlock.length > 0) blocks.push(attachmentBlock);
  blocks.push(text);
  return blocks.join('\n\n');
}
