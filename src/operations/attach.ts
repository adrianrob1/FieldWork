import type { WriteHooks } from './edit.js';
import { runMembershipChange, type ChatProjectInput } from './membership.js';
import type { ChatAttachment, OperationResult } from './result.js';

export type AttachChatInput = ChatProjectInput;

export async function attachChat(
  root: string,
  input: AttachChatInput,
  hooks?: WriteHooks,
): Promise<OperationResult<ChatAttachment>> {
  return runMembershipChange(root, input, 'attach', hooks);
}
