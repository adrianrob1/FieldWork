import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { backendsSchema } from '../domain/schemas.js';

export interface OpenAiBackendConfig {
  type: 'openai';
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string | undefined;
  timeoutMs: number;
}

export interface OpencodeBackendConfig {
  type: 'opencode';
  name: string;
  model: string | undefined;
  command: string;
  args: string[];
}

export interface AgentBackendConfig {
  type: 'agent';
  name: string;
  command: string;
  args: string[];
  model: string | undefined;
  timeoutMs: number;
}

export type ResolvedBackendConfig =
  OpenAiBackendConfig | OpencodeBackendConfig | AgentBackendConfig;

export interface BackendsResolution {
  file: string;
  entries: ResolvedBackendConfig[];
  defaultName: string | null;
  diagnostics: Diagnostic[];
}

export interface BackendLookup {
  backend: ResolvedBackendConfig | null;
  diagnostics: Diagnostic[];
}

export function resolveBackends(
  file: string,
  metadata: Record<string, unknown> | null,
): BackendsResolution {
  const raw = metadata?.backends;
  if (raw === undefined || raw === null) {
    return { file, entries: [], defaultName: null, diagnostics: [] };
  }
  const result = backendsSchema.safeParse(raw);
  if (!result.success) {
    return {
      file,
      entries: [],
      defaultName: null,
      diagnostics: result.error.issues.map((issue) =>
        diagnostic(file, 'backend.schema', 'error', issue.message, {
          fieldPath:
            issue.path.length > 0
              ? `backends.${issue.path.map(String).join('.')}`
              : 'backends',
        }),
      ),
    };
  }

  const entries: ResolvedBackendConfig[] = [];
  for (const [name, config] of Object.entries(result.data.entries ?? {})) {
    if (config.type === 'openai') {
      entries.push({
        type: 'openai',
        name,
        baseUrl: config.base_url,
        model: config.model,
        apiKeyEnv: config.api_key_env,
        timeoutMs: config.timeout_ms,
      });
    } else if (config.type === 'opencode') {
      entries.push({
        type: 'opencode',
        name,
        model: config.model,
        command: config.command,
        args: [...config.args],
      });
    } else {
      entries.push({
        type: 'agent',
        name,
        command: config.command,
        args: [...config.args],
        model: config.model,
        timeoutMs: config.timeout_ms,
      });
    }
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : 1));

  const diagnostics: Diagnostic[] = [];
  const defaultName = result.data.default ?? null;
  if (
    defaultName !== null &&
    !entries.some((entry) => entry.name === defaultName)
  ) {
    diagnostics.push(
      diagnostic(
        file,
        'backend.unconfigured',
        'error',
        `Default backend '${defaultName}' is not defined in backends.entries.`,
        { fieldPath: 'backends.default' },
      ),
    );
  }
  return { file, entries, defaultName, diagnostics };
}

export function findBackend(
  resolution: BackendsResolution,
  name: string | undefined,
): BackendLookup {
  if (name !== undefined) {
    const backend = resolution.entries.find((entry) => entry.name === name);
    if (backend !== undefined) {
      return { backend, diagnostics: [] };
    }
    return {
      backend: null,
      diagnostics: [
        diagnostic(
          resolution.file,
          'backend.unconfigured',
          'error',
          `Backend '${name}' is not configured in this workspace.`,
          { fieldPath: 'backends.entries' },
        ),
      ],
    };
  }
  if (resolution.defaultName === null) {
    return {
      backend: null,
      diagnostics: [
        diagnostic(
          resolution.file,
          'backend.unconfigured',
          'error',
          'No default backend is configured in this workspace.',
          { fieldPath: 'backends' },
        ),
      ],
    };
  }
  const backend = resolution.entries.find(
    (entry) => entry.name === resolution.defaultName,
  );
  if (backend !== undefined) {
    return { backend, diagnostics: [] };
  }
  return { backend: null, diagnostics: resolution.diagnostics };
}
