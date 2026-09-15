import { useCallback, useEffect, useRef, useState } from 'react';

import { getJson, postJson, type ApiFailure } from '../shared/api.js';
import { parseDiagnostics } from '../shared/responses.js';
import type { DiagnosticView } from '../shared/types.js';
import {
  buildAddPayload,
  buildBackendNamePayload,
  buildCredentialPayload,
  buildUpdatePayload,
  classifySettingsFailure,
  toAgentModels,
  toSettingsBackends,
  toTestResult,
  type AgentModelOption,
  type BackendFormValues,
  type BackendType,
  type PresetKind,
  type SettingsFailure,
  type SettingsFailureKind,
  type SettingsSnapshot,
} from '../settings/model.js';

export type SettingsStatus = 'loading' | 'ready' | 'error';

export interface BackendTestView {
  ok: boolean;
  status: string;
  diagnostics: DiagnosticView[];
}

export interface SettingsMutationResult {
  ok: boolean;
  message: string | null;
  failure: SettingsFailure | null;
}

export interface AddBackendInput {
  name: string;
  kind: PresetKind;
  values: BackendFormValues;
}

export interface UpdateBackendInput {
  name: string;
  type: BackendType;
  values: BackendFormValues;
}

export type AgentModelsOutcome =
  { ok: true; models: AgentModelOption[] } | { ok: false; message: string };

export interface SettingsPageApi {
  status: SettingsStatus;
  snapshot: SettingsSnapshot | null;
  loadFailure: SettingsFailure | null;
  notice: string | null;
  busyName: string | null;
  testingName: string | null;
  tests: Record<string, BackendTestView>;
  retry: () => void;
  clearNotice: () => void;
  addBackend: (input: AddBackendInput) => Promise<SettingsMutationResult>;
  updateBackend: (input: UpdateBackendInput) => Promise<SettingsMutationResult>;
  removeBackend: (name: string) => Promise<SettingsMutationResult>;
  setDefault: (name: string) => Promise<SettingsMutationResult>;
  setCredential: (
    name: string,
    apiKey: string,
  ) => Promise<SettingsMutationResult>;
  testBackend: (name: string) => Promise<void>;
  loadAgentModels: (
    command: string,
    args: string[],
  ) => Promise<AgentModelsOutcome>;
}

export const addBusyName = '__add__';

const staleNotice =
  'The settings changed elsewhere, so the latest workspace.yml was reloaded. Review the values and try again.';

const accepted: SettingsMutationResult = {
  ok: true,
  message: null,
  failure: null,
};

function localFailure(message: string): SettingsMutationResult {
  return { ok: false, message, failure: null };
}

// Owns the GET /api/backends snapshot plus every write endpoint. Expected hashes
// come from the latest workspaceHash, and a 409 refetches the snapshot and
// raises a notice. Pure payload building and failure classification live in
// settings/model.ts.
export function useSettingsPage(): SettingsPageApi {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [status, setStatus] = useState<SettingsStatus>('loading');
  const [loadFailure, setLoadFailure] = useState<SettingsFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, BackendTestView>>({});
  const snapshotRef = useRef<SettingsSnapshot | null>(snapshot);
  const tokenRef = useRef(0);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  const fetchSnapshot = useCallback(
    async (mode: 'load' | 'quiet'): Promise<void> => {
      const token = tokenRef.current + 1;
      tokenRef.current = token;
      if (mode === 'load') setStatus('loading');
      const outcome = await getJson<unknown>('/api/backends');
      if (token !== tokenRef.current) return;
      if (outcome.ok) {
        setSnapshot(toSettingsBackends(outcome.data));
        setStatus('ready');
        setLoadFailure(null);
        return;
      }
      if (mode === 'load') {
        setLoadFailure(
          classifySettingsFailure(
            'list',
            outcome.failure.status,
            outcome.failure.diagnostics,
            outcome.failure.currentHash,
          ),
        );
        setStatus('error');
      }
    },
    [],
  );

  useEffect(() => {
    void fetchSnapshot('load');
  }, [fetchSnapshot]);

  const currentHash = useCallback(
    (): string | null => snapshotRef.current?.workspaceHash ?? null,
    [],
  );

  const finishFailure = useCallback(
    (
      kind: SettingsFailureKind,
      failure: ApiFailure,
    ): SettingsMutationResult => {
      const classified = classifySettingsFailure(
        kind,
        failure.status,
        failure.diagnostics,
        failure.currentHash,
      );
      if (classified.conflict) {
        setNotice(staleNotice);
        void fetchSnapshot('quiet');
      }
      return { ok: false, message: classified.message, failure: classified };
    },
    [fetchSnapshot],
  );

  const applySnapshot = useCallback((data: unknown): void => {
    setSnapshot(toSettingsBackends(data));
    setStatus('ready');
    setLoadFailure(null);
  }, []);

  const addBackend = useCallback(
    async (input: AddBackendInput): Promise<SettingsMutationResult> => {
      const built = buildAddPayload(input, currentHash());
      if (!built.ok) return localFailure(built.message);
      setBusyName(addBusyName);
      const outcome = await postJson<unknown>(
        '/api/backends/add',
        built.payload,
      );
      setBusyName(null);
      if (outcome.ok) {
        applySnapshot(outcome.data);
        return accepted;
      }
      return finishFailure('save', outcome.failure);
    },
    [applySnapshot, currentHash, finishFailure],
  );

  const updateBackend = useCallback(
    async (input: UpdateBackendInput): Promise<SettingsMutationResult> => {
      const built = buildUpdatePayload(input, currentHash());
      if (!built.ok) return localFailure(built.message);
      setBusyName(input.name);
      const outcome = await postJson<unknown>(
        '/api/backends/update',
        built.payload,
      );
      setBusyName(null);
      if (outcome.ok) {
        applySnapshot(outcome.data);
        return accepted;
      }
      return finishFailure('save', outcome.failure);
    },
    [applySnapshot, currentHash, finishFailure],
  );

  const removeBackend = useCallback(
    async (name: string): Promise<SettingsMutationResult> => {
      const built = buildBackendNamePayload(name, currentHash());
      if (!built.ok) return localFailure(built.message);
      setBusyName(name);
      const outcome = await postJson<unknown>(
        '/api/backends/remove',
        built.payload,
      );
      setBusyName(null);
      if (outcome.ok) {
        applySnapshot(outcome.data);
        return accepted;
      }
      return finishFailure('remove', outcome.failure);
    },
    [applySnapshot, currentHash, finishFailure],
  );

  const setDefault = useCallback(
    async (name: string): Promise<SettingsMutationResult> => {
      const built = buildBackendNamePayload(name, currentHash());
      if (!built.ok) return localFailure(built.message);
      setBusyName(name);
      const outcome = await postJson<unknown>(
        '/api/backends/default',
        built.payload,
      );
      setBusyName(null);
      if (outcome.ok) {
        applySnapshot(outcome.data);
        return accepted;
      }
      return finishFailure('default', outcome.failure);
    },
    [applySnapshot, currentHash, finishFailure],
  );

  const setCredential = useCallback(
    async (name: string, apiKey: string): Promise<SettingsMutationResult> => {
      const built = buildCredentialPayload(name, apiKey);
      if (!built.ok) return localFailure(built.message);
      setBusyName(name);
      const outcome = await postJson<unknown>(
        '/api/backends/credential',
        built.payload,
      );
      setBusyName(null);
      if (outcome.ok) {
        await fetchSnapshot('quiet');
        return accepted;
      }
      return finishFailure('credential', outcome.failure);
    },
    [fetchSnapshot, finishFailure],
  );

  const testBackend = useCallback(async (name: string): Promise<void> => {
    setTestingName(name);
    const outcome = await postJson<unknown>('/api/backends/test', { name });
    setTestingName(null);
    if (outcome.ok) {
      const result = toTestResult(outcome.data);
      setTests((previous) => ({
        ...previous,
        [name]: {
          ok: result.ok,
          status: result.status,
          diagnostics: parseDiagnostics(outcome.data),
        },
      }));
      return;
    }
    const classified = classifySettingsFailure(
      'test',
      outcome.failure.status,
      outcome.failure.diagnostics,
      outcome.failure.currentHash,
    );
    setTests((previous) => ({
      ...previous,
      [name]: {
        ok: false,
        status: classified.message,
        diagnostics: classified.diagnostics,
      },
    }));
  }, []);

  const loadAgentModels = useCallback(
    async (command: string, args: string[]): Promise<AgentModelsOutcome> => {
      const outcome = await postJson<unknown>('/api/backends/models', {
        command,
        args,
      });
      if (outcome.ok) {
        return { ok: true, models: toAgentModels(outcome.data) };
      }
      const first =
        outcome.failure.diagnostics[0]?.message ??
        outcome.failure.errorText ??
        null;
      return {
        ok: false,
        message: first ?? 'The harness models could not be listed.',
      };
    },
    [],
  );

  const retry = useCallback(() => {
    void fetchSnapshot('load');
  }, [fetchSnapshot]);

  const clearNotice = useCallback(() => {
    setNotice(null);
  }, []);

  return {
    status,
    snapshot,
    loadFailure,
    notice,
    busyName,
    testingName,
    tests,
    retry,
    clearNotice,
    addBackend,
    updateBackend,
    removeBackend,
    setDefault,
    setCredential,
    testBackend,
    loadAgentModels,
  };
}
