import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveBackends } from '../backends/config.js';
import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { parseWorkspace } from '../files/workspace.js';
import { hashOf } from '../operations/edit.js';
import {
  addBackendEntry,
  listBackendModels,
  notFoundDiagnostic,
  readBackendSettings,
  removeBackendEntry,
  setDefaultBackend,
  testBackend,
  updateBackendEntry,
  type BackendModelsInput,
  type BackendSettingsSnapshot,
} from '../operations/backendSettings.js';
import type { OperationResult } from '../operations/result.js';
import {
  apiFailure,
  badRequest,
  hashRequiredResponse,
  isContentHash,
  type ApiResponse,
} from './api.js';
import type { BackendCredentialStore } from './credentials.js';

export interface BackendAddInput {
  name: string;
  type: string;
  config: Record<string, unknown>;
  expectedHash: string | null;
}

export interface BackendUpdateInput {
  name: string;
  config: Record<string, unknown>;
  expectedHash: string | null;
}

export interface BackendNameInput {
  name: string;
  expectedHash: string | null;
}

export interface BackendTestPayloadInput {
  name: string;
}

export interface BackendModelsPayload {
  command: string;
  args: string[];
  timeoutMs: number | null;
}

export interface BackendCredentialInput {
  name: string;
  apiKey: string;
}

export function parseBackendAddPayload(
  payload: unknown,
): { ok: true; input: BackendAddInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.name !== 'string' || payload.name.trim() === '') {
    return { ok: false, message: "The 'name' field is required." };
  }
  if (typeof payload.type !== 'string' || payload.type.trim() === '') {
    return { ok: false, message: "The 'type' field is required." };
  }
  const config = configOf(payload);
  if (config === null) {
    return { ok: false, message: "The 'config' field must be an object." };
  }
  return {
    ok: true,
    input: {
      name: payload.name,
      type: payload.type,
      config,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseBackendUpdatePayload(
  payload: unknown,
): { ok: true; input: BackendUpdateInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.name !== 'string' || payload.name.trim() === '') {
    return { ok: false, message: "The 'name' field is required." };
  }
  const config = configOf(payload);
  if (config === null) {
    return { ok: false, message: "The 'config' field must be an object." };
  }
  return {
    ok: true,
    input: {
      name: payload.name,
      config,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseBackendNamePayload(
  payload: unknown,
): { ok: true; input: BackendNameInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.name !== 'string' || payload.name.trim() === '') {
    return { ok: false, message: "The 'name' field is required." };
  }
  return {
    ok: true,
    input: {
      name: payload.name,
      expectedHash:
        typeof payload.expectedHash === 'string' ? payload.expectedHash : null,
    },
  };
}

export function parseBackendTestPayload(
  payload: unknown,
):
  | { ok: true; input: BackendTestPayloadInput }
  | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.name !== 'string' || payload.name.trim() === '') {
    return { ok: false, message: "The 'name' field is required." };
  }
  return { ok: true, input: { name: payload.name } };
}

export function parseBackendCredentialPayload(
  payload: unknown,
):
  { ok: true; input: BackendCredentialInput } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.name !== 'string' || payload.name.trim() === '') {
    return { ok: false, message: "The 'name' field is required." };
  }
  if (typeof payload.apiKey !== 'string') {
    return { ok: false, message: "The 'apiKey' field must be a string." };
  }
  return { ok: true, input: { name: payload.name, apiKey: payload.apiKey } };
}

export async function backendsApi(
  root: string,
  credentials: BackendCredentialStore,
): Promise<ApiResponse> {
  const result = await readBackendSettings(root);
  if (!result.success || result.data === null) {
    return backendFailureResponse(root, result.diagnostics);
  }
  const backends = result.data.backends.map((entry) => ({
    ...entry,
    credentialReady: credentials.hasCredential(entry.name),
  }));
  return {
    status: 200,
    body: { ...result.data, backends, diagnostics: result.diagnostics },
  };
}

export async function backendsCredentialApi(
  root: string,
  payload: unknown,
  credentials: BackendCredentialStore,
): Promise<ApiResponse> {
  const parsed = parseBackendCredentialPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (parsed.input.apiKey.trim() === '') {
    const entry = diagnostic(
      root,
      'backend.credential_empty',
      'error',
      "The 'apiKey' field must not be empty; the credential is kept in memory for this server session only.",
      { fieldPath: 'apiKey' },
    );
    return {
      status: 422,
      body: { error: entry.message, diagnostics: [entry] },
    };
  }
  const configured = await configuredBackendNames(root);
  if (configured === null || !configured.names.includes(parsed.input.name)) {
    return backendFailureResponse(root, [
      notFoundDiagnostic(
        configured?.file ?? path.join(path.resolve(root), 'workspace.yml'),
        parsed.input.name,
      ),
    ]);
  }
  credentials.setCredential(parsed.input.name, parsed.input.apiKey);
  return {
    status: 200,
    body: { ok: true, stored: true, sessionOnly: true, diagnostics: [] },
  };
}

export async function backendsAddApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBackendAddPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/backends');
  }
  const result = await addBackendEntry(root, {
    name: parsed.input.name,
    type: parsed.input.type,
    config: parsed.input.config,
    expectedHash: parsed.input.expectedHash ?? undefined,
  });
  return backendWriteResponse(root, result, 201);
}

export async function backendsUpdateApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBackendUpdatePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/backends');
  }
  const result = await updateBackendEntry(root, {
    name: parsed.input.name,
    config: parsed.input.config,
    expectedHash: parsed.input.expectedHash ?? undefined,
  });
  return backendWriteResponse(root, result, 200);
}

export async function backendsRemoveApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBackendNamePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/backends');
  }
  const result = await removeBackendEntry(root, {
    name: parsed.input.name,
    expectedHash: parsed.input.expectedHash ?? undefined,
  });
  return backendWriteResponse(root, result, 200);
}

export async function backendsDefaultApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBackendNamePayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  if (!isContentHash(parsed.input.expectedHash)) {
    return hashRequiredResponse(root, 'GET /api/backends');
  }
  const result = await setDefaultBackend(root, {
    name: parsed.input.name,
    expectedHash: parsed.input.expectedHash ?? undefined,
  });
  return backendWriteResponse(root, result, 200);
}

export function parseBackendModelsPayload(
  payload: unknown,
): { ok: true; input: BackendModelsPayload } | { ok: false; message: string } {
  if (!isRecord(payload)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  if (typeof payload.command !== 'string' || payload.command.trim() === '') {
    return { ok: false, message: "The 'command' field is required." };
  }
  const args =
    payload.args === undefined || payload.args === null
      ? []
      : Array.isArray(payload.args)
        ? payload.args.every((arg) => typeof arg === 'string')
          ? payload.args
          : null
        : null;
  if (args === null) {
    return {
      ok: false,
      message: "The 'args' field must be a list of strings.",
    };
  }
  let timeoutMs: number | null = null;
  if (payload.timeout_ms !== undefined && payload.timeout_ms !== null) {
    if (
      typeof payload.timeout_ms !== 'number' ||
      !Number.isInteger(payload.timeout_ms) ||
      payload.timeout_ms <= 0
    ) {
      return {
        ok: false,
        message: "The 'timeout_ms' field must be a positive whole number.",
      };
    }
    timeoutMs = payload.timeout_ms;
  }
  return {
    ok: true,
    input: { command: payload.command, args, timeoutMs },
  };
}

export async function backendsModelsApi(
  root: string,
  payload: unknown,
): Promise<ApiResponse> {
  const parsed = parseBackendModelsPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const input: BackendModelsInput = {
    command: parsed.input.command,
    args: parsed.input.args,
    timeoutMs: parsed.input.timeoutMs ?? undefined,
  };
  const result = await listBackendModels(root, input);
  if (!result.success || result.data === null) {
    return backendFailureResponse(root, result.diagnostics);
  }
  return {
    status: 200,
    body: { models: result.data.models, diagnostics: result.diagnostics },
  };
}

export async function backendsTestApi(
  root: string,
  payload: unknown,
  credentials: BackendCredentialStore,
): Promise<ApiResponse> {
  const parsed = parseBackendTestPayload(payload);
  if (!parsed.ok) return badRequest(parsed.message);
  const result = await testBackend(root, {
    name: parsed.input.name,
    credential: credentials.getCredential(parsed.input.name),
  });
  if (!result.success || result.data === null) {
    return backendFailureResponse(root, result.diagnostics);
  }
  return {
    status: 200,
    body: { ...result.data, diagnostics: result.diagnostics },
  };
}

async function backendWriteResponse(
  root: string,
  result: OperationResult<BackendSettingsSnapshot>,
  successStatus: number,
): Promise<ApiResponse> {
  if (!result.success || result.data === null) {
    return backendFailureResponse(root, result.diagnostics);
  }
  return {
    status: successStatus,
    body: { ...result.data, diagnostics: result.diagnostics },
  };
}

type BackendWriteStatus = 'invalid' | 'conflict' | 'notFound' | 'unavailable';

const backendWriteStatusCodes: Record<BackendWriteStatus, number> = {
  invalid: 422,
  conflict: 409,
  notFound: 404,
  unavailable: 500,
};

function backendWriteStatusOf(diagnostics: Diagnostic[]): BackendWriteStatus {
  if (diagnostics.some((entry) => entry.code === 'backend.not_found')) {
    return 'notFound';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'write.conflict' || entry.code === 'edit.stale_hash',
    )
  ) {
    return 'conflict';
  }
  if (
    diagnostics.some(
      (entry) =>
        entry.code === 'workspace.missing' || entry.code === 'file.unreadable',
    )
  ) {
    return 'unavailable';
  }
  return 'invalid';
}

async function backendFailureResponse(
  root: string,
  diagnostics: Diagnostic[],
): Promise<ApiResponse> {
  const status = backendWriteStatusOf(diagnostics);
  const extra: Record<string, unknown> = {};
  if (status === 'conflict') {
    extra.currentHash = await currentWorkspaceHash(root);
  }
  return apiFailure(backendWriteStatusCodes[status], diagnostics, extra);
}

async function currentWorkspaceHash(root: string): Promise<string | null> {
  try {
    return hashOf(
      await readFile(path.join(path.resolve(root), 'workspace.yml')),
    );
  } catch {
    return null;
  }
}

async function configuredBackendNames(
  root: string,
): Promise<{ file: string; names: string[] } | null> {
  const parsed = await parseWorkspace(root);
  const settings =
    parsed.files.find((file) => file.kind === 'workspace') ?? null;
  if (settings === null || settings.contentHash === null) return null;
  const resolution = resolveBackends(settings.file, settings.metadata);
  return {
    file: settings.file,
    names: resolution.entries.map((entry) => entry.name),
  };
}

function configOf(
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  if (payload.config === undefined || payload.config === null) return {};
  return isRecord(payload.config) ? payload.config : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
