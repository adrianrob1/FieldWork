import { describe, expect, it } from 'vitest';

import {
  acpExchangeFromUpdates,
  buildAcpPrompt,
  listAcpModels,
  sendAcpExchange,
  type AcpSession,
  type AcpTransport,
} from '../../src/backends/acp.js';
import {
  findBackend,
  resolveBackends,
  type AgentBackendConfig,
} from '../../src/backends/config.js';
import type {
  BackendSendResult,
  NormalizedExchangeRequest,
} from '../../src/backends/types.js';

const agentConfig: AgentBackendConfig = {
  type: 'agent',
  name: 'acp-agent',
  command: 'fake-acp',
  args: [],
  model: undefined,
  timeoutMs: 5000,
};

type FakeMethodHandler = (params: unknown, session: FakeAcpSession) => unknown;

class FakeAcpSession implements AcpSession {
  readonly requests: { method: string; params: unknown }[] = [];
  readonly notifications: { method: string; params: unknown }[] = [];
  closed = false;
  private readonly handlers: Map<string, FakeMethodHandler>;
  private readonly hanging: Set<string>;
  private readonly pendingRejects: ((error: Error) => void)[] = [];
  private notificationHandler:
    ((method: string, params: unknown) => void) | null = null;

  constructor(
    handlers: Record<string, FakeMethodHandler>,
    hanging: string[] = [],
  ) {
    this.handlers = new Map(Object.entries(handlers));
    this.hanging = new Set(hanging);
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (this.hanging.has(method)) {
      await new Promise<never>((_resolve, reject) => {
        this.pendingRejects.push(reject);
      });
    }
    const handler = this.handlers.get(method);
    if (handler === undefined) return null;
    return handler(params, this);
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }

  setNotificationHandler(
    handler: (method: string, params: unknown) => void,
  ): void {
    this.notificationHandler = handler;
  }

  emit(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  close(): void {
    this.closed = true;
    for (const reject of this.pendingRejects.splice(0)) {
      reject(new Error('The ACP session closed before the exchange finished.'));
    }
  }
}

function fakeAcpTransport(
  handlers: Record<string, FakeMethodHandler>,
  hanging: string[] = [],
): { transport: AcpTransport; sessions: FakeAcpSession[] } {
  const sessions: FakeAcpSession[] = [];
  const transport: AcpTransport = {
    connect: () => {
      const session = new FakeAcpSession(handlers, hanging);
      sessions.push(session);
      return Promise.resolve(session);
    },
  };
  return { transport, sessions };
}

function emitUpdates(
  session: FakeAcpSession,
  sessionId: string,
  updates: Record<string, unknown>[],
): void {
  for (const update of updates) {
    session.emit('session/update', { sessionId, update });
  }
}

function standardHandlers(
  promptUpdates: Record<string, unknown>[],
  sessionId = 'ses_acp_1',
  extra: Record<string, FakeMethodHandler> = {},
): Record<string, FakeMethodHandler> {
  return {
    initialize: () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [],
    }),
    'session/new': () => ({ sessionId }),
    'session/prompt': (_params, session) => {
      emitUpdates(session, sessionId, promptUpdates);
      return { stopReason: 'end_turn' };
    },
    ...extra,
  };
}

describe('agent backend settings resolution', () => {
  it('resolves valid agent entries with defaults', () => {
    const resolution = resolveBackends('workspace.yml', {
      backends: {
        entries: {
          'acp-agent': { type: 'agent', command: 'opencode', args: ['acp'] },
          'codex-acp': {
            type: 'agent',
            command: 'codex-acp',
            model: 'gpt-5.6-codex',
            timeout_ms: 60000,
          },
        },
      },
    });

    expect(resolution.diagnostics).toEqual([]);
    expect(resolution.entries).toEqual([
      {
        type: 'agent',
        name: 'acp-agent',
        command: 'opencode',
        args: ['acp'],
        model: undefined,
        timeoutMs: 120000,
      },
      {
        type: 'agent',
        name: 'codex-acp',
        command: 'codex-acp',
        args: [],
        model: 'gpt-5.6-codex',
        timeoutMs: 60000,
      },
    ]);
    expect(findBackend(resolution, 'codex-acp').backend?.type).toBe('agent');
  });

  it('reports schema diagnostics for an invalid agent entry', () => {
    const resolution = resolveBackends('workspace.yml', {
      backends: {
        entries: {
          broken: { type: 'agent' },
        },
      },
    });

    expect(resolution.entries).toEqual([]);
    expect(resolution.diagnostics).toHaveLength(1);
    expect(resolution.diagnostics[0]?.code).toBe('backend.schema');
    expect(resolution.diagnostics[0]?.file).toBe('workspace.yml');
    expect(resolution.diagnostics[0]?.fieldPath).toContain('backends.entries');
  });
});

describe('buildAcpPrompt', () => {
  it('builds the prompt text with and without a resumed session', () => {
    const single: NormalizedExchangeRequest = {
      messages: [{ role: 'user', text: 'Hello.' }],
    };
    expect(buildAcpPrompt(single, false)).toBe('Hello.');
    expect(buildAcpPrompt(single, true)).toBe('Hello.');

    const history: NormalizedExchangeRequest = {
      messages: [
        { role: 'user', text: 'First.' },
        { role: 'assistant', text: 'Answer.' },
        { role: 'user', text: 'Second.' },
      ],
    };
    expect(buildAcpPrompt(history, true)).toBe('Second.');
    expect(buildAcpPrompt(history, false)).toBe(
      'user: First.\n\nassistant: Answer.\n\nuser: Second.',
    );
    expect(buildAcpPrompt({ messages: [] }, false)).toBeNull();
  });
});

describe('acpExchangeFromUpdates', () => {
  it('accumulates chunks in every notification shape the spec drafts use', () => {
    const contentForm = acpExchangeFromUpdates(
      [
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: 'Content ' },
          },
        },
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text: 'form.' },
          },
        },
      ],
      'ses_forms',
    );
    expect(contentForm.text).toBe('Content form.');

    const rawForm = acpExchangeFromUpdates(
      [
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            raw_content: 'Raw ',
          },
        },
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            raw_content: 'content form.',
          },
        },
      ],
      'ses_forms',
    );
    expect(rawForm.text).toBe('Raw content form.');

    const chunkForm = acpExchangeFromUpdates(
      [
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content_item_chunk: { type: 'text', text: 'Chunk ' },
          },
        },
        {
          sessionId: 'ses_forms',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content_item_chunk: { type: 'text', text: 'item form.' },
          },
        },
      ],
      'ses_forms',
    );
    expect(chunkForm.text).toBe('Chunk item form.');
  });

  it('joins distinct messages and ignores other update kinds', () => {
    const exchange = acpExchangeFromUpdates(
      [
        {
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            raw_content: 'First.',
          },
        },
        {
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Internal reasoning.' },
          },
        },
        {
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'User said.' },
          },
        },
        {
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm2',
            raw_content: 'Second.',
          },
        },
        { update: { sessionUpdate: 'plan', entries: [] } },
        { update: { sessionUpdate: 'usage_update', used: 5, size: 100 } },
        {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [],
          },
        },
        {
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: 'code',
          },
        },
        { notAnUpdate: true },
      ],
      'ses_forms',
    );

    expect(exchange.text).toBe('First.\n\nSecond.');
    expect(exchange.toolCalls).toEqual([]);
    expect(exchange.model).toBeNull();
    expect(exchange.provider).toBe('acp');
    expect(exchange.backendSession).toBe('ses_forms');
    expect(exchange.usage).toBeNull();
  });
});

describe('sendAcpExchange', () => {
  it('performs the handshake and normalizes a fresh session turn', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers([
        { sessionUpdate: 'plan', entries: [] },
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_1',
          content: { type: 'text', text: 'Fake reply.' },
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'call_read',
          title: 'Read the notes',
          kind: 'read',
          status: 'pending',
        },
        {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call_read',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'notes contents' },
            },
          ],
        },
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [],
        },
      ]),
    );

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    const session = sessions[0];
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(session.requests.map((entry) => entry.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);
    expect(session.notifications.map((entry) => entry.method)).toEqual([
      'notifications/initialized',
    ]);
    const initialize = session.requests[0]?.params as {
      protocolVersion: number;
      clientCapabilities: unknown;
      clientInfo: { name: string; version: string } | null;
    };
    expect(initialize.protocolVersion).toBe(1);
    expect(initialize.clientCapabilities).toEqual({
      fs: { readTextFile: false, writeTextFile: false },
    });
    expect(initialize.clientInfo?.name).toBe('fieldwork');
    expect(typeof initialize.clientInfo?.version).toBe('string');
    const created = session.requests[1]?.params as {
      cwd: string;
      mcpServers: unknown[];
    };
    expect(created.mcpServers).toEqual([]);
    const prompt = session.requests[2]?.params as {
      sessionId: string;
      prompt: { type: string; text: string }[];
    };
    expect(prompt.sessionId).toBe('ses_acp_1');
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'Hello.' }]);
    if (result.ok) {
      expect(result.exchange).toEqual({
        text: 'Fake reply.',
        toolCalls: [
          {
            id: 'call_read',
            name: 'Read the notes',
            arguments: {},
            result: 'notes contents',
          },
        ],
        model: null,
        provider: 'acp',
        backendSession: 'ses_acp_1',
        usage: null,
        thought: null,
      });
    }
    expect(session.closed).toBe(true);
  });

  it('resumes a recorded session and ignores the replayed history', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers(
        [
          {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_2',
            content: { type: 'text', text: 'Fresh reply.' },
          },
        ],
        'ses_prev',
        {
          'session/load': (_params, session) => {
            emitUpdates(session, 'ses_prev', [
              {
                sessionUpdate: 'agent_message_chunk',
                messageId: 'replay',
                content: {
                  type: 'text',
                  text: 'Replayed reply that must not leak.',
                },
              },
              {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Replayed user message.' },
              },
            ]);
            return null;
          },
        },
      ),
    );

    const result = await sendAcpExchange(
      agentConfig,
      {
        messages: [
          { role: 'user', text: 'First.' },
          { role: 'assistant', text: 'Answer.' },
          { role: 'user', text: 'Second.' },
        ],
      },
      transport,
      { session: 'ses_prev' },
    );

    expect(result.ok).toBe(true);
    const session = sessions[0];
    if (session === undefined) return;
    expect(session.requests.map((entry) => entry.method)).toEqual([
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    const loaded = session.requests[1]?.params as {
      sessionId: string;
      cwd: string;
      mcpServers: unknown[];
    };
    expect(loaded.sessionId).toBe('ses_prev');
    expect(loaded.mcpServers).toEqual([]);
    const prompt = session.requests[2]?.params as {
      sessionId: string;
      prompt: { type: string; text: string }[];
    };
    expect(prompt.prompt).toEqual([{ type: 'text', text: 'Second.' }]);
    if (result.ok) {
      expect(result.exchange.text).toBe('Fresh reply.');
      expect(result.exchange.backendSession).toBe('ses_prev');
    }
    expect(session.closed).toBe(true);
  });

  it('falls back to session/new with the full history when session/load fails', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers(
        [
          {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg_1',
            content: { type: 'text', text: 'Fresh reply.' },
          },
        ],
        'ses_new_1',
        {
          'session/load': () => {
            throw new Error(
              "The ACP request 'session/load' failed with code -32001: session not found",
            );
          },
        },
      ),
    );

    const result = await sendAcpExchange(
      agentConfig,
      {
        messages: [
          { role: 'user', text: 'First.' },
          { role: 'assistant', text: 'Answer.' },
          { role: 'user', text: 'Second.' },
        ],
      },
      transport,
      { session: 'ses_stale' },
    );

    expect(result.ok).toBe(true);
    const session = sessions[0];
    if (session === undefined) return;
    expect(session.requests.map((entry) => entry.method)).toEqual([
      'initialize',
      'session/load',
      'session/new',
      'session/prompt',
    ]);
    const prompt = session.requests[3]?.params as {
      sessionId: string;
      prompt: { type: string; text: string }[];
    };
    expect(prompt.prompt).toEqual([
      {
        type: 'text',
        text: 'user: First.\n\nassistant: Answer.\n\nuser: Second.',
      },
    ]);
    if (result.ok) {
      expect(result.exchange.backendSession).toBe('ses_new_1');
    }
    expect(session.closed).toBe(true);
  });

  it('normalizes OpenCode-style and Codex-style streams into the same exchange', async () => {
    const request: NormalizedExchangeRequest = {
      messages: [{ role: 'user', text: 'Probe the workspace.' }],
    };
    const opencodeStyleUpdates = [
      {
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Inspect the workspace',
            priority: 'high',
            status: 'pending',
          },
        ],
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_a',
        content: { type: 'text', text: 'Running the probe' },
      },
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_a',
        content: { type: 'text', text: ' and analyzing results.' },
      },
      {
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'thought_1',
        content: {
          type: 'text',
          text: 'Internal reasoning that must not surface.',
        },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_probe',
        title: 'Probe the index',
        kind: 'search',
        status: 'pending',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_probe',
        status: 'in_progress',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_probe',
        status: 'completed',
        content: [
          { type: 'content', content: { type: 'text', text: 'probe output' } },
        ],
      },
      { sessionUpdate: 'usage_update', used: 42, size: 2000 },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
    ];
    const codexStyleUpdates = [
      {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_b',
        content_item_chunk: {
          type: 'text',
          text: 'Running the probe and analyzing results.',
        },
      },
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_probe',
        title: 'Probe the index',
        kind: 'execute',
        status: 'in_progress',
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_probe',
        status: 'completed',
        rawOutput: 'probe output',
      },
    ];

    const opencodeResult = await sendAcpExchange(
      agentConfig,
      request,
      fakeAcpTransport(standardHandlers(opencodeStyleUpdates, 'ses_norm'))
        .transport,
    );
    const codexResult = await sendAcpExchange(
      agentConfig,
      request,
      fakeAcpTransport(standardHandlers(codexStyleUpdates, 'ses_norm'))
        .transport,
    );

    assertProviderNeutralExchange(
      opencodeResult,
      'Internal reasoning that must not surface.',
    );
    assertProviderNeutralExchange(codexResult, null);
  });

  it('rejects an empty turn with backend.empty_response', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers([
        { sessionUpdate: 'plan', entries: [] },
        { sessionUpdate: 'usage_update', used: 3, size: 100 },
      ]),
    );

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.empty_response',
      ]);
      expect(result.diagnostics[0]?.message).toContain('acp-agent');
    }
    expect(sessions[0]?.closed).toBe(true);
  });

  it('times out a hanging prompt turn and closes the session', async () => {
    const { transport, sessions } = fakeAcpTransport(standardHandlers([]), [
      'session/prompt',
    ]);

    const result = await sendAcpExchange(
      { ...agentConfig, timeoutMs: 25 },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
      expect(result.diagnostics[0]?.message).toContain('timed out after 25ms');
    }
    expect(sessions[0]?.closed).toBe(true);
  });

  it('reports connect failures without a session to close', async () => {
    const transport: AcpTransport = {
      connect: () => Promise.reject(new Error('spawn fake-acp ENOENT')),
    };

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
      expect(result.diagnostics[0]?.message).toContain(
        'Could not start command',
      );
      expect(result.diagnostics[0]?.message).toContain('ENOENT');
    }
  });

  it('reports a failed initialize handshake and closes the session', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers([], 'ses_acp_1', {
        initialize: () => {
          throw new Error(
            "The ACP request 'initialize' failed with code -32602: unsupported protocol version",
          );
        },
      }),
    );

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
      expect(result.diagnostics[0]?.message).toContain('initialize handshake');
      expect(result.diagnostics[0]?.message).toContain(
        'unsupported protocol version',
      );
    }
    expect(sessions[0]?.closed).toBe(true);
  });

  it('reports a failed prompt turn and closes the session', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers([], 'ses_acp_1', {
        'session/prompt': () => {
          throw new Error(
            "The ACP request 'session/prompt' failed with code -32000: harness exploded",
          );
        },
      }),
    );

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
      expect(result.diagnostics[0]?.message).toContain('prompt turn');
      expect(result.diagnostics[0]?.message).toContain('harness exploded');
    }
    expect(sessions[0]?.closed).toBe(true);
  });

  it('requires at least one message', async () => {
    const { transport } = fakeAcpTransport(standardHandlers([]));

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((entry) => entry.code)).toEqual([
        'backend.request_failed',
      ]);
      expect(result.diagnostics[0]?.message).toContain(
        'requires at least one message',
      );
    }
  });
});

describe('agent model selection', () => {
  const replyUpdates = [
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_model_1',
      content: { type: 'text', text: 'Model reply.' },
    },
  ];

  it('applies the configured model after creating a session', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers(replyUpdates, 'ses_model_1', {
        'session/set_model': () => ({}),
      }),
    );

    const result = await sendAcpExchange(
      { ...agentConfig, model: 'gpt-6-astra[high]' },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    const session = sessions[0];
    expect(session?.requests.map((entry) => entry.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_model',
      'session/prompt',
    ]);
    const setModel = session?.requests[2]?.params as {
      sessionId: string;
      modelId: string;
    };
    expect(setModel.sessionId).toBe('ses_model_1');
    expect(setModel.modelId).toBe('gpt-6-astra[high]');
  });

  it('applies the configured model to a resumed session', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers(replyUpdates, 'ses_model_1', {
        'session/load': () => ({}),
        'session/set_model': () => ({}),
      }),
    );

    const result = await sendAcpExchange(
      { ...agentConfig, model: 'gpt-6-astra[high]' },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
      { session: 'ses_model_1' },
    );

    expect(result.ok).toBe(true);
    const setModel = sessions[0]?.requests.find(
      (entry) => entry.method === 'session/set_model',
    );
    expect((setModel?.params as { sessionId: string }).sessionId).toBe(
      'ses_model_1',
    );
  });

  it('skips set_model entirely when no model is configured', async () => {
    const { transport, sessions } = fakeAcpTransport(
      standardHandlers(replyUpdates, 'ses_model_1'),
    );

    const result = await sendAcpExchange(
      agentConfig,
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    expect(
      sessions[0]?.requests.some(
        (entry) => entry.method === 'session/set_model',
      ),
    ).toBe(false);
  });

  it('tolerates a harness without the model extension', async () => {
    const { transport } = fakeAcpTransport(
      standardHandlers(replyUpdates, 'ses_model_1', {
        'session/set_model': () => {
          throw new Error(
            "The ACP request 'session/set_model' failed with code -32601: Method not found: session/set_model",
          );
        },
      }),
    );

    const result = await sendAcpExchange(
      { ...agentConfig, model: 'gpt-6-astra[high]' },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exchange.text).toBe('Model reply.');
    }
  });

  it('fails the turn when the harness rejects the model', async () => {
    const { transport } = fakeAcpTransport(
      standardHandlers(replyUpdates, 'ses_model_1', {
        'session/set_model': () => {
          throw new Error(
            "The ACP request 'session/set_model' failed with code -32602: Invalid model id",
          );
        },
      }),
    );

    const result = await sendAcpExchange(
      { ...agentConfig, model: 'not-a-model' },
      { messages: [{ role: 'user', text: 'Hello.' }] },
      transport,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics[0]?.code).toBe('backend.request_failed');
      expect(result.diagnostics[0]?.message).toContain(
        "Setting model 'not-a-model'",
      );
    }
  });
});

describe('listAcpModels', () => {
  it('lists the models a harness reports on session/new', async () => {
    const { transport } = fakeAcpTransport({
      initialize: () => ({ protocolVersion: 1 }),
      'session/new': () => ({
        sessionId: 'ses_models',
        models: {
          availableModels: [
            {
              modelId: 'gpt-6-astra[low]',
              name: '6 Astra (low)',
              description: 'Fast default',
            },
            { modelId: 'gpt-6-astra[high]' },
            { name: 'missing id' },
            'not-a-record',
          ],
        },
      }),
    });

    const result = await listAcpModels(agentConfig, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([
        {
          id: 'gpt-6-astra[low]',
          name: '6 Astra (low)',
          description: 'Fast default',
        },
        { id: 'gpt-6-astra[high]', name: null, description: null },
      ]);
    }
  });

  it('lists OpenCode models from the model config option', async () => {
    const { transport } = fakeAcpTransport({
      initialize: () => ({ protocolVersion: 1 }),
      'session/new': () => ({
        sessionId: 'ses_models',
        configOptions: [
          {
            id: 'model',
            currentValue: 'opencode/big-pickle',
            options: [
              { value: 'rikyu/glm-5.3', name: 'Rikyu/GLM 5.3' },
              { value: 'openai/gpt-5.6-luna', name: 'OpenAI/GPT-5.6 Luna' },
              { value: '' },
            ],
          },
          { id: 'approval', options: [{ value: 'auto' }] },
        ],
      }),
    });

    const result = await listAcpModels(agentConfig, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([
        { id: 'rikyu/glm-5.3', name: 'Rikyu/GLM 5.3', description: null },
        {
          id: 'openai/gpt-5.6-luna',
          name: 'OpenAI/GPT-5.6 Luna',
          description: null,
        },
      ]);
    }
  });

  it('returns an empty list when the harness reports no models', async () => {
    const { transport } = fakeAcpTransport({
      initialize: () => ({ protocolVersion: 1 }),
      'session/new': () => ({ sessionId: 'ses_models' }),
    });

    const result = await listAcpModels(agentConfig, transport);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual([]);
    }
  });

  it('reports a spawn failure as a message', async () => {
    const transport: AcpTransport = {
      connect: () => Promise.reject(new Error('spawn boom')),
    };

    const result = await listAcpModels(agentConfig, transport);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('spawn boom');
    }
  });
});

function assertProviderNeutralExchange(
  result: BackendSendResult,
  thought: string | null,
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.exchange).toEqual({
    text: 'Running the probe and analyzing results.',
    toolCalls: [
      {
        id: 'call_probe',
        name: 'Probe the index',
        arguments: {},
        result: 'probe output',
      },
    ],
    model: null,
    provider: 'acp',
    backendSession: 'ses_norm',
    usage: null,
    thought,
  });
}
