import type { WriteHooks } from './edit.js';
import { runMembershipChange, type ChatProjectInput } from './membership.js';
import type { ChatAttachment, OperationResult } from './result.js';

export type DetachChatInput = ChatProjectInput;

export async function detachChat(
  root: string,
  input: DetachChatInput,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatAttachment>> {
  return runMembershipChange(root, input, 'detach', hooks);
}
