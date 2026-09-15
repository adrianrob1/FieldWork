import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Programmatic workspace fixtures for the browser suite. Every suite starts from
// a private copy of examples/sample-workspace (made by server.ts) and then adds
// only the files that suite needs, so nothing here mutates the checked-in
// example workspace.

export interface FixtureOptions {
  // Append a ~32-message transcript to chats/ for the pagination suite.
  longChat?: boolean;
  // Rewrite workspace.yml with a single openai-compatible backend named "stub"
  // pointed at a local stub server.
  stubBackend?: boolean;
  // Override the assistant chunks trickled over SSE. Defaults to splitting
  // stubReply into words so a test can observe the bubble grow.
  streamParts?: string[];
  // reasoning_content chunks emitted before the content phase, to exercise the
  // streaming Thinking row. Empty/absent means no thought phase.
  thoughtParts?: string[];
  // Delay between SSE chunks in milliseconds.
  streamDelayMs?: number;
  // Extra delay before the very first SSE chunk, so a test can observe the
  // pre-first-delta phase (the streaming bubble and its working timer).
  streamFirstDelayMs?: number;
  // Delay between thought-phase SSE chunks in milliseconds (defaults to
  // streamDelayMs).
  thoughtDelayMs?: number;
}

export interface StubBackend {
  // OpenAI-compatible base URL, e.g. http://127.0.0.1:1234/v1.
  url: string;
  close(): Promise<void>;
  // Whether each chat/completions request asked for a streamed reply.
  streamRequests(): boolean[];
}

export interface FixtureWriteOptions extends FixtureOptions {
  // Required when stubBackend is true; becomes the backend base_url.
  stubUrl?: string;
}

// The exact assistant text the stub returns for every completion. Tests assert
// that this text shows up in the canonical transcript.
export const stubReply = 'Stub backend reply: the transcript is acknowledged.';

export const longChatId = 'chat_long_transcript';
export const longChatMessageCount = 32;

// A tiny OpenAI-compatible server. It implements the two routes the real
// backend client touches:
//   POST {baseUrl}/chat/completions -> JSON, or SSE when body.stream is true
//   GET  {baseUrl}/models           -> model probe used by "test backend"
export async function startStubBackend(
  options: FixtureOptions = {},
): Promise<StubBackend> {
  const streamRequests: boolean[] = [];
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method === 'GET' && pathname.endsWith('/models')) {
      respondJson(response, 200, {
        object: 'list',
        data: [{ id: 'stub-model', object: 'model', owned_by: 'stub' }],
      });
      return;
    }
    if (request.method === 'POST' && pathname.endsWith('/chat/completions')) {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let parsed: { stream?: boolean } = {};
        try {
          parsed = JSON.parse(body) as { stream?: boolean };
        } catch {
          parsed = {};
        }
        const streaming = parsed.stream === true;
        streamRequests.push(streaming);
        if (streaming) {
          respondStream(response, options);
          return;
        }
        respondJson(response, 200, {
          id: 'stub-completion',
          object: 'chat.completion',
          model: 'stub-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: stubReply },
            },
          ],
        });
      });
      return;
    }
    respondJson(response, 404, { error: 'unknown stub route' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
    streamRequests: () => [...streamRequests],
  };
}

function defaultStreamParts(): string[] {
  const parts = stubReply.match(/\S+\s*/g);
  return parts ?? [stubReply];
}

function respondStream(
  response: http.ServerResponse,
  options: FixtureOptions,
): void {
  const parts = options.streamParts ?? defaultStreamParts();
  const thoughts = options.thoughtParts ?? [];
  const delay = options.streamDelayMs ?? 110;
  const thoughtDelay = options.thoughtDelayMs ?? delay;
  const firstDelay = options.streamFirstDelayMs ?? 0;
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
  });
  let index = 0;
  let thoughtIndex = 0;
  const tick = (): void => {
    if (thoughtIndex < thoughts.length) {
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { reasoning_content: thoughts[thoughtIndex] },
            },
          ],
        })}\n\n`,
      );
      thoughtIndex += 1;
      setTimeout(tick, thoughtDelay);
      return;
    }
    if (index < parts.length) {
      response.write(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: parts[index] } }],
        })}\n\n`,
      );
      index += 1;
      setTimeout(tick, delay);
      return;
    }
    response.write(
      `data: ${JSON.stringify({
        model: 'stub-model',
        usage: { total_tokens: 19 },
      })}\n\n`,
    );
    response.write('data: [DONE]\n\n');
    response.end();
  };
  if (firstDelay > 0) {
    setTimeout(tick, firstDelay);
  } else {
    tick();
  }
}

export async function writeFixtureFiles(
  root: string,
  options: FixtureWriteOptions,
): Promise<void> {
  if (options.longChat === true) {
    await writeFile(
      path.join(root, 'chats', '2026-09-01-long-transcript.md'),
      longChatSource(),
    );
  }
  if (options.stubBackend === true && options.stubUrl !== undefined) {
    await writeFile(
      path.join(root, 'workspace.yml'),
      stubWorkspaceSource(options.stubUrl),
    );
  }
}

export function longChatSource(): string {
  const lines: string[] = [
    '---',
    `id: ${longChatId}`,
    'title: Long transcript',
    'created: 2026-09-01',
    'updated: 2026-09-01',
    '---',
    '',
    '# Long transcript',
    '',
  ];
  for (let index = 0; index < longChatMessageCount; index += 1) {
    const role = index % 2 === 0 ? 'user' : 'assistant';
    lines.push(`## ${role}`, '');
    if (role === 'assistant') {
      lines.push(
        '```yaml',
        'provider: stub',
        'model: stub-model',
        'at: 2026-09-01T10:00:00Z',
        '```',
        '',
      );
    }
    lines.push(
      `Line ${String(index)}: transcript message ${String(index)}.`,
      '',
    );
  }
  return lines.join('\n');
}

export function stubWorkspaceSource(baseUrl: string): string {
  return [
    'version: 1',
    'title: Optimizer research sample',
    'paths:',
    '  projects: projects',
    '  chats: chats',
    '  topics: topics',
    '  inbox: inbox',
    '  external: external',
    'backends:',
    '  default: stub',
    '  entries:',
    '    stub:',
    '      type: openai',
    `      base_url: ${baseUrl}`,
    '      model: stub-model',
    '',
  ].join('\n');
}

function respondJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
