import { describe, expect, it } from 'vitest';

import type { DiagnosticView } from '../../web/src/shared/types.js';
import {
  EMPTY_FORM_VALUES,
  PRESET_KINDS,
  buildAddPayload,
  buildBackendNamePayload,
  buildCredentialPayload,
  buildUpdatePayload,
  checkBaseUrl,
  classifySettingsFailure,
  formFieldKeysOf,
  formValuesOfBackend,
  modelProbeOf,
  parseArgsInput,
  parseTimeoutMs,
  presetDefaults,
  presetKindOfBackendType,
  presetTypeOf,
  settingsFormErrorsOf,
  toAgentModels,
  toSettingsBackends,
  toTestResult,
  type SettingsBackend,
} from '../../web/src/settings/model.js';

const hash = 'ab'.repeat(32);

function diagnosticOf(
  fieldPath: string | null,
  message = 'Something is wrong.',
): DiagnosticView {
  return {
    code: 'backend.schema',
    severity: 'error',
    file: 'workspace.yml',
    fieldPath,
    message,
    line: null,
    column: null,
  };
}

function backendOf(overrides: Partial<SettingsBackend>): SettingsBackend {
  return {
    name: 'research-model',
    type: 'openai',
    model: null,
    isDefault: false,
    status: '',
    credentialReady: false,
    apiKeyEnv: null,
    baseUrl: null,
    command: null,
    args: null,
    timeoutMs: null,
    ...overrides,
  };
}

describe('toSettingsBackends', () => {
  it('normalizes the GET response into the local snapshot shape', () => {
    const snapshot = toSettingsBackends({
      backends: [
        {
          name: 'research-model',
          type: 'openai',
          model: 'gpt-5.6',
          isDefault: true,
          status: 'api key env OPENAI_API_KEY is set',
          credentialReady: true,
          apiKeyEnv: 'OPENAI_API_KEY',
          baseUrl: 'https://api.openai.com/v1',
          command: null,
          args: null,
          timeoutMs: 120000,
        },
        {
          name: 'opencode-acp',
          type: 'agent',
          model: null,
          isDefault: false,
          status: "command 'opencode' resolves on PATH",
          credentialReady: false,
          apiKeyEnv: null,
          baseUrl: null,
          command: 'opencode',
          args: ['acp'],
          timeoutMs: null,
        },
      ],
      default: 'research-model',
      workspaceHash: hash,
      diagnostics: [],
    });
    expect(snapshot).toEqual({
      backends: [
        {
          name: 'research-model',
          type: 'openai',
          model: 'gpt-5.6',
          isDefault: true,
          status: 'api key env OPENAI_API_KEY is set',
          credentialReady: true,
          apiKeyEnv: 'OPENAI_API_KEY',
          baseUrl: 'https://api.openai.com/v1',
          command: null,
          args: null,
          timeoutMs: 120000,
        },
        {
          name: 'opencode-acp',
          type: 'agent',
          model: null,
          isDefault: false,
          status: "command 'opencode' resolves on PATH",
          credentialReady: false,
          apiKeyEnv: null,
          baseUrl: null,
          command: 'opencode',
          args: ['acp'],
          timeoutMs: null,
        },
      ],
      default: 'research-model',
      workspaceHash: hash,
      diagnostics: [],
    });
  });

  it('keeps null conversions for missing fields', () => {
    const snapshot = toSettingsBackends({
      backends: [{ name: 'partial', type: 'agent' }],
    });
    expect(snapshot.backends).toEqual([
      {
        name: 'partial',
        type: 'agent',
        model: null,
        isDefault: false,
        status: '',
        credentialReady: false,
        apiKeyEnv: null,
        baseUrl: null,
        command: null,
        args: null,
        timeoutMs: null,
      },
    ]);
    expect(snapshot.default).toBeNull();
    expect(snapshot.workspaceHash).toBeNull();
    expect(snapshot.diagnostics).toEqual([]);
  });

  it('drops entries without a name and tolerates malformed bodies', () => {
    expect(
      toSettingsBackends({ backends: [{ type: 'openai' }, 'nope', null] })
        .backends,
    ).toEqual([]);
    expect(toSettingsBackends({ backends: 'nope' }).backends).toEqual([]);
    expect(toSettingsBackends(null)).toEqual({
      backends: [],
      default: null,
      workspaceHash: null,
      diagnostics: [],
    });
  });

  it('parses diagnostics from the response body', () => {
    const snapshot = toSettingsBackends({
      backends: [],
      diagnostics: [
        {
          code: 'backend.unconfigured',
          severity: 'error',
          file: 'workspace.yml',
          fieldPath: 'backends.default',
          message: 'Default backend is not defined.',
          line: null,
          column: null,
        },
      ],
    });
    expect(snapshot.diagnostics).toHaveLength(1);
    expect(snapshot.diagnostics[0]?.code).toBe('backend.unconfigured');
    expect(snapshot.diagnostics[0]?.fieldPath).toBe('backends.default');
  });
});

describe('presetDefaults', () => {
  it('returns empty values for the manual openai preset', () => {
    expect(presetDefaults('openai')).toEqual(EMPTY_FORM_VALUES);
  });

  it('prefills the opencode command', () => {
    expect(presetDefaults('opencode')).toEqual({
      model: '',
      baseUrl: '',
      apiKeyEnv: '',
      command: 'opencode',
      args: '',
      timeoutMs: '',
    });
  });

  it('prefills the OpenCode ACP agent preset with command and args', () => {
    expect(presetDefaults('agent-opencode')).toEqual({
      model: '',
      baseUrl: '',
      apiKeyEnv: '',
      command: 'opencode',
      args: 'acp',
      timeoutMs: '',
    });
  });

  it('prefills the Codex ACP agent preset without args', () => {
    expect(presetDefaults('agent-codex')).toEqual({
      model: '',
      baseUrl: '',
      apiKeyEnv: '',
      command: 'codex-acp',
      args: '',
      timeoutMs: '',
    });
  });

  it('leaves the manual agent preset free-form', () => {
    expect(presetDefaults('agent-manual')).toEqual(EMPTY_FORM_VALUES);
  });

  it('exposes every preset kind', () => {
    expect(PRESET_KINDS).toEqual([
      'openai',
      'opencode',
      'agent-opencode',
      'agent-codex',
      'agent-manual',
    ]);
  });
});

describe('presetTypeOf and presetKindOfBackendType', () => {
  it('maps presets to wire backend types', () => {
    expect(presetTypeOf('openai')).toBe('openai');
    expect(presetTypeOf('opencode')).toBe('opencode');
    expect(presetTypeOf('agent-opencode')).toBe('agent');
    expect(presetTypeOf('agent-codex')).toBe('agent');
    expect(presetTypeOf('agent-manual')).toBe('agent');
  });

  it('maps wire backend types back to edit presets', () => {
    expect(presetKindOfBackendType('openai')).toBe('openai');
    expect(presetKindOfBackendType('opencode')).toBe('opencode');
    expect(presetKindOfBackendType('agent')).toBe('agent-manual');
  });
});

describe('buildAddPayload', () => {
  it('builds a minimal openai payload from the required model', () => {
    const built = buildAddPayload(
      {
        name: 'research-model',
        kind: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'gpt-5.6' },
      },
      hash,
    );
    expect(built).toEqual({
      ok: true,
      payload: {
        name: 'research-model',
        type: 'openai',
        config: { model: 'gpt-5.6' },
        expectedHash: hash,
      },
    });
  });

  it('builds a full openai payload with the optional fields', () => {
    const built = buildAddPayload(
      {
        name: 'research-model',
        kind: 'openai',
        values: {
          model: 'gpt-5.6',
          baseUrl: 'http://localhost:1234/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
          command: '',
          args: '',
          timeoutMs: '30000',
        },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({
        model: 'gpt-5.6',
        base_url: 'http://localhost:1234/v1',
        api_key_env: 'OPENAI_API_KEY',
        timeout_ms: 30000,
      });
    }
  });

  it('rejects an openai backend without a model', () => {
    const built = buildAddPayload(
      { name: 'research-model', kind: 'openai', values: EMPTY_FORM_VALUES },
      hash,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toContain('model');
  });

  it('rejects an invalid base URL before writing invalid config', () => {
    const built = buildAddPayload(
      {
        name: 'research-model',
        kind: 'openai',
        values: {
          ...EMPTY_FORM_VALUES,
          model: 'gpt-5.6',
          baseUrl: 'not-a-url',
        },
      },
      hash,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toContain('base URL');
  });

  it('builds a minimal opencode payload without args', () => {
    const built = buildAddPayload(
      {
        name: 'local-agent',
        kind: 'opencode',
        values: presetDefaults('opencode'),
      },
      hash,
    );
    expect(built).toEqual({
      ok: true,
      payload: {
        name: 'local-agent',
        type: 'opencode',
        config: { command: 'opencode' },
        expectedHash: hash,
      },
    });
  });

  it('pins the OpenCode ACP preset args to acp', () => {
    const built = buildAddPayload(
      {
        name: 'opencode-acp',
        kind: 'agent-opencode',
        values: {
          ...presetDefaults('agent-opencode'),
          args: 'ignored',
          model: 'anthropic/claude-sonnet-4-5',
        },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({
        command: 'opencode',
        args: ['acp'],
        model: 'anthropic/claude-sonnet-4-5',
      });
      expect(built.payload.type).toBe('agent');
    }
  });

  it('omits args for the Codex ACP preset', () => {
    const built = buildAddPayload(
      {
        name: 'codex',
        kind: 'agent-codex',
        values: presetDefaults('agent-codex'),
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({ command: 'codex-acp' });
    }
  });

  it('splits manual agent args on commas and newlines', () => {
    const built = buildAddPayload(
      {
        name: 'custom-agent',
        kind: 'agent-manual',
        values: {
          ...EMPTY_FORM_VALUES,
          command: 'my-agent',
          args: 'serve --port 9000, --flag\nother',
          timeoutMs: '60000',
        },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({
        command: 'my-agent',
        args: ['serve --port 9000', '--flag', 'other'],
        timeout_ms: 60000,
      });
    }
  });

  it('omits empty manual agent args', () => {
    const built = buildAddPayload(
      {
        name: 'custom-agent',
        kind: 'agent-manual',
        values: { ...EMPTY_FORM_VALUES, command: 'my-agent' },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.payload.config).toEqual({ command: 'my-agent' });
  });

  it('accepts free-form names and trims surrounding whitespace', () => {
    const upper = buildAddPayload(
      {
        name: '  Research Model  ',
        kind: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'gpt-5.6' },
      },
      hash,
    );
    expect(upper.ok).toBe(true);
    if (upper.ok) expect(upper.payload.name).toBe('Research Model');

    const unicode = buildAddPayload(
      {
        name: '채팅용 모델',
        kind: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'qwen3' },
      },
      hash,
    );
    expect(unicode.ok).toBe(true);
  });

  it('rejects empty, over-long, and control-character names', () => {
    const empty = buildAddPayload(
      { name: '   ', kind: 'openai', values: EMPTY_FORM_VALUES },
      hash,
    );
    expect(empty.ok).toBe(false);

    const tooLong = buildAddPayload(
      { name: 'a'.repeat(101), kind: 'openai', values: EMPTY_FORM_VALUES },
      hash,
    );
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.message).toContain('must be at most 100 characters');
    }

    const control = buildAddPayload(
      {
        name: `bad${String.fromCharCode(7)}name`,
        kind: 'openai',
        values: EMPTY_FORM_VALUES,
      },
      hash,
    );
    expect(control.ok).toBe(false);
    if (!control.ok) {
      expect(control.message).toContain('control characters');
    }
  });

  it('refuses to send without a workspace hash', () => {
    const built = buildAddPayload(
      {
        name: 'research-model',
        kind: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'gpt-5.6' },
      },
      null,
    );
    expect(built.ok).toBe(false);
  });
});

describe('buildUpdatePayload', () => {
  it('builds an openai update from the form values', () => {
    const built = buildUpdatePayload(
      {
        name: 'research-model',
        type: 'openai',
        values: {
          model: 'gpt-5.6',
          baseUrl: 'https://api.openai.com/v1',
          apiKeyEnv: 'OPENAI_API_KEY',
          command: '',
          args: '',
          timeoutMs: '45000',
        },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload).toEqual({
        name: 'research-model',
        config: {
          model: 'gpt-5.6',
          base_url: 'https://api.openai.com/v1',
          api_key_env: 'OPENAI_API_KEY',
          timeout_ms: 45000,
        },
        expectedHash: hash,
      });
    }
  });

  it('sends null to remove cleared openai optional fields', () => {
    const built = buildUpdatePayload(
      {
        name: 'research-model',
        type: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'gpt-5.6' },
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({
        model: 'gpt-5.6',
        base_url: null,
        api_key_env: null,
        timeout_ms: null,
      });
    }
  });

  it('builds an opencode update and clears an empty model', () => {
    const built = buildUpdatePayload(
      {
        name: 'local-agent',
        type: 'opencode',
        values: presetDefaults('opencode'),
      },
      hash,
    );
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.payload.config).toEqual({
        command: 'opencode',
        model: null,
      });
    }
  });

  it('builds a manual agent update with parsed args or null removal', () => {
    const withArgs = buildUpdatePayload(
      {
        name: 'custom-agent',
        type: 'agent',
        values: { ...EMPTY_FORM_VALUES, command: 'my-agent', args: 'acp' },
      },
      hash,
    );
    expect(withArgs.ok).toBe(true);
    if (withArgs.ok) {
      expect(withArgs.payload.config).toEqual({
        command: 'my-agent',
        model: null,
        args: ['acp'],
        timeout_ms: null,
      });
    }
    const withoutArgs = buildUpdatePayload(
      {
        name: 'custom-agent',
        type: 'agent',
        values: {
          ...EMPTY_FORM_VALUES,
          command: 'my-agent',
          timeoutMs: '60000',
        },
      },
      hash,
    );
    expect(withoutArgs.ok).toBe(true);
    if (withoutArgs.ok) {
      expect(withoutArgs.payload.config).toEqual({
        command: 'my-agent',
        model: null,
        args: null,
        timeout_ms: 60000,
      });
    }
  });

  it('rejects an empty command for command-based backends', () => {
    const built = buildUpdatePayload(
      {
        name: 'custom-agent',
        type: 'agent',
        values: EMPTY_FORM_VALUES,
      },
      hash,
    );
    expect(built.ok).toBe(false);
  });

  it('refuses to send without a workspace hash', () => {
    const built = buildUpdatePayload(
      {
        name: 'research-model',
        type: 'openai',
        values: { ...EMPTY_FORM_VALUES, model: 'gpt-5.6' },
      },
      null,
    );
    expect(built.ok).toBe(false);
  });
});

describe('buildBackendNamePayload', () => {
  it('threads the expected hash for remove and default actions', () => {
    expect(buildBackendNamePayload('local-agent', hash)).toEqual({
      ok: true,
      payload: { name: 'local-agent', expectedHash: hash },
    });
    expect(buildBackendNamePayload('local-agent', null).ok).toBe(false);
  });
});

describe('buildCredentialPayload', () => {
  it('trims the key and name', () => {
    expect(buildCredentialPayload(' research-model ', '  key-value  ')).toEqual(
      {
        ok: true,
        payload: { name: 'research-model', apiKey: 'key-value' },
      },
    );
  });

  it('rejects empty and whitespace-only keys', () => {
    expect(buildCredentialPayload('research-model', '').ok).toBe(false);
    expect(buildCredentialPayload('research-model', '   ').ok).toBe(false);
  });

  it('rejects an empty backend name', () => {
    expect(buildCredentialPayload('', 'key').ok).toBe(false);
  });
});

describe('parseArgsInput', () => {
  it('splits on commas and newlines and drops empties', () => {
    expect(parseArgsInput('a, b\nc ,, d')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseArgsInput('')).toEqual([]);
    expect(parseArgsInput(' , ')).toEqual([]);
  });
});

describe('parseTimeoutMs', () => {
  it('accepts empty input as no timeout', () => {
    expect(parseTimeoutMs('')).toEqual({ ok: true, value: null });
    expect(parseTimeoutMs('  ')).toEqual({ ok: true, value: null });
  });

  it('accepts positive whole numbers', () => {
    expect(parseTimeoutMs(' 4000 ')).toEqual({ ok: true, value: 4000 });
    expect(parseTimeoutMs('120000')).toEqual({ ok: true, value: 120000 });
  });

  it('rejects zero, fractions, and non-numbers', () => {
    expect(parseTimeoutMs('0').ok).toBe(false);
    expect(parseTimeoutMs('12.5').ok).toBe(false);
    expect(parseTimeoutMs('abc').ok).toBe(false);
    expect(parseTimeoutMs('-5').ok).toBe(false);
  });
});

describe('checkBaseUrl', () => {
  it('accepts http and https URLs', () => {
    expect(checkBaseUrl('https://api.openai.com/v1').ok).toBe(true);
    expect(checkBaseUrl('http://localhost:1234/v1').ok).toBe(true);
  });

  it('rejects other schemes and unparseable text', () => {
    expect(checkBaseUrl('ftp://example.com').ok).toBe(false);
    expect(checkBaseUrl('not-a-url').ok).toBe(false);
  });
});

describe('classifySettingsFailure', () => {
  const diagnostics = [diagnosticOf('name', 'The name is taken.')];

  it('classifies 409 as a conflict with reload wording', () => {
    const failure = classifySettingsFailure('save', 409, diagnostics, hash);
    expect(failure.conflict).toBe(true);
    expect(failure.message).toBe(
      'The settings changed since they were loaded. Reload before continuing.',
    );
    expect(failure.diagnostics).toBe(diagnostics);
    expect(failure.currentHash).toBe(hash);
  });

  it('classifies 422 as a validation failure per kind', () => {
    expect(
      classifySettingsFailure('save', 422, diagnostics, null).message,
    ).toBe('The backend settings could not be saved.');
    expect(
      classifySettingsFailure('remove', 422, diagnostics, null).message,
    ).toBe('The backend could not be removed.');
    expect(
      classifySettingsFailure('default', 422, diagnostics, null).message,
    ).toBe('The default backend could not be changed.');
    expect(
      classifySettingsFailure('credential', 422, diagnostics, null).message,
    ).toBe('The credential could not be stored.');
  });

  it('classifies the test kind with its own wording', () => {
    expect(classifySettingsFailure('test', 500, [], null).message).toBe(
      'The backend could not be reached for testing.',
    );
    expect(classifySettingsFailure('list', 404, [], null).message).toBe(
      'The backend settings could not be loaded.',
    );
  });

  it('classifies transport failures as network errors', () => {
    const failure = classifySettingsFailure('list', 0, [], null);
    expect(failure.conflict).toBe(false);
    expect(failure.message).toBe('The request could not reach the server.');
  });
});

describe('settingsFormErrorsOf', () => {
  it('maps entry-scoped field paths to form fields', () => {
    const errors = settingsFormErrorsOf(
      [
        diagnosticOf('backends.entries.my-agent.model', 'Model is required.'),
        diagnosticOf(
          'backends.entries.my-agent.command',
          'Command is required.',
        ),
        diagnosticOf('backends.entries.other.model', 'Other backend problem.'),
        diagnosticOf('name', 'The name is taken.'),
        diagnosticOf(null, 'Workspace problem.'),
      ],
      'my-agent',
      ['model', 'command'],
    );
    expect(errors.fields).toEqual({
      model: ['Model is required.'],
      command: ['Command is required.'],
    });
    expect(errors.unassigned.map((entry) => entry.message)).toEqual([
      'Other backend problem.',
      'The name is taken.',
      'Workspace problem.',
    ]);
  });

  it('maps bare name paths for the add form and drops them when unrendered', () => {
    const added = settingsFormErrorsOf(
      [diagnosticOf('name', 'The name is taken.')],
      'new-backend',
      ['name', 'model'],
    );
    expect(added.fields['name']).toEqual(['The name is taken.']);
    expect(added.unassigned).toEqual([]);
    const edited = settingsFormErrorsOf(
      [diagnosticOf('name', 'The name is taken.')],
      'new-backend',
      ['model'],
    );
    expect(edited.fields).toEqual({});
    expect(edited.unassigned).toHaveLength(1);
  });
});

describe('formFieldKeysOf', () => {
  it('lists the rendered config fields per preset kind', () => {
    expect(formFieldKeysOf('openai')).toEqual([
      'model',
      'base_url',
      'api_key_env',
      'timeout_ms',
    ]);
    expect(formFieldKeysOf('opencode')).toEqual(['command', 'model']);
    expect(formFieldKeysOf('agent-manual')).toEqual([
      'command',
      'args',
      'model',
      'timeout_ms',
    ]);
    expect(formFieldKeysOf('agent-codex')).toEqual(
      formFieldKeysOf('agent-manual'),
    );
  });
});

describe('formValuesOfBackend', () => {
  it('converts a backend entry into form values', () => {
    expect(
      formValuesOfBackend(
        backendOf({
          model: 'gpt-5.6',
          apiKeyEnv: 'OPENAI_API_KEY',
          baseUrl: 'https://api.openai.com/v1',
          timeoutMs: 120000,
        }),
      ),
    ).toEqual({
      model: 'gpt-5.6',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      command: '',
      args: '',
      timeoutMs: '120000',
    });
    expect(
      formValuesOfBackend(
        backendOf({ type: 'agent', command: 'opencode', args: ['acp', 'x'] }),
      ),
    ).toEqual({
      model: '',
      baseUrl: '',
      apiKeyEnv: '',
      command: 'opencode',
      args: 'acp, x',
      timeoutMs: '',
    });
  });
});

describe('toTestResult', () => {
  it('normalizes the test response', () => {
    expect(toTestResult({ ok: true, status: 'reachable' })).toEqual({
      ok: true,
      status: 'reachable',
    });
    expect(toTestResult({ ok: false, status: 'unreachable: refused' })).toEqual(
      {
        ok: false,
        status: 'unreachable: refused',
      },
    );
    expect(toTestResult({})).toEqual({ ok: false, status: '' });
    expect(toTestResult(null)).toEqual({ ok: false, status: '' });
  });
});

describe('modelProbeOf', () => {
  it('probes opencode through its acp subcommand, defaulting the command', () => {
    expect(modelProbeOf('opencode', '', '')).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
    expect(
      modelProbeOf('opencode', ' opencode-nightly ', '--flag, verbose'),
    ).toEqual({
      command: 'opencode-nightly',
      args: ['--flag', 'verbose', 'acp'],
    });
  });

  it('probes agent kinds with the configured command and args', () => {
    expect(modelProbeOf('agent-codex', 'codex-acp', '')).toEqual({
      command: 'codex-acp',
      args: [],
    });
    expect(modelProbeOf('agent-opencode', 'opencode', 'acp')).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
  });

  it('probes nothing without an agent command and for openai backends', () => {
    expect(modelProbeOf('agent-manual', '', 'acp')).toBeNull();
    expect(modelProbeOf('openai', 'gpt-5.6', '')).toBeNull();
  });
});

describe('toAgentModels', () => {
  it('parses the models payload and drops malformed entries', () => {
    expect(
      toAgentModels({
        models: [
          { id: 'gpt-6-astra[low]', name: '6 Astra (low)' },
          { id: 'gpt-6-astra[high]', description: 'Slower and deeper' },
          { id: '' },
          { name: 'missing id' },
          'junk',
        ],
      }),
    ).toEqual([
      { id: 'gpt-6-astra[low]', name: '6 Astra (low)', description: null },
      {
        id: 'gpt-6-astra[high]',
        name: null,
        description: 'Slower and deeper',
      },
    ]);
  });

  it('returns an empty list for unusable payloads', () => {
    expect(toAgentModels(null)).toEqual([]);
    expect(toAgentModels({})).toEqual([]);
    expect(toAgentModels({ models: 'nope' })).toEqual([]);
  });
});
