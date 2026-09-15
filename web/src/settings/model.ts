import { parseDiagnostics } from '../shared/responses.js';
import type { DiagnosticView } from '../shared/types.js';

export type BackendType = 'openai' | 'opencode' | 'agent';

export type PresetKind =
  'openai' | 'opencode' | 'agent-opencode' | 'agent-codex' | 'agent-manual';

export const PRESET_KINDS: readonly PresetKind[] = [
  'openai',
  'opencode',
  'agent-opencode',
  'agent-codex',
  'agent-manual',
];

export const PRESET_LABELS: Record<PresetKind, string> = {
  openai: 'OpenAI-compatible endpoint',
  opencode: 'OpenCode agent',
  'agent-opencode': 'Agent: OpenCode (ACP)',
  'agent-codex': 'Agent: Codex (ACP)',
  'agent-manual': 'Agent (manual command)',
};

export interface SettingsBackend {
  name: string;
  type: string;
  model: string | null;
  isDefault: boolean;
  status: string;
  credentialReady: boolean;
  apiKeyEnv: string | null;
  baseUrl: string | null;
  command: string | null;
  args: string[] | null;
  timeoutMs: number | null;
}

export interface SettingsSnapshot {
  backends: SettingsBackend[];
  default: string | null;
  workspaceHash: string | null;
  diagnostics: DiagnosticView[];
}

export interface BackendFormValues {
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  command: string;
  args: string;
  timeoutMs: string;
}

export const EMPTY_FORM_VALUES: BackendFormValues = {
  model: '',
  baseUrl: '',
  apiKeyEnv: '',
  command: '',
  args: '',
  timeoutMs: '',
};

export interface TestResult {
  ok: boolean;
  status: string;
}

export interface AgentModelOption {
  id: string;
  name: string | null;
  description: string | null;
}

export function toAgentModels(data: unknown): AgentModelOption[] {
  if (typeof data !== 'object' || data === null) return [];
  const models = (data as Record<string, unknown>).models;
  if (!Array.isArray(models)) return [];
  const options: AgentModelOption[] = [];
  for (const entry of models) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || record.id === '') continue;
    options.push({
      id: record.id,
      name:
        typeof record.name === 'string' && record.name !== ''
          ? record.name
          : null,
      description:
        typeof record.description === 'string' && record.description !== ''
          ? record.description
          : null,
    });
  }
  return options;
}

export type SettingsFailureKind =
  'list' | 'save' | 'remove' | 'default' | 'test' | 'credential';

export interface SettingsFailure {
  kind: SettingsFailureKind;
  status: number;
  conflict: boolean;
  message: string;
  diagnostics: DiagnosticView[];
  currentHash: string | null;
}

export interface AddPayload {
  name: string;
  type: BackendType;
  config: Record<string, unknown>;
  expectedHash: string;
}

export interface UpdatePayload {
  name: string;
  config: Record<string, unknown>;
  expectedHash: string;
}

export type PayloadResult<T> =
  { ok: true; payload: T } | { ok: false; message: string };

const backendNameMaxLength = 100;

const backendNameMessage =
  'Backend names must not be empty, must be at most 100 characters, and must not contain control characters.';

function invalidBackendName(name: string): boolean {
  if (name.length === 0 || name.length > backendNameMaxLength) return true;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const failureMessages: Record<SettingsFailureKind, string> = {
  list: 'The backend settings could not be loaded.',
  save: 'The backend settings could not be saved.',
  remove: 'The backend could not be removed.',
  default: 'The default backend could not be changed.',
  test: 'The backend could not be reached for testing.',
  credential: 'The credential could not be stored.',
};

const staleSettingsMessage =
  'The settings need to be reloaded before continuing.';

export function toSettingsBackends(data: unknown): SettingsSnapshot {
  if (typeof data !== 'object' || data === null) {
    return {
      backends: [],
      default: null,
      workspaceHash: null,
      diagnostics: [],
    };
  }
  const record = data as Record<string, unknown>;
  return {
    backends: parseBackends(record.backends),
    default: typeof record.default === 'string' ? record.default : null,
    workspaceHash:
      typeof record.workspaceHash === 'string' ? record.workspaceHash : null,
    diagnostics: parseDiagnostics(data),
  };
}

export function presetDefaults(kind: PresetKind): BackendFormValues {
  switch (kind) {
    case 'opencode':
      return { ...EMPTY_FORM_VALUES, command: 'opencode' };
    case 'agent-opencode':
      return { ...EMPTY_FORM_VALUES, command: 'opencode', args: 'acp' };
    case 'agent-codex':
      return { ...EMPTY_FORM_VALUES, command: 'codex-acp' };
    default:
      return { ...EMPTY_FORM_VALUES };
  }
}

export function presetTypeOf(kind: PresetKind): BackendType {
  if (kind === 'openai') return 'openai';
  if (kind === 'opencode') return 'opencode';
  return 'agent';
}

export function presetKindOfBackendType(type: BackendType): PresetKind {
  if (type === 'openai') return 'openai';
  if (type === 'opencode') return 'opencode';
  return 'agent-manual';
}

export function backendTypeOf(type: string): BackendType | null {
  return type === 'openai' || type === 'opencode' || type === 'agent'
    ? type
    : null;
}

export function formFieldKeysOf(kind: PresetKind): string[] {
  switch (kind) {
    case 'openai':
      return ['model', 'base_url', 'api_key_env', 'timeout_ms'];
    case 'opencode':
      return ['command', 'model'];
    default:
      return ['command', 'args', 'model', 'timeout_ms'];
  }
}

export function formValuesOfBackend(
  backend: SettingsBackend,
): BackendFormValues {
  return {
    model: backend.model ?? '',
    baseUrl: backend.baseUrl ?? '',
    apiKeyEnv: backend.apiKeyEnv ?? '',
    command: backend.command ?? '',
    args: (backend.args ?? []).join(', '),
    timeoutMs: backend.timeoutMs === null ? '' : String(backend.timeoutMs),
  };
}

export function parseArgsInput(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

// The harness command a settings model probe runs: opencode backends reach
// their model list through `opencode acp`, agent backends through their
// configured command. OpenAI-compatible backends have no harness to probe, so
// they answer null and keep the free-text model field.
export function modelProbeOf(
  kind: PresetKind,
  command: string,
  argsText: string,
): { command: string; args: string[] } | null {
  const trimmed = command.trim();
  if (kind === 'opencode') {
    return {
      command: trimmed === '' ? 'opencode' : trimmed,
      args: [...parseArgsInput(argsText), 'acp'],
    };
  }
  if (presetTypeOf(kind) === 'agent') {
    if (trimmed === '') return null;
    return { command: trimmed, args: parseArgsInput(argsText) };
  }
  return null;
}

export function parseTimeoutMs(
  text: string,
): { ok: true; value: number | null } | { ok: false; message: string } {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: true, value: null };
  if (!/^[0-9]+$/.test(trimmed) || Number(trimmed) <= 0) {
    return {
      ok: false,
      message: 'The timeout must be a positive whole number of milliseconds.',
    };
  }
  return { ok: true, value: Number(trimmed) };
}

export function checkBaseUrl(
  url: string,
): { ok: true; value: string } | { ok: false; message: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, message: 'The base URL must use http or https.' };
    }
    return { ok: true, value: url };
  } catch {
    return {
      ok: false,
      message: 'The base URL must be a valid http or https URL.',
    };
  }
}

export function buildAddPayload(
  input: { name: string; kind: PresetKind; values: BackendFormValues },
  expectedHash: string | null,
): PayloadResult<AddPayload> {
  const name = input.name.trim();
  if (name === '')
    return { ok: false, message: 'The backend name is required.' };
  if (invalidBackendName(name)) {
    return { ok: false, message: backendNameMessage };
  }
  if (expectedHash === null)
    return { ok: false, message: staleSettingsMessage };
  const config = addConfigOf(input.kind, input.values);
  if (!config.ok) return config;
  return {
    ok: true,
    payload: {
      name,
      type: presetTypeOf(input.kind),
      config: config.value,
      expectedHash,
    },
  };
}

export function buildUpdatePayload(
  input: { name: string; type: BackendType; values: BackendFormValues },
  expectedHash: string | null,
): PayloadResult<UpdatePayload> {
  if (expectedHash === null)
    return { ok: false, message: staleSettingsMessage };
  const config = updateConfigOf(input.type, input.values);
  if (!config.ok) return config;
  return {
    ok: true,
    payload: { name: input.name, config: config.value, expectedHash },
  };
}

export function buildBackendNamePayload(
  name: string,
  expectedHash: string | null,
): PayloadResult<{ name: string; expectedHash: string }> {
  const trimmed = name.trim();
  if (trimmed === '')
    return { ok: false, message: 'The backend name is required.' };
  if (invalidBackendName(trimmed)) {
    return { ok: false, message: backendNameMessage };
  }
  if (expectedHash === null)
    return { ok: false, message: staleSettingsMessage };
  return { ok: true, payload: { name: trimmed, expectedHash } };
}

export function buildCredentialPayload(
  name: string,
  apiKey: string,
): PayloadResult<{ name: string; apiKey: string }> {
  const key = apiKey.trim();
  if (key === '') {
    return { ok: false, message: 'The credential field must not be empty.' };
  }
  if (name.trim() === '') {
    return { ok: false, message: 'The backend name is required.' };
  }
  return { ok: true, payload: { name: name.trim(), apiKey: key } };
}

export function toTestResult(data: unknown): TestResult {
  if (typeof data !== 'object' || data === null) {
    return { ok: false, status: '' };
  }
  const record = data as Record<string, unknown>;
  return {
    ok: record.ok === true,
    status: typeof record.status === 'string' ? record.status : '',
  };
}

export function classifySettingsFailure(
  kind: SettingsFailureKind,
  status: number,
  diagnostics: DiagnosticView[],
  currentHash: string | null,
): SettingsFailure {
  if (status === 0) {
    return {
      kind,
      status,
      conflict: false,
      message: 'The request could not reach the server.',
      diagnostics,
      currentHash,
    };
  }
  if (status === 409) {
    return {
      kind,
      status,
      conflict: true,
      message:
        'The settings changed since they were loaded. Reload before continuing.',
      diagnostics,
      currentHash,
    };
  }
  return {
    kind,
    status,
    conflict: false,
    message: failureMessages[kind],
    diagnostics,
    currentHash,
  };
}

export interface SettingsFormErrors {
  fields: Record<string, string[]>;
  unassigned: DiagnosticView[];
}

export function settingsFormErrorsOf(
  diagnostics: DiagnosticView[],
  backendName: string | null,
  renderedKeys: readonly string[],
): SettingsFormErrors {
  const fields: Record<string, string[]> = {};
  const unassigned: DiagnosticView[] = [];
  for (const entry of diagnostics) {
    const fieldPath = entry.fieldPath;
    const field =
      fieldPath === null ? null : mappedFieldOf(fieldPath, backendName);
    if (field === null || field === '' || !renderedKeys.includes(field)) {
      unassigned.push(entry);
      continue;
    }
    (fields[field] ??= []).push(entry.message);
  }
  return { fields, unassigned };
}

function mappedFieldOf(
  fieldPath: string,
  backendName: string | null,
): string | null {
  if (fieldPath === 'name') return 'name';
  const prefix = 'backends.entries.';
  if (!fieldPath.startsWith(prefix)) return null;
  const rest = fieldPath.slice(prefix.length);
  const separator = rest.indexOf('.');
  if (separator <= 0) return null;
  const entryName = rest.slice(0, separator);
  if (backendName !== null && entryName !== backendName) return null;
  return rest.slice(separator + 1);
}

function addConfigOf(
  kind: PresetKind,
  values: BackendFormValues,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  const type = presetTypeOf(kind);
  if (type === 'openai') {
    const model = values.model.trim();
    if (model === '') {
      return {
        ok: false,
        message:
          'The model field is required for an OpenAI-compatible backend.',
      };
    }
    const config: Record<string, unknown> = { model };
    const url = values.baseUrl.trim();
    if (url !== '') {
      const checked = checkBaseUrl(url);
      if (!checked.ok) return checked;
      config.base_url = url;
    }
    const keyEnv = values.apiKeyEnv.trim();
    if (keyEnv !== '') config.api_key_env = keyEnv;
    const timeout = parseTimeoutMs(values.timeoutMs);
    if (!timeout.ok) return timeout;
    if (timeout.value !== null) config.timeout_ms = timeout.value;
    return { ok: true, value: config };
  }
  const command = values.command.trim();
  if (command === '') {
    return { ok: false, message: 'The command field is required.' };
  }
  const config: Record<string, unknown> = { command };
  if (type === 'opencode') {
    const model = values.model.trim();
    if (model !== '') config.model = model;
    return { ok: true, value: config };
  }
  if (kind === 'agent-opencode') {
    config.args = ['acp'];
  } else if (kind === 'agent-manual') {
    const args = parseArgsInput(values.args);
    if (args.length > 0) config.args = args;
  }
  const model = values.model.trim();
  if (model !== '') config.model = model;
  const timeout = parseTimeoutMs(values.timeoutMs);
  if (!timeout.ok) return timeout;
  if (timeout.value !== null) config.timeout_ms = timeout.value;
  return { ok: true, value: config };
}

function updateConfigOf(
  type: BackendType,
  values: BackendFormValues,
):
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string } {
  const config: Record<string, unknown> = {};
  if (type === 'openai') {
    const model = values.model.trim();
    if (model === '') {
      return {
        ok: false,
        message:
          'The model field is required for an OpenAI-compatible backend.',
      };
    }
    config.model = model;
    const url = values.baseUrl.trim();
    if (url === '') {
      config.base_url = null;
    } else {
      const checked = checkBaseUrl(url);
      if (!checked.ok) return checked;
      config.base_url = url;
    }
    const keyEnv = values.apiKeyEnv.trim();
    config.api_key_env = keyEnv === '' ? null : keyEnv;
    const timeout = parseTimeoutMs(values.timeoutMs);
    if (!timeout.ok) return timeout;
    config.timeout_ms = timeout.value;
    return { ok: true, value: config };
  }
  const command = values.command.trim();
  if (command === '') {
    return { ok: false, message: 'The command field is required.' };
  }
  config.command = command;
  const model = values.model.trim();
  config.model = model === '' ? null : model;
  if (type === 'opencode') return { ok: true, value: config };
  const args = parseArgsInput(values.args);
  config.args = args.length === 0 ? null : args;
  const timeout = parseTimeoutMs(values.timeoutMs);
  if (!timeout.ok) return timeout;
  config.timeout_ms = timeout.value;
  return { ok: true, value: config };
}

function parseBackends(value: unknown): SettingsBackend[] {
  if (!Array.isArray(value)) return [];
  const backends: SettingsBackend[] = [];
  for (const entry of value) {
    const parsed = parseBackend(entry);
    if (parsed !== null) backends.push(parsed);
  }
  return backends;
}

function parseBackend(value: unknown): SettingsBackend | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name === '') return null;
  return {
    name: record.name,
    type: typeof record.type === 'string' ? record.type : '',
    model: stringOrNull(record.model),
    isDefault: record.isDefault === true,
    status: typeof record.status === 'string' ? record.status : '',
    credentialReady: record.credentialReady === true,
    apiKeyEnv: stringOrNull(record.apiKeyEnv),
    baseUrl: stringOrNull(record.baseUrl),
    command: stringOrNull(record.command),
    args: stringArrayOrNull(record.args),
    timeoutMs: numberOrNull(record.timeoutMs),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}
