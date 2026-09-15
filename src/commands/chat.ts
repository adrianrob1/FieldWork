import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { MessageMetadata, MessageRole } from '../domain/transcript.js';
import {
  parseTranscript,
  type HeadingLocation,
  type TranscriptMessage,
} from '../files/transcript.js';
import { parseWorkspace } from '../files/workspace.js';
import { attachChat } from '../operations/attach.js';
import { detachChat } from '../operations/detach.js';
import { promoteChat } from '../operations/promote.js';
import type {
  ChatAttachment,
  ChatPromotion,
  OperationResult,
} from '../operations/result.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ChatPromoteOptions {
  id: string;
  title: string;
  directory?: string | undefined;
}

export interface ChatMessageView {
  role: MessageRole;
  text: string;
  metadata: MessageMetadata | null;
  metadataRaw: unknown;
  headingLocation: HeadingLocation;
}

export interface ChatShowView {
  id: string;
  title: string;
  created: string | null;
  updated: string | null;
  projects: string[];
  topics: string[];
  provider: string | null;
  model: string | null;
  preamble: string;
  messages: ChatMessageView[];
}

export async function chatShowCommand(
  chatId: string,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'chat show', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const parsed = await parseWorkspace(resolution.root);
  const chat = parsed.files.find(
    (file) =>
      file.kind === 'chat' &&
      typeof file.metadata?.id === 'string' &&
      file.metadata.id === chatId,
  );
  const metadata = chat?.metadata ?? null;
  if (chat === undefined || metadata === null) {
    emitResult(
      context,
      'chat show',
      failureOutcome(missingChatDiagnostic(resolution.root, chatId)),
    );
    return 1;
  }

  const transcript = parseTranscript(chat.body ?? '', chat.file);
  const view = buildChatView(
    metadata,
    transcript.preamble,
    transcript.messages,
  );
  const outcome: CommandOutcome = {
    success: true,
    data: view,
    diagnostics: [...parsed.diagnostics, ...transcript.diagnostics],
    human: renderChatView(view),
  };
  emitResult(context, 'chat show', outcome);
  return 0;
}

function missingChatDiagnostic(root: string, chatId: string): Diagnostic {
  return diagnostic(
    root,
    'chat.missing',
    'error',
    `Chat '${chatId}' was not found in this workspace.`,
  );
}

function buildChatView(
  metadata: Record<string, unknown>,
  preamble: string,
  messages: TranscriptMessage[],
): ChatShowView {
  return {
    id: textOf(metadata.id),
    title: textOf(metadata.title),
    created: textOrNull(metadata.created),
    updated: textOrNull(metadata.updated),
    projects: stringListOf(metadata.projects),
    topics: stringListOf(metadata.topics),
    provider: textOrNull(metadata.provider),
    model: textOrNull(metadata.model),
    preamble,
    messages: messages.map((message) => ({
      role: message.role,
      text: message.text,
      metadata: message.metadata,
      metadataRaw: message.metadataRaw,
      headingLocation: message.headingLocation,
    })),
  };
}

function renderChatView(view: ChatShowView): string {
  const lines: string[] = [
    `title: ${view.title}`,
    `projects: ${view.projects.length > 0 ? view.projects.join(', ') : '(none)'}`,
    `updated: ${view.updated ?? '(never)'}`,
  ];
  if (view.messages.length === 0) {
    lines.push('', 'messages: (none)');
  }
  for (const message of view.messages) {
    lines.push('', `## ${message.role}`);
    const provenance = provenanceLine(message.metadata);
    if (provenance !== null) lines.push('', provenance);
    if (message.text !== '') lines.push('', message.text);
  }
  return `${lines.join('\n')}\n`;
}

function provenanceLine(metadata: MessageMetadata | null): string | null {
  if (metadata === null) return null;
  const parts: string[] = [];
  if (metadata.provider !== undefined)
    parts.push(`provider: ${metadata.provider}`);
  if (metadata.model !== undefined) parts.push(`model: ${metadata.model}`);
  if (metadata.backend !== undefined)
    parts.push(`backend: ${metadata.backend}`);
  if (metadata.at !== undefined) parts.push(`at: ${metadata.at}`);
  if (parts.length === 0) return null;
  return parts.join(', ');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

export async function chatAttachCommand(
  chatId: string,
  projectId: string,
  context: CommandContext,
): Promise<number> {
  return runAttachment(context, 'chat attach', chatId, projectId, (root) =>
    attachChat(root, { chatId, projectId }),
  );
}

export async function chatDetachCommand(
  chatId: string,
  projectId: string,
  context: CommandContext,
): Promise<number> {
  return runAttachment(context, 'chat detach', chatId, projectId, (root) =>
    detachChat(root, { chatId, projectId }),
  );
}

export async function chatPromoteCommand(
  chatId: string,
  options: ChatPromoteOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'chat promote', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await promoteChat(resolution.root, {
    chatId,
    id: options.id,
    title: options.title,
    directory: options.directory,
  });
  const outcome = promoteOutcome(result);
  emitResult(context, 'chat promote', outcome);
  return outcome.success ? 0 : 1;
}

async function runAttachment(
  context: CommandContext,
  command: 'chat attach' | 'chat detach',
  chatId: string,
  projectId: string,
  action: (root: string) => Promise<OperationResult<ChatAttachment>>,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, command, failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await action(resolution.root);
  const outcome = attachmentOutcome(command, result);
  emitResult(context, command, outcome);
  return outcome.success ? 0 : 1;
}

function attachmentOutcome(
  command: 'chat attach' | 'chat detach',
  result: OperationResult<ChatAttachment>,
): CommandOutcome {
  if (result.success && result.data !== null) {
    const { chatId, projectId } = result.data;
    const attach = command === 'chat attach';
    const human = result.changed
      ? attach
        ? `Attached chat '${chatId}' to project '${projectId}'.\n`
        : `Detached chat '${chatId}' from project '${projectId}'.\n`
      : attach
        ? `No change: chat '${chatId}' is already attached to project '${projectId}'.\n`
        : `No change: chat '${chatId}' is not attached to project '${projectId}'.\n`;
    return {
      success: true,
      data: {
        files: result.files,
        changed: result.changed,
        chatId,
        projectId,
      },
      diagnostics: result.diagnostics,
      human,
    };
  }
  return {
    success: false,
    data: null,
    diagnostics: result.diagnostics,
    human: '',
  };
}

function promoteOutcome(
  result: OperationResult<ChatPromotion>,
): CommandOutcome {
  if (result.success && result.data !== null) {
    const { chatId, project } = result.data;
    return {
      success: true,
      data: { files: result.files, chatId, project },
      diagnostics: result.diagnostics,
      human: `Promoted chat '${chatId}' to project '${project.id}' at ${project.file}.\n`,
    };
  }
  return {
    success: false,
    data: null,
    diagnostics: result.diagnostics,
    human: '',
  };
}
