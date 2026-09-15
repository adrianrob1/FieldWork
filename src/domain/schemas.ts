import { z } from 'zod';

export const stableIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/,
    'Must be a workspace-wide stable ID.',
  );

export const dateSchema = z.string().refine(isDateOrTimestamp, {
  message: 'Must be YYYY-MM-DD or an RFC 3339 timestamp with an offset.',
});
const idListSchema = z.array(stableIdSchema);
const stringListSchema = z.array(z.string());
const extensibleObject = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).loose();

const workspacePathsSchema = extensibleObject({
  projects: z.string().optional(),
  chats: z.string().optional(),
  topics: z.string().optional(),
  tasks: z.string().optional(),
  inbox: z.string().optional(),
  external: z.string().optional(),
});

export const backendNameMaxLength = 100;

export const backendNameMessage =
  'Backend names must not be empty, must be at most 100 characters, and must not contain control characters.';

export const backendNameSchema = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      value.length <= backendNameMaxLength &&
      !hasControlCharacters(value),
    { message: backendNameMessage },
  );

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export const openAiBackendConfigSchema = extensibleObject({
  type: z.literal('openai'),
  base_url: z.url().default('https://api.openai.com/v1'),
  model: z.string(),
  api_key_env: z.string().optional(),
  timeout_ms: z.number().int().positive().default(120000),
});

export const opencodeBackendConfigSchema = extensibleObject({
  type: z.literal('opencode'),
  model: z.string().optional(),
  command: z.string().default('opencode'),
  args: z.array(z.string()).default([]),
});

export const agentBackendConfigSchema = extensibleObject({
  type: z.literal('agent'),
  command: z.string(),
  args: z.array(z.string()).default([]),
  model: z.string().optional(),
  timeout_ms: z.number().int().positive().default(120000),
});

export const backendsSchema = extensibleObject({
  default: backendNameSchema.optional(),
  entries: z
    .record(
      backendNameSchema,
      z.union([
        openAiBackendConfigSchema,
        opencodeBackendConfigSchema,
        agentBackendConfigSchema,
      ]),
    )
    .optional(),
});

export const workspaceSchema = extensibleObject({
  version: z.literal(1),
  title: z.string().optional(),
  paths: workspacePathsSchema.optional(),
  backends: backendsSchema.optional(),
});

export const inlineRepositorySchema = extensibleObject({
  id: stableIdSchema,
  path: z.string(),
  title: z.string().optional(),
  remote: z.url().optional(),
  default_branch: z.string().optional(),
});

export const projectSchema = extensibleObject({
  id: stableIdSchema,
  title: z.string(),
  summary: z.string().optional(),
  repositories: z
    .array(z.union([stableIdSchema, inlineRepositorySchema]))
    .optional(),
  resources: idListSchema.optional(),
  topics: stringListSchema.optional(),
  links: idListSchema.optional(),
});

export const chatSchema = extensibleObject({
  id: stableIdSchema,
  title: z.string(),
  created: dateSchema,
  updated: dateSchema.optional(),
  projects: idListSchema.optional(),
  topics: stringListSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  links: idListSchema.optional(),
});

export const taskSchema = extensibleObject({
  id: stableIdSchema,
  title: z.string(),
  status: z.enum(['active', 'done']),
  created: dateSchema,
  updated: dateSchema,
  deadline: dateSchema.optional(),
  projects: idListSchema.optional(),
  completed: dateSchema.optional(),
}).superRefine((value, context) => {
  if (value.status !== 'done' && value.completed !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['completed'],
      message: "Only a task with status 'done' may set 'completed'.",
    });
  }
});

const sourceSchema = extensibleObject({
  service: z.string(),
  remote_id: z.string(),
  url: z.url().optional(),
  author: z.string().optional(),
  created: dateSchema.optional(),
});

const snapshotSchema = extensibleObject({
  fetched: dateSchema,
  remote_updated: dateSchema.optional(),
  etag: z.string().optional(),
  status: z.enum(['current', 'stale', 'error']).optional(),
});

export const resourceSchema = extensibleObject({
  id: stableIdSchema,
  title: z.string(),
  kind: z.string(),
  projects: idListSchema.optional(),
  topics: stringListSchema.optional(),
  path: z.string().optional(),
  url: z.url().optional(),
  source: sourceSchema.optional(),
  snapshot: snapshotSchema.optional(),
  links: idListSchema.optional(),
});

export const summarySchema = extensibleObject({
  id: stableIdSchema,
  title: z.string(),
  kind: z.enum(['root', 'project', 'area', 'topic']),
  project: stableIdSchema.optional(),
  summary: z.string().optional(),
  keywords: stringListSchema.optional(),
  sources: idListSchema.optional(),
  links: idListSchema.optional(),
  reviewed: dateSchema.optional(),
}).superRefine((value, context) => {
  if ((value.kind === 'project' || value.kind === 'area') && !value.project) {
    context.addIssue({
      code: 'custom',
      path: ['project'],
      message: `A ${value.kind} summary requires a project.`,
    });
  }
  if ((value.kind === 'root' || value.kind === 'topic') && value.project) {
    context.addIssue({
      code: 'custom',
      path: ['project'],
      message: `A ${value.kind} summary must omit project.`,
    });
  }
});

export const linkSchema = extensibleObject({
  id: stableIdSchema,
  from: stableIdSchema,
  to: stableIdSchema,
  relation: z.string(),
  label: z.string().optional(),
  created: dateSchema.optional(),
});

export const schemas = {
  workspace: workspaceSchema,
  project: projectSchema,
  chat: chatSchema,
  task: taskSchema,
  resource: resourceSchema,
  summary: summarySchema,
  link: linkSchema,
} as const;

export type WorkspaceSettings = z.infer<typeof workspaceSchema>;
export type Backends = z.infer<typeof backendsSchema>;
export type OpenAiBackendSettings = z.infer<typeof openAiBackendConfigSchema>;
export type OpencodeBackendSettings = z.infer<
  typeof opencodeBackendConfigSchema
>;
export type AgentBackendSettings = z.infer<typeof agentBackendConfigSchema>;
export type BackendConfig =
  OpenAiBackendSettings | OpencodeBackendSettings | AgentBackendSettings;
export type Project = z.infer<typeof projectSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Resource = z.infer<typeof resourceSchema>;
export type Summary = z.infer<typeof summarySchema>;
export type Link = z.infer<typeof linkSchema>;

function isDateOrTimestamp(value: string): boolean {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}
