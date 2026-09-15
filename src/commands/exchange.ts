import { continueChat } from '../operations/exchange.js';
import type { OperationResult } from '../operations/result.js';
import type { ChatExchange } from '../operations/exchange.js';
import { startChat } from '../operations/start.js';
import type { ChatStart } from '../operations/start.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ChatStartOptions {
  id: string;
  title: string;
  topics: string[];
  projects: string[];
  message?: string | undefined;
}

export interface ChatSendOptions {
  message: string;
  backend?: string | undefined;
}

export async function chatStartCommand(
  options: ChatStartOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'chat start', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await startChat(resolution.root, {
    id: options.id,
    title: options.title,
    topics: options.topics,
    projects: options.projects,
    message: options.message,
  });
  const outcome = startOutcome(result);
  emitResult(context, 'chat start', outcome);
  return outcome.success ? 0 : 1;
}

export async function chatSendCommand(
  chatId: string,
  options: ChatSendOptions,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'chat send', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const result = await continueChat(resolution.root, {
    chatId,
    message: options.message,
    backend: options.backend,
  });
  const outcome = sendOutcome(result);
  emitResult(context, 'chat send', outcome);
  return outcome.success ? 0 : 1;
}

function startOutcome(result: OperationResult<ChatStart>): CommandOutcome {
  if (result.success && result.data !== null) {
    const chat = result.data;
    return {
      success: true,
      data: {
        files: result.files,
        chatId: chat.chatId,
        title: chat.title,
        file: chat.file,
      },
      diagnostics: result.diagnostics,
      human: `Started chat '${chat.chatId}' at ${chat.file}.\n`,
    };
  }
  return {
    success: false,
    data: null,
    diagnostics: result.diagnostics,
    human: '',
  };
}

function sendOutcome(result: OperationResult<ChatExchange>): CommandOutcome {
  if (result.success && result.data !== null) {
    const exchange = result.data;
    return {
      success: true,
      data: {
        files: result.files,
        chatId: exchange.chatId,
        file: exchange.file,
        backend: exchange.backend,
        appendedCount: exchange.appendedCount,
        reply: exchange.reply,
      },
      diagnostics: result.diagnostics,
      human: `${exchange.reply}\n`,
    };
  }
  return {
    success: false,
    data: null,
    diagnostics: result.diagnostics,
    human: '',
  };
}
