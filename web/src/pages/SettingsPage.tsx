import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { BackendIcon, classNames } from '../shared/controls/index.js';
import { backendIconKind } from '../shared/controls/logic.js';
import { AppShell } from '../shared/shell/AppShell.js';
import {
  EMPTY_FORM_VALUES,
  PRESET_KINDS,
  PRESET_LABELS,
  backendTypeOf,
  formFieldKeysOf,
  formValuesOfBackend,
  modelProbeOf,
  presetDefaults,
  presetKindOfBackendType,
  presetTypeOf,
  settingsFormErrorsOf,
  type AgentModelOption,
  type BackendFormValues,
  type PresetKind,
  type SettingsBackend,
  type SettingsFormErrors,
} from '../settings/model.js';
import { PagePlaceholder } from './stub.js';
import {
  addBusyName,
  useSettingsPage,
  type BackendTestView,
  type SettingsPageApi,
} from './useSettingsPage.js';

interface ModelPicker {
  options: AgentModelOption[] | null;
  loading: boolean;
  error: string | null;
}

const modelProbeDebounceMs = 500;

// Refreshes the model list by itself: the form's harness command is probed
// whenever it settles, so opening a preset or editing the command reloads the
// dropdown without a button. Responses are token-guarded so a stale probe
// never overwrites a newer one.
function useModelPicker(
  loadModels: SettingsPageApi['loadAgentModels'],
  kind: PresetKind,
  command: string,
  argsText: string,
): ModelPicker {
  const [options, setOptions] = useState<AgentModelOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  useEffect(() => {
    const probe = modelProbeOf(kind, command, argsText);
    if (probe === null) {
      tokenRef.current += 1;
      setOptions(null);
      setLoading(false);
      setError(null);
      return;
    }
    const token = tokenRef.current + 1;
    tokenRef.current = token;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void loadModels(probe.command, probe.args).then((outcome) => {
        if (token !== tokenRef.current) return;
        setLoading(false);
        if (outcome.ok) {
          setOptions(outcome.models);
          setError(
            outcome.models.length === 0
              ? 'The harness reported no models; type a model id instead.'
              : null,
          );
          return;
        }
        setError(outcome.message);
      });
    }, modelProbeDebounceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [loadModels, kind, command, argsText]);
  return { options, loading, error };
}

function commandText(backend: SettingsBackend): string {
  return [backend.command ?? '', ...(backend.args ?? [])]
    .filter((part) => part !== '')
    .join(' ');
}

function readinessClass(backend: SettingsBackend): string {
  return backend.type === 'openai' && !backend.credentialReady ? 'warn' : 'ok';
}

function statusLabel(backend: SettingsBackend): string {
  if (backend.status !== '') return backend.status;
  if (backend.credentialReady) return 'key held for session';
  return 'not ready';
}

function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: readonly string[] | undefined;
  children: ReactNode;
}) {
  const generatedId = useId();
  let field: ReactNode = children;
  let fieldId = generatedId;
  if (isValidElement(children)) {
    const props = children.props as { id?: string };
    fieldId = props.id ?? generatedId;
    field = cloneElement(children as ReactElement<{ id?: string }>, {
      id: fieldId,
    });
  }
  return (
    <div className="field" style={{ margin: 0 }}>
      <label className="fl" htmlFor={fieldId}>
        {label}
      </label>
      {field}
      {error !== undefined && error.length > 0 && (
        <span className="fnote" style={{ color: 'var(--danger)' }}>
          {error.join(' ')}
        </span>
      )}
    </div>
  );
}

function BackendFields({
  kind,
  values,
  errors,
  onChange,
  models,
}: {
  kind: PresetKind;
  values: BackendFormValues;
  errors: SettingsFormErrors | null;
  onChange: (values: BackendFormValues) => void;
  models?: ModelPicker | undefined;
}) {
  const keys = formFieldKeysOf(kind);
  const fields = errors?.fields ?? {};
  // OpenCode and ACP harnesses expose their model list, so their model field
  // becomes a dropdown once it loads; the OpenAI-compatible endpoint keeps a
  // free-text field. Callers pass the picker only for those kinds.
  const pickable = models !== undefined;
  const set = (key: keyof BackendFormValues, value: string) => {
    onChange({ ...values, [key]: value });
  };
  return (
    <>
      {keys.includes('model') && (
        <div>
          <FormField label="Model" error={fields['model']}>
            {pickable && models !== undefined && models.options !== null ? (
              <select
                className="input mono"
                value={values.model}
                data-testid="backend-model-select"
                onChange={(event) => {
                  set('model', event.currentTarget.value);
                }}
              >
                <option value="">harness default</option>
                {values.model !== '' &&
                  !models.options.some(
                    (option) => option.id === values.model,
                  ) && <option value={values.model}>{values.model}</option>}
                {models.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name ?? option.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input mono"
                value={values.model}
                placeholder={
                  pickable
                    ? models?.loading === true
                      ? 'loading models…'
                      : 'harness default'
                    : 'gpt-5.6'
                }
                onChange={(event) => {
                  set('model', event.currentTarget.value);
                }}
              />
            )}
          </FormField>
          {pickable && models?.error !== null && (
            <p
              className="fnote"
              style={{ color: 'var(--danger)', margin: 0 }}
              data-testid="backend-models-error"
            >
              {models?.error}
            </p>
          )}
        </div>
      )}
      {keys.includes('base_url') && (
        <FormField label="Base URL" error={fields['base_url']}>
          <input
            className="input mono"
            value={values.baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(event) => {
              set('baseUrl', event.currentTarget.value);
            }}
          />
        </FormField>
      )}
      {keys.includes('api_key_env') && (
        <FormField label="Key env var" error={fields['api_key_env']}>
          <input
            className="input mono"
            value={values.apiKeyEnv}
            placeholder="OPENAI_API_KEY"
            onChange={(event) => {
              set('apiKeyEnv', event.currentTarget.value);
            }}
          />
        </FormField>
      )}
      {keys.includes('command') && (
        <FormField label="Command" error={fields['command']}>
          <input
            className="input mono"
            value={values.command}
            placeholder="opencode"
            onChange={(event) => {
              set('command', event.currentTarget.value);
            }}
          />
        </FormField>
      )}
      {keys.includes('args') && (
        <FormField label="Args" error={fields['args']}>
          <input
            className="input mono"
            value={values.args}
            placeholder="acp"
            onChange={(event) => {
              set('args', event.currentTarget.value);
            }}
          />
        </FormField>
      )}
      {keys.includes('timeout_ms') && (
        <FormField label="Timeout (ms)" error={fields['timeout_ms']}>
          <input
            className="input mono"
            value={values.timeoutMs}
            placeholder="120000"
            onChange={(event) => {
              set('timeoutMs', event.currentTarget.value);
            }}
          />
        </FormField>
      )}
    </>
  );
}

interface BackendCardProps {
  backend: SettingsBackend;
  isDefault: boolean;
  editing: boolean;
  editValues: BackendFormValues;
  editMessage: string | null;
  editErrors: SettingsFormErrors | null;
  busy: boolean;
  testing: boolean;
  test: BackendTestView | undefined;
  cardMessage: string | null;
  credential: string;
  modelPicker: ModelPicker | undefined;
  onCredentialChange: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeEditValues: (values: BackendFormValues) => void;
  onSubmitEdit: (event: FormEvent<HTMLFormElement>) => void;
  onSetDefault: () => void;
  onRemove: () => void;
  onTest: () => void;
  onSubmitCredential: (event: FormEvent<HTMLFormElement>) => void;
}

function BackendCard({
  backend,
  isDefault,
  editing,
  editValues,
  editMessage,
  editErrors,
  busy,
  testing,
  test,
  cardMessage,
  credential,
  modelPicker,
  onCredentialChange,
  onStartEdit,
  onCancelEdit,
  onChangeEditValues,
  onSubmitEdit,
  onSetDefault,
  onRemove,
  onTest,
  onSubmitCredential,
}: BackendCardProps) {
  const type = backendTypeOf(backend.type);
  const kind: PresetKind =
    type === null ? 'agent-manual' : presetKindOfBackendType(type);
  return (
    <section
      className="card lift"
      data-testid={`backend-card-${backend.name}`}
      style={{ marginBottom: 12 }}
    >
      <div className="bk-head">
        <span style={{ display: 'inline-flex', color: 'var(--muted)' }}>
          <BackendIcon kind={backendIconKind(backend.type)} size={15} />
        </span>
        <span className="nm">{backend.name}</span>
        {isDefault && <span className="badge def">default</span>}
        <span className={classNames('ready', readinessClass(backend))}>
          {statusLabel(backend)}
        </span>
        {backend.model !== null && (
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
            {backend.model}
          </span>
        )}
      </div>

      <dl className="kv" style={{ marginTop: 14 }}>
        <dt>type</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {backend.type}
        </dd>
        {backend.baseUrl !== null && (
          <>
            <dt>base_url</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {backend.baseUrl}
            </dd>
          </>
        )}
        {backend.command !== null && (
          <>
            <dt>command</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {commandText(backend)}
            </dd>
          </>
        )}
        {backend.model !== null && (
          <>
            <dt>model</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {backend.model}
            </dd>
          </>
        )}
        {backend.apiKeyEnv !== null && (
          <>
            <dt>key source</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {backend.apiKeyEnv}
            </dd>
          </>
        )}
        {backend.timeoutMs !== null && (
          <>
            <dt>timeout</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              {`${String(backend.timeoutMs)} ms`}
            </dd>
          </>
        )}
        {backend.credentialReady && (
          <>
            <dt>credential</dt>
            <dd className="mono" style={{ fontSize: 12 }}>
              key held for session
            </dd>
          </>
        )}
      </dl>

      {!editing && (
        <div className="bk-actions">
          <button
            className="btn sm"
            type="button"
            data-testid={`backend-edit-${backend.name}`}
            disabled={busy}
            onClick={onStartEdit}
          >
            Edit
          </button>
          <button
            className="btn sm"
            type="button"
            data-testid={`backend-test-${backend.name}`}
            disabled={testing}
            onClick={onTest}
          >
            {testing && <span className="spin" aria-hidden="true" />}
            {testing ? 'Testing…' : 'Test turn'}
          </button>
          {!isDefault && (
            <button
              className="btn ghost sm"
              type="button"
              data-testid={`backend-default-${backend.name}`}
              disabled={busy}
              onClick={onSetDefault}
            >
              Set as default
            </button>
          )}
          <button
            className="btn ghost sm danger"
            type="button"
            data-testid={`backend-remove-${backend.name}`}
            disabled={busy || isDefault}
            onClick={onRemove}
          >
            Remove
          </button>
        </div>
      )}

      {editing && (
        <form
          style={{ marginTop: 14 }}
          onSubmit={onSubmitEdit}
          data-testid={`backend-edit-form-${backend.name}`}
        >
          <div className="grid2">
            <BackendFields
              kind={kind}
              values={editValues}
              errors={editErrors}
              onChange={onChangeEditValues}
              models={modelPicker}
            />
          </div>
          {editMessage !== null && (
            <p className="fnote" style={{ color: 'var(--danger)' }}>
              {editMessage}
            </p>
          )}
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              marginTop: 12,
            }}
          >
            <button className="btn primary sm" type="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save backend'}
            </button>
            <button
              className="btn ghost sm"
              type="button"
              disabled={busy}
              onClick={onCancelEdit}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {!editing && (
        <>
          <form
            style={{ display: 'flex', gap: 8, marginTop: 14, maxWidth: 460 }}
            onSubmit={onSubmitCredential}
          >
            <input
              className="input"
              type="password"
              value={credential}
              placeholder="Paste API key, memory only, never written"
              aria-label={`API key for ${backend.name}`}
              disabled={busy}
              onChange={(event) => {
                onCredentialChange(event.currentTarget.value);
              }}
            />
            <button
              className="btn sm"
              type="submit"
              data-testid={`backend-credential-${backend.name}`}
              disabled={busy || credential.trim() === ''}
            >
              Hold
            </button>
          </form>
          <p className="fnote" style={{ marginTop: 8 }}>
            Session only: this key stays in server memory for the current
            session and is never written to disk, transcripts, or logs.
          </p>
        </>
      )}

      {test !== undefined && (
        <p
          className="note"
          data-testid={`backend-test-result-${backend.name}`}
          style={{
            marginTop: 12,
            borderLeftColor: test.ok ? 'var(--ok)' : 'var(--danger)',
          }}
        >
          <b>{test.ok ? 'Reachable' : 'Failed'}</b>
          {test.status !== '' ? ` · ${test.status}` : ''}
          {test.diagnostics.length > 0 && (
            <span>{` · ${test.diagnostics.map((entry) => entry.message).join(' ')}`}</span>
          )}
        </p>
      )}

      {cardMessage !== null && (
        <p
          className="note"
          data-testid={`backend-error-${backend.name}`}
          style={{ marginTop: 12, borderLeftColor: 'var(--danger)' }}
        >
          {cardMessage}
        </p>
      )}
    </section>
  );
}

export function SettingsPage() {
  const api = useSettingsPage();
  const snapshot = api.snapshot;
  const backends = snapshot?.backends ?? [];
  const defaultName = snapshot?.default ?? null;

  const [presetKind, setPresetKind] = useState<PresetKind>('openai');
  const [addName, setAddName] = useState('');
  const [addValues, setAddValues] =
    useState<BackendFormValues>(EMPTY_FORM_VALUES);
  const [addMessage, setAddMessage] = useState<string | null>(null);
  const [addErrors, setAddErrors] = useState<SettingsFormErrors | null>(null);

  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValues, setEditValues] =
    useState<BackendFormValues>(EMPTY_FORM_VALUES);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [editErrors, setEditErrors] = useState<SettingsFormErrors | null>(null);
  // The edit form takes its kind from the backend being edited, so the model
  // picker probes the right harness.
  const editingType = backendTypeOf(
    backends.find((backend) => backend.name === editingName)?.type ?? '',
  );
  const editKind: PresetKind =
    editingType === null ? 'openai' : presetKindOfBackendType(editingType);
  const addModelPicker = useModelPicker(
    api.loadAgentModels,
    presetKind,
    addValues.command,
    addValues.args,
  );
  const editModelPicker = useModelPicker(
    api.loadAgentModels,
    editKind,
    editValues.command,
    editValues.args,
  );

  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [cardMessages, setCardMessages] = useState<Record<string, string>>({});

  const setCardMessage = (name: string, message: string | null) => {
    setCardMessages((previous) => {
      if (message === null) {
        const next = { ...previous };
        delete next[name];
        return next;
      }
      return { ...previous, [name]: message };
    });
  };

  const choosePreset = (kind: PresetKind) => {
    setPresetKind(kind);
    setAddValues(presetDefaults(kind));
    setAddMessage(null);
    setAddErrors(null);
  };

  const submitAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAddMessage(null);
    setAddErrors(null);
    const result = await api.addBackend({
      name: addName,
      kind: presetKind,
      values: addValues,
    });
    if (result.ok) {
      setAddName('');
      setAddValues(presetDefaults(presetKind));
      return;
    }
    setAddMessage(result.message);
    if (result.failure !== null) {
      setAddErrors(
        settingsFormErrorsOf(result.failure.diagnostics, addName, [
          'name',
          ...formFieldKeysOf(presetKind),
        ]),
      );
    }
  };

  const startEdit = (backend: SettingsBackend) => {
    setEditingName(backend.name);
    setEditValues(formValuesOfBackend(backend));
    setEditMessage(null);
    setEditErrors(null);
  };

  const cancelEdit = () => {
    setEditingName(null);
    setEditMessage(null);
    setEditErrors(null);
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const backend = backends.find((entry) => entry.name === editingName);
    if (backend === undefined) return;
    const type = backendTypeOf(backend.type);
    if (type === null) {
      setEditMessage('This backend type cannot be edited here.');
      return;
    }
    setEditMessage(null);
    setEditErrors(null);
    const result = await api.updateBackend({
      name: backend.name,
      type,
      values: editValues,
    });
    if (result.ok) {
      cancelEdit();
      return;
    }
    setEditMessage(result.message);
    if (result.failure !== null) {
      setEditErrors(
        settingsFormErrorsOf(
          result.failure.diagnostics,
          backend.name,
          formFieldKeysOf(presetKindOfBackendType(type)),
        ),
      );
    }
  };

  const removeBackend = async (backend: SettingsBackend) => {
    const result = await api.removeBackend(backend.name);
    if (!result.ok) {
      setCardMessage(
        backend.name,
        result.message ?? 'The backend could not be removed.',
      );
      return;
    }
    setCardMessage(backend.name, null);
  };

  const setDefault = async (backend: SettingsBackend) => {
    const result = await api.setDefault(backend.name);
    if (!result.ok) {
      setCardMessage(
        backend.name,
        result.message ?? 'The default backend could not be changed.',
      );
      return;
    }
    setCardMessage(backend.name, null);
  };

  const submitCredential = async (
    event: FormEvent<HTMLFormElement>,
    backend: SettingsBackend,
  ) => {
    event.preventDefault();
    const key = credentials[backend.name] ?? '';
    const result = await api.setCredential(backend.name, key);
    if (!result.ok) {
      setCardMessage(
        backend.name,
        result.message ?? 'The credential could not be stored.',
      );
      return;
    }
    setCredentials((previous) => ({ ...previous, [backend.name]: '' }));
    setCardMessage(backend.name, null);
  };

  const list = (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Backends</span>
          <span className="f">{`${String(backends.length)} configured`}</span>
        </div>
      </div>
      <div className="rows rise">
        {backends.map((backend) => {
          const isDefault = backend.isDefault || defaultName === backend.name;
          return (
            <div className="row" key={backend.name}>
              <p className="rt">{backend.name}</p>
              <p className="rd">
                <span className={classNames('ready', readinessClass(backend))}>
                  {statusLabel(backend)}
                </span>
              </p>
              <p className="rp">
                {backend.model === null
                  ? backend.type
                  : `${backend.type} · ${backend.model}`}
              </p>
              <p className="tags">
                {isDefault && <span className="tag acc">default</span>}
              </p>
            </div>
          );
        })}
        <a className="row" href="#add-backend">
          <p className="rt" style={{ color: 'var(--faint)', fontWeight: 500 }}>
            + Add a backend
          </p>
          <p className="rp">openai-compatible · opencode · ACP harness</p>
        </a>
      </div>
      <div className="lfoot">
        <span>stored in workspace.yml</span>
      </div>
    </>
  );

  return (
    <AppShell breadcrumb={[]} title="Settings" parentPath="/" list={list}>
      <div className="sheet wide">
        <div className="chead rise">
          <p className="kick">
            Settings <span className="chip">workspace.yml · backends</span>
          </p>
          <h1>Chat backends</h1>
          <p className="sub">
            The browser and the CLI drive the same backends. Pasted credentials
            live in server memory for this session only. They never reach disk,
            transcripts, or logs.
          </p>
        </div>

        {api.notice !== null && (
          <div
            className="note"
            data-testid="settings-error"
            style={{ marginBottom: 16, borderLeftColor: 'var(--warn)' }}
          >
            {api.notice}{' '}
            <button
              className="link"
              type="button"
              style={{
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                font: 'inherit',
              }}
              onClick={api.clearNotice}
            >
              Dismiss
            </button>
          </div>
        )}

        {api.status === 'loading' && (
          <PagePlaceholder
            glyph="◌"
            heading="Loading backends…"
            body="Reading workspace.yml and resolving each configured backend."
          />
        )}

        {api.status === 'error' && (
          <div data-testid="settings-error">
            <PagePlaceholder
              glyph="◌"
              heading="Backends unavailable"
              body={
                api.loadFailure?.message ??
                'The backend settings could not be loaded.'
              }
              actions={
                <button
                  className="btn primary sm"
                  type="button"
                  data-testid="settings-retry"
                  onClick={api.retry}
                >
                  Retry
                </button>
              }
            />
          </div>
        )}

        {api.status === 'ready' && (
          <div className="rise" data-testid="settings-backends">
            {backends.length === 0 && (
              <div className="empty" style={{ padding: '40px 0' }}>
                <p className="glyph">◌</p>
                <h2>No chat backends yet</h2>
                <p>
                  Add a backend below. Every field maps to workspace.yml, and
                  writes carry a hash precondition so the CLI and the browser
                  never clobber each other.
                </p>
              </div>
            )}

            {backends.map((backend) => (
              <BackendCard
                key={backend.name}
                backend={backend}
                isDefault={backend.isDefault || defaultName === backend.name}
                editing={editingName === backend.name}
                editValues={editValues}
                editMessage={editMessage}
                editErrors={editErrors}
                busy={api.busyName === backend.name}
                testing={api.testingName === backend.name}
                test={api.tests[backend.name]}
                cardMessage={cardMessages[backend.name] ?? null}
                credential={credentials[backend.name] ?? ''}
                modelPicker={
                  backendTypeOf(backend.type) === 'agent' ||
                  backendTypeOf(backend.type) === 'opencode'
                    ? editModelPicker
                    : undefined
                }
                onCredentialChange={(value) => {
                  setCredentials((previous) => ({
                    ...previous,
                    [backend.name]: value,
                  }));
                }}
                onStartEdit={() => {
                  startEdit(backend);
                }}
                onCancelEdit={cancelEdit}
                onChangeEditValues={setEditValues}
                onSubmitEdit={(event) => {
                  void submitEdit(event);
                }}
                onSetDefault={() => {
                  void setDefault(backend);
                }}
                onRemove={() => {
                  void removeBackend(backend);
                }}
                onTest={() => {
                  void api.testBackend(backend.name);
                }}
                onSubmitCredential={(event) => {
                  void submitCredential(event, backend);
                }}
              />
            ))}

            <section
              className="card"
              id="add-backend"
              style={{ borderStyle: 'dashed' }}
              data-testid="backend-add-form"
            >
              <p className="ct">Add a backend</p>
              <p className="cs">
                Presets fill the form for each backend type; every field maps to{' '}
                <span className="mono" style={{ fontSize: 11.5 }}>
                  workspace.yml
                </span>
                .
              </p>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  marginTop: 12,
                  flexWrap: 'wrap',
                }}
              >
                {PRESET_KINDS.map((kind) => (
                  <button
                    key={kind}
                    className={
                      presetKind === kind ? 'btn primary sm' : 'btn sm'
                    }
                    type="button"
                    data-testid={`backend-preset-${kind}`}
                    onClick={() => {
                      choosePreset(kind);
                    }}
                  >
                    {PRESET_LABELS[kind]}
                  </button>
                ))}
              </div>
              <form onSubmit={(event) => void submitAdd(event)}>
                <div className="grid2" style={{ marginTop: 18 }}>
                  <FormField label="Name" error={addErrors?.fields['name']}>
                    <input
                      className="input"
                      value={addName}
                      placeholder="research-model-2"
                      onChange={(event) => {
                        setAddName(event.currentTarget.value);
                      }}
                    />
                  </FormField>
                  <FormField label="Type">
                    <input
                      className="input mono"
                      value={presetTypeOf(presetKind)}
                      readOnly
                    />
                  </FormField>
                  <BackendFields
                    kind={presetKind}
                    values={addValues}
                    errors={addErrors}
                    onChange={setAddValues}
                    models={
                      presetTypeOf(presetKind) === 'agent'
                        ? addModelPicker
                        : undefined
                    }
                  />
                </div>
                {addMessage !== null && (
                  <p
                    className="fnote"
                    style={{ color: 'var(--danger)' }}
                    data-testid="backend-add-error"
                  >
                    {addMessage}
                  </p>
                )}
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    marginTop: 18,
                  }}
                >
                  <button
                    className="btn primary sm"
                    type="submit"
                    disabled={api.busyName === addBusyName}
                  >
                    {api.busyName === addBusyName ? 'Adding…' : 'Add backend'}
                  </button>
                  <span className="fnote">
                    writes{' '}
                    <span className="mono" style={{ fontSize: 11 }}>
                      workspace.yml
                    </span>{' '}
                    with hash preconditions
                  </span>
                </div>
              </form>
            </section>
          </div>
        )}
      </div>
    </AppShell>
  );
}
