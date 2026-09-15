import path from 'node:path';

import { isMap, type Document, type ParsedNode, type YAMLMap } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { backendNameMessage, backendNameSchema } from '../domain/schemas.js';
import {
  childProcessAcpTransport,
  listAcpModels,
  type AcpModelOption,
} from '../backends/acp.js';
import type { AgentBackendConfig } from '../backends/config.js';
import {
  findBackend,
  resolveBackends,
  type BackendsResolution,
  type OpenAiBackendConfig,
  type ResolvedBackendConfig,
} from '../backends/config.js';
import {
  backendStatus,
  commandResolvesOnPath,
  commandStatusText,
} from '../backends/status.js';
import {
  parseWorkspace,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { editCanonicalFile } from './edit.js';
import { refreshDiagnostics } from './register.js';
import {
  operationFailed,
  operationOk,
  type OperationResult,
} from './result.js';

export interface BackendSettingsEntry {
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

export interface BackendSettingsSnapshot {
  backends: BackendSettingsEntry[];
  default: string | null;
  workspaceHash: string | null;
}

export interface AddBackendEntryInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
  expectedHash?: string | undefined;
}

export interface UpdateBackendEntryInput {
  name: string;
  config: Record<string, unknown>;
  expectedHash?: string | undefined;
}

export interface RemoveBackendEntryInput {
  name: string;
  expectedHash?: string | undefined;
}

export interface SetDefaultBackendInput {
  name: string;
  expectedHash?: string | undefined;
}

export interface TestBackendInput {
  name: string;
  credential?: string | undefined;
}

export interface BackendTestResult {
  ok: boolean;
  status: string;
}

export interface BackendModelsInput {
  command: string;
  args: string[];
  timeoutMs?: number | undefined;
}

export interface BackendModelsResult {
  models: AcpModelOption[];
}

export const backendTestTimeoutMs = 5000;
export const backendModelsTimeoutMs = 30000;

type SettingsLoad =
  | {
      ok: true;
      settings: ParsedWorkspaceFile;
      resolution: BackendsResolution;
    }
  | { ok: false; diagnostics: Diagnostic[] };

export async function readBackendSettings(
  root: string,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const load = await loadSettingsFile(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  return operationOk(
    false,
    [],
    await snapshotOf(load.settings, load.resolution),
    settingsDiagnosticsOf(load),
  );
}

export async function addBackendEntry(
  root: string,
  input: AddBackendEntryInput,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const name = input.name.trim();
  if (!backendNameSchema.safeParse(name).success) {
    return operationFailed([nameInvalidDiagnostic(root)]);
  }
  const load = await prepareWrite(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  const stale = staleHashCheck(load, input.expectedHash);
  if (stale !== null) return operationFailed([stale]);
  if (entryNamesOf(load.settings).includes(name)) {
    return operationFailed([targetExistsDiagnostic(load.settings.file, name)]);
  }
  return commitBackendSettings(root, load, input.expectedHash, (document) => {
    const entries = ensureEntriesMap(document);
    if (entries === null) return false;
    entries.set(
      name,
      document.createNode({ type: input.type, ...input.config }),
    );
    return true;
  });
}

export async function updateBackendEntry(
  root: string,
  input: UpdateBackendEntryInput,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const name = input.name.trim();
  const load = await prepareWrite(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  const stale = staleHashCheck(load, input.expectedHash);
  if (stale !== null) return operationFailed([stale]);
  if (!entryNamesOf(load.settings).includes(name)) {
    return operationFailed([notFoundDiagnostic(load.settings.file, name)]);
  }
  return commitBackendSettings(root, load, input.expectedHash, (document) => {
    const entries = ensureEntriesMap(document);
    if (entries === null) return false;
    const entry = entries.get(name, true);
    if (!isMap(entry)) return false;
    const before = String(document);
    for (const [key, value] of Object.entries(input.config)) {
      if (value === null) {
        entry.delete(key);
      } else {
        entry.set(key, document.createNode(value));
      }
    }
    return String(document) !== before;
  });
}

export async function removeBackendEntry(
  root: string,
  input: RemoveBackendEntryInput,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const name = input.name.trim();
  const load = await prepareWrite(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  const stale = staleHashCheck(load, input.expectedHash);
  if (stale !== null) return operationFailed([stale]);
  if (!entryNamesOf(load.settings).includes(name)) {
    return operationFailed([notFoundDiagnostic(load.settings.file, name)]);
  }
  if (load.resolution.defaultName === name) {
    return operationFailed([defaultInUseDiagnostic(load.settings.file, name)]);
  }
  return commitBackendSettings(root, load, input.expectedHash, (document) => {
    const entries = ensureEntriesMap(document);
    if (entries === null) return false;
    const before = String(document);
    entries.delete(name);
    return String(document) !== before;
  });
}

export async function setDefaultBackend(
  root: string,
  input: SetDefaultBackendInput,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const name = input.name.trim();
  const load = await prepareWrite(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  const stale = staleHashCheck(load, input.expectedHash);
  if (stale !== null) return operationFailed([stale]);
  if (!entryNamesOf(load.settings).includes(name)) {
    return operationFailed([notFoundDiagnostic(load.settings.file, name)]);
  }
  return commitBackendSettings(root, load, input.expectedHash, (document) => {
    const backends = ensureBackendsMap(document);
    if (backends === null) return false;
    const before = String(document);
    backends.set('default', document.createNode(name));
    return String(document) !== before;
  });
}

export async function testBackend(
  root: string,
  input: TestBackendInput,
): Promise<OperationResult<BackendTestResult>> {
  const load = await loadSettingsFile(root);
  if (!load.ok) return operationFailed(load.diagnostics);
  const name = input.name.trim();
  const lookup = findBackend(load.resolution, name);
  if (lookup.backend === null) {
    return operationFailed([notFoundDiagnostic(load.settings.file, name)]);
  }
  const backend = lookup.backend;
  switch (backend.type) {
    case 'openai':
      return operationOk(
        false,
        [],
        await probeOpenAiBackend(backend, input.credential),
        [],
      );
    case 'opencode':
      return operationOk(false, [], await commandProbe(backend.command), []);
    default: {
      const command = (backend as { command?: unknown }).command;
      if (typeof command === 'string') {
        return operationOk(false, [], await commandProbe(command), []);
      }
      return operationOk(false, [], untestableBackend(backend), []);
    }
  }
}

// Spawns the named harness briefly and returns the models its session reports.
// The command comes straight from the settings form, so unsaved edits can be
// probed; nothing is written.
export async function listBackendModels(
  root: string,
  input: BackendModelsInput,
): Promise<OperationResult<BackendModelsResult>> {
  const command = input.command.trim();
  if (command === '') {
    return operationFailed([commandMissingDiagnostic(root)]);
  }
  const config: AgentBackendConfig = {
    type: 'agent',
    name: 'settings-models',
    command,
    args: [...input.args],
    model: undefined,
    timeoutMs: input.timeoutMs ?? backendModelsTimeoutMs,
  };
  const result = await listAcpModels(config, childProcessAcpTransport, {
    cwd: path.resolve(root),
  });
  if (!result.ok) {
    return operationFailed([
      diagnostic(
        root,
        'backend.request_failed',
        'error',
        `Listing models from command '${command}' failed: ${result.message}`,
      ),
    ]);
  }
  return operationOk(false, [], { models: result.models }, []);
}

async function commitBackendSettings(
  root: string,
  load: Extract<SettingsLoad, { ok: true }>,
  expectedHash: string | undefined,
  change: (document: Document.Parsed<ParsedNode>) => boolean,
): Promise<OperationResult<BackendSettingsSnapshot>> {
  const edited = await editCanonicalFile({
    file: load.settings.file,
    kind: 'workspace',
    root,
    expectedHash,
    change,
  });
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    return operationFailed(edited.diagnostics);
  }
  const refreshed = edited.changed ? await refreshDiagnostics(root) : [];
  const reloaded = await loadSettingsFile(root);
  if (!reloaded.ok) return operationFailed(reloaded.diagnostics);
  return operationOk(
    edited.changed,
    edited.changed ? [load.settings.file] : [],
    await snapshotOf(reloaded.settings, reloaded.resolution),
    [...edited.diagnostics, ...refreshed, ...settingsDiagnosticsOf(reloaded)],
  );
}

async function prepareWrite(root: string): Promise<SettingsLoad> {
  const load = await loadSettingsFile(root);
  if (!load.ok) return load;
  if (
    load.resolution.diagnostics.some((entry) => entry.code === 'backend.schema')
  ) {
    return {
      ok: false,
      diagnostics: load.resolution.diagnostics.filter(
        (entry) => entry.code === 'backend.schema',
      ),
    };
  }
  return load;
}

function staleHashCheck(
  load: Extract<SettingsLoad, { ok: true }>,
  expectedHash: string | undefined,
): Diagnostic | null {
  if (
    expectedHash === undefined ||
    expectedHash === load.settings.contentHash
  ) {
    return null;
  }
  return diagnostic(
    load.settings.file,
    'edit.stale_hash',
    'error',
    'The workspace settings changed since they were loaded; nothing was written.',
  );
}

async function loadSettingsFile(root: string): Promise<SettingsLoad> {
  const parsed = await parseWorkspace(root);
  const settings =
    parsed.files.find((file) => file.kind === 'workspace') ?? null;
  if (settings === null) {
    return { ok: false, diagnostics: [missingSettingsDiagnostic(root)] };
  }
  if (settings.contentHash === null) {
    const diagnostics =
      settings.diagnostics.length > 0
        ? settings.diagnostics
        : [unreadableSettingsDiagnostic(settings.file)];
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    settings,
    resolution: resolveBackends(settings.file, settings.metadata),
  };
}

function settingsDiagnosticsOf(
  load: Extract<SettingsLoad, { ok: true }>,
): Diagnostic[] {
  return [...load.settings.diagnostics, ...load.resolution.diagnostics];
}

async function snapshotOf(
  settings: ParsedWorkspaceFile,
  resolution: BackendsResolution,
): Promise<BackendSettingsSnapshot> {
  const backends: BackendSettingsEntry[] = [];
  for (const backend of resolution.entries) {
    backends.push(await settingsEntryOf(backend, resolution.defaultName));
  }
  return {
    backends,
    default: resolution.defaultName,
    workspaceHash: settings.contentHash,
  };
}

async function settingsEntryOf(
  backend: ResolvedBackendConfig,
  defaultName: string | null,
): Promise<BackendSettingsEntry> {
  const shared = {
    name: backend.name,
    type: backend.type,
    isDefault: backend.name === defaultName,
    status: await backendStatus(backend),
  };
  switch (backend.type) {
    case 'openai':
      return {
        ...shared,
        model: backend.model,
        apiKeyEnv: backend.apiKeyEnv ?? null,
        baseUrl: backend.baseUrl,
        command: null,
        args: null,
        timeoutMs: backend.timeoutMs,
      };
    case 'opencode':
      return {
        ...shared,
        model: backend.model ?? null,
        apiKeyEnv: null,
        baseUrl: null,
        command: backend.command,
        args: [...backend.args],
        timeoutMs: null,
      };
    case 'agent':
      return {
        ...shared,
        model: backend.model ?? null,
        apiKeyEnv: null,
        baseUrl: null,
        command: backend.command,
        args: [...backend.args],
        timeoutMs: backend.timeoutMs,
      };
    default: {
      const fields = backend as Record<string, unknown>;
      return {
        ...shared,
        model: typeof fields.model === 'string' ? fields.model : null,
        apiKeyEnv:
          typeof fields.apiKeyEnv === 'string' ? fields.apiKeyEnv : null,
        baseUrl: typeof fields.baseUrl === 'string' ? fields.baseUrl : null,
        command: typeof fields.command === 'string' ? fields.command : null,
        args: Array.isArray(fields.args)
          ? fields.args.filter((arg): arg is string => typeof arg === 'string')
          : null,
        timeoutMs:
          typeof fields.timeoutMs === 'number' ? fields.timeoutMs : null,
      };
    }
  }
}

function ensureBackendsMap(
  document: Document.Parsed<ParsedNode>,
): YAMLMap | null {
  const existing = document.get('backends', true);
  if (isMap(existing)) return existing;
  if (existing !== undefined && existing !== null) return null;
  document.set('backends', document.createNode({}));
  const created = document.get('backends', true);
  return isMap(created) ? created : null;
}

function ensureEntriesMap(
  document: Document.Parsed<ParsedNode>,
): YAMLMap | null {
  const backends = ensureBackendsMap(document);
  if (backends === null) return null;
  const existing = backends.get('entries', true);
  if (isMap(existing)) return existing;
  if (existing !== undefined && existing !== null) return null;
  backends.set('entries', document.createNode({}));
  const created = backends.get('entries', true);
  return isMap(created) ? created : null;
}

function entryNamesOf(settings: ParsedWorkspaceFile): string[] {
  const backends = settings.metadata?.backends;
  if (!isRecord(backends)) return [];
  const entries = backends.entries;
  if (!isRecord(entries)) return [];
  return Object.keys(entries);
}

async function probeOpenAiBackend(
  backend: OpenAiBackendConfig,
  sessionCredential: string | undefined,
): Promise<BackendTestResult> {
  const headers: Record<string, string> = {};
  const apiKey =
    sessionCredential !== undefined && sessionCredential !== ''
      ? sessionCredential
      : backend.apiKeyEnv !== undefined
        ? process.env[backend.apiKeyEnv]
        : undefined;
  if (apiKey !== undefined && apiKey !== '') {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const url = `${backend.baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), backendTestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    return { ok: false, status: `unreachable: ${networkReason(error)}` };
  } finally {
    clearTimeout(timer);
  }
  if (response.ok) return { ok: true, status: 'reachable' };
  if (response.status === 401) {
    return { ok: false, status: 'reachable but unauthorized (401)' };
  }
  return {
    ok: false,
    status: `reachable but returned HTTP ${response.status}`,
  };
}

async function commandProbe(command: string): Promise<BackendTestResult> {
  const resolves = await commandResolvesOnPath(command);
  return { ok: resolves, status: commandStatusText(command, resolves) };
}

function untestableBackend(backend: ResolvedBackendConfig): BackendTestResult {
  return {
    ok: false,
    status: `backend type '${String(backend.type)}' cannot be tested`,
  };
}

function networkReason(error: unknown): string {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (typeof current === 'object' && current !== null && chain.length < 8) {
    chain.push(current);
    const record = current as { cause?: unknown; errors?: unknown };
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      current = record.errors[0];
      continue;
    }
    if (record.cause !== undefined && record.cause !== null) {
      current = record.cause;
      continue;
    }
    break;
  }
  for (const entry of chain) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { name?: unknown }).name === 'AbortError'
    ) {
      return `timed out after ${backendTestTimeoutMs}ms`;
    }
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const message = (chain[index] as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  for (const entry of chain) {
    const code = (entry as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return error instanceof Error ? error.message : String(error);
}

function missingSettingsDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'workspace.missing',
    'error',
    'This workspace has no workspace.yml settings file.',
  );
}

function commandMissingDiagnostic(root: string): Diagnostic {
  return diagnostic(
    root,
    'operation.target_invalid',
    'error',
    "The 'command' field is required to list harness models.",
    { fieldPath: 'command' },
  );
}

function unreadableSettingsDiagnostic(file: string): Diagnostic {
  return diagnostic(
    file,
    'file.unreadable',
    'error',
    'The workspace settings file could not be read.',
  );
}

function nameInvalidDiagnostic(file: string): Diagnostic {
  return diagnostic(file, 'backend.name_invalid', 'error', backendNameMessage, {
    fieldPath: 'name',
  });
}

function targetExistsDiagnostic(file: string, name: string): Diagnostic {
  return diagnostic(
    file,
    'backend.target_exists',
    'error',
    `Backend '${name}' is already configured in this workspace.`,
    { fieldPath: 'name' },
  );
}

export function notFoundDiagnostic(file: string, name: string): Diagnostic {
  return diagnostic(
    file,
    'backend.not_found',
    'error',
    `Backend '${name}' is not configured in this workspace.`,
    { fieldPath: 'name' },
  );
}

function defaultInUseDiagnostic(file: string, name: string): Diagnostic {
  return diagnostic(
    file,
    'backend.default_in_use',
    'error',
    `Backend '${name}' is the default backend; set another default before removing it.`,
    { fieldPath: 'name' },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
