export interface DiagnosticView {
  code: string;
  severity: string;
  file: string;
  fieldPath: string | null;
  message: string;
  line: number | null;
  column: number | null;
}

export interface ChatMessageView {
  role: string;
  text: string;
  metadata: Record<string, unknown> | null;
}

export interface ChatView {
  id: string;
  title: string;
  projects: string[];
  topics: string[];
  path: string;
  contentHash: string | null;
  messages: ChatMessageView[];
  hasEarlier: boolean;
  earlierCursor?: string | undefined;
}

export interface BackendView {
  name: string;
  type: string;
  model: string | null;
  isDefault: boolean;
  status: string;
  apiKeyEnv: string | null;
  baseUrl: string | null;
  command: string | null;
  args: string[] | null;
  timeoutMs: number | null;
}

export interface ProjectSummary {
  id: string;
  title: string;
}
