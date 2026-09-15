import { z } from 'zod';

import { dateSchema, stableIdSchema } from './schemas.js';

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export const messageRoles: readonly MessageRole[] = [
  'user',
  'assistant',
  'system',
  'tool',
];

export const toolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
    result: z.string().optional(),
  })
  .loose();

export const messageAttachmentSchema = z
  .object({
    id: stableIdSchema.optional(),
    path: z.string().optional(),
    label: z.string().optional(),
    mime: z.string().optional(),
    kind: z.string().optional(),
    title: z.string().optional(),
    size: z.number().optional(),
  })
  .loose()
  .superRefine((value, context) => {
    if (value.id === undefined && value.path === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'An attachment requires an id or a path.',
      });
    }
  });

export const attachmentReferenceSchema = z
  .object({
    id: stableIdSchema.optional(),
    path: z.string().optional(),
  })
  .loose()
  .superRefine((value, context) => {
    const hasId = value.id !== undefined;
    const hasPath = value.path !== undefined;
    if (hasId && hasPath) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'An attachment reference accepts an id or a path, not both.',
      });
    } else if (!hasId && !hasPath) {
      context.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'An attachment reference requires an id or a path.',
      });
    }
  });

export const messageMetadataSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    backend: z.string().optional(),
    session: z.string().optional(),
    at: dateSchema.optional(),
    thought: z.string().optional(),
    tool_calls: z.array(toolCallSchema).optional(),
    attachments: z.array(messageAttachmentSchema).optional(),
    usage: z.record(z.string(), z.unknown()).optional(),
    cost: z.record(z.string(), z.unknown()).optional(),
    context: z.array(stableIdSchema).optional(),
    text_escaped: z.boolean().optional(),
  })
  .loose();

export type ToolCall = z.infer<typeof toolCallSchema>;
export type MessageAttachment = z.infer<typeof messageAttachmentSchema>;
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;
export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
