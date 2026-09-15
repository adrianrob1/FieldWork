import { childProcessAcpTransport, sendAcpExchange } from './acp.js';
import type { ResolvedBackendConfig } from './config.js';
import { sendOpenAiExchange } from './openai.js';
import {
  childProcessSpawnTransport,
  sendOpencodeExchange,
} from './opencode.js';
import type {
  ChatBackend,
  NormalizedExchangeRequest,
  BackendSendResult,
  DeltaSink,
} from './types.js';

export interface ChatBackendOptions {
  session?: string | undefined;
  cwd?: string | undefined;
  credential?: string | undefined;
  onDelta?: DeltaSink | undefined;
  // Aborted when the HTTP client disconnects; each backend forwards it to the
  // live network call or child process.
  signal?: AbortSignal | undefined;
}

export function createChatBackend(
  config: ResolvedBackendConfig,
  options: ChatBackendOptions = {},
): ChatBackend {
  if (config.type === 'openai') {
    return {
      id: config.name,
      type: 'openai',
      send: (request: NormalizedExchangeRequest): Promise<BackendSendResult> =>
        sendOpenAiExchange(
          config,
          request,
          { fetch },
          {
            credential: options.credential,
            onDelta: options.onDelta,
            signal: options.signal,
          },
        ),
    };
  }
  if (config.type === 'opencode') {
    return {
      id: config.name,
      type: 'opencode',
      send: (request: NormalizedExchangeRequest): Promise<BackendSendResult> =>
        sendOpencodeExchange(config, request, childProcessSpawnTransport, {
          session: options.session,
          cwd: options.cwd,
          onDelta: options.onDelta,
          signal: options.signal,
        }),
    };
  }
  return {
    id: config.name,
    type: 'agent',
    send: (request: NormalizedExchangeRequest): Promise<BackendSendResult> =>
      sendAcpExchange(config, request, childProcessAcpTransport, {
        session: options.session,
        cwd: options.cwd,
        onDelta: options.onDelta,
        signal: options.signal,
      }),
  };
}
