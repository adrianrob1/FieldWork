import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { diagnostic } from '../domain/diagnostics.js';
import {
  chatApi,
  chatsApi,
  contextApi,
  editBodyApi,
  editFrontmatterApi,
  fileApi,
  inboxApi,
  projectApi,
  projectsApi,
  searchApi,
  workspaceApi,
  type ApiResponse,
} from './api.js';
import {
  attachChatApi,
  createChatApi,
  detachChatApi,
  openChatApi,
  promoteChatApi,
  sendChatMessageApi,
  streamChatMessageApi,
} from './chatApi.js';
import {
  backendsAddApi,
  backendsApi,
  backendsCredentialApi,
  backendsDefaultApi,
  backendsModelsApi,
  backendsRemoveApi,
  backendsTestApi,
  backendsUpdateApi,
} from './backendsApi.js';
import {
  createBackendCredentialStore,
  type BackendCredentialStore,
} from './credentials.js';
import {
  createDraftApi,
  discardDraftApi,
  draftApi,
  draftsApi,
  streamSubmitDraftApi,
  submitDraftApi,
  updateDraftApi,
} from './draftsApi.js';
import { acceptsNdjson } from './ndjson.js';
import { appPage, unknownPage, type PageResponse } from './pages.js';
import { createProjectApi, projectRepositoriesApi } from './registerApi.js';
import {
  addOpenChatTaskApi,
  createTaskApi,
  doneTaskApi,
  openTaskChatApi,
  reopenTaskApi,
  snoozeTaskApi,
  taskApi,
  tasksApi,
  updateTaskApi,
} from './tasksApi.js';
import { topicsApi } from './topicsApi.js';
import { attachablesApi } from './attachablesApi.js';
import { readWebAsset } from './webAssets.js';

export interface RouteMatch {
  area: 'api' | 'page';
  name: string;
  params: Record<string, string>;
}

export interface WorkspaceServerOptions {
  host?: string;
  port?: number;
  webAssetsDir?: string | undefined;
}

export interface ServerHandle {
  readonly root: string;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly server: http.Server;
  stop(): Promise<void>;
}

export const defaultServeHost = '127.0.0.1';
export const defaultServePort = 1774;

interface RoutePattern {
  segments: string[];
  name: string;
}

const apiRoutes: RoutePattern[] = [
  { segments: ['api', 'workspace'], name: 'workspace' },
  { segments: ['api', 'projects'], name: 'projects' },
  { segments: ['api', 'projects', ':id'], name: 'project' },
  {
    segments: ['api', 'projects', ':id', 'repositories'],
    name: 'project-repositories',
  },
  { segments: ['api', 'chats'], name: 'chats' },
  { segments: ['api', 'chats', ':id'], name: 'chat' },
  { segments: ['api', 'chats', ':id', 'messages'], name: 'chat-messages' },
  { segments: ['api', 'chats', ':id', 'attach'], name: 'chat-attach' },
  { segments: ['api', 'chats', ':id', 'detach'], name: 'chat-detach' },
  { segments: ['api', 'chats', ':id', 'promote'], name: 'chat-promote' },
  { segments: ['api', 'chats', ':id', 'open-chat'], name: 'chat-open-chat' },
  { segments: ['api', 'inbox'], name: 'inbox' },
  { segments: ['api', 'search'], name: 'search' },
  { segments: ['api', 'context'], name: 'context' },
  { segments: ['api', 'file'], name: 'file' },
  { segments: ['api', 'edit', 'frontmatter'], name: 'edit-frontmatter' },
  { segments: ['api', 'edit', 'body'], name: 'edit-body' },
  { segments: ['api', 'tasks'], name: 'tasks' },
  {
    segments: ['api', 'tasks', 'add-open-chat'],
    name: 'tasks-add-open-chat',
  },
  { segments: ['api', 'tasks', ':id'], name: 'task' },
  {
    segments: ['api', 'tasks', ':id', 'open-chat'],
    name: 'task-open-chat',
  },
  { segments: ['api', 'tasks', ':id', 'update'], name: 'task-update' },
  { segments: ['api', 'tasks', ':id', 'done'], name: 'task-done' },
  { segments: ['api', 'tasks', ':id', 'reopen'], name: 'task-reopen' },
  { segments: ['api', 'tasks', ':id', 'snooze'], name: 'task-snooze' },
  { segments: ['api', 'drafts'], name: 'drafts' },
  { segments: ['api', 'drafts', ':id'], name: 'draft' },
  { segments: ['api', 'drafts', ':id', 'update'], name: 'draft-update' },
  { segments: ['api', 'drafts', ':id', 'discard'], name: 'draft-discard' },
  { segments: ['api', 'drafts', ':id', 'submit'], name: 'draft-submit' },
  { segments: ['api', 'topics'], name: 'topics' },
  { segments: ['api', 'attachables'], name: 'attachables' },
  { segments: ['api', 'backends'], name: 'backends' },
  { segments: ['api', 'backends', 'add'], name: 'backends-add' },
  { segments: ['api', 'backends', 'update'], name: 'backends-update' },
  { segments: ['api', 'backends', 'remove'], name: 'backends-remove' },
  { segments: ['api', 'backends', 'default'], name: 'backends-default' },
  { segments: ['api', 'backends', 'test'], name: 'backends-test' },
  { segments: ['api', 'backends', 'models'], name: 'backends-models' },
  {
    segments: ['api', 'backends', 'credential'],
    name: 'backends-credential',
  },
];

const pageRoutes: RoutePattern[] = [
  { segments: [], name: 'dashboard' },
  { segments: ['projects'], name: 'projects' },
  { segments: ['projects', ':id'], name: 'project' },
  { segments: ['chats'], name: 'chats' },
  { segments: ['chats', 'new'], name: 'chat-new' },
  { segments: ['chats', ':id'], name: 'chat' },
  { segments: ['inbox'], name: 'inbox' },
  { segments: ['search'], name: 'search' },
  { segments: ['context'], name: 'context' },
  { segments: ['edit'], name: 'edit' },
  { segments: ['settings'], name: 'settings' },
  { segments: ['tasks'], name: 'tasks' },
];

export function matchRoute(pathname: string): RouteMatch | null {
  const trimmed =
    pathname.length > 1 && pathname.endsWith('/')
      ? pathname.slice(0, -1)
      : pathname;
  const segments = trimmed === '/' ? [] : trimmed.split('/').slice(1);
  const routes = segments[0] === 'api' ? apiRoutes : pageRoutes;
  for (const route of routes) {
    const params = matchPattern(route.segments, segments);
    if (params !== null) {
      return {
        area: segments[0] === 'api' ? 'api' : 'page',
        name: route.name,
        params,
      };
    }
  }
  return null;
}

function matchPattern(
  pattern: string[],
  segments: string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index];
    if (segment === undefined) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = segment;
      continue;
    }
    if (part !== segment) return null;
  }
  return params;
}

export function isSameOrigin(
  origin: string,
  expectedOrigin: string | null,
): boolean {
  if (expectedOrigin === null) return false;
  return origin.trim().toLowerCase() === expectedOrigin.trim().toLowerCase();
}

export function isJsonContentType(contentType: string | undefined): boolean {
  if (typeof contentType !== 'string') return false;
  const segments = contentType.split(';');
  if ((segments[0] ?? '').trim().toLowerCase() !== 'application/json') {
    return false;
  }
  return segments.slice(1).every((parameter) => {
    const trimmed = parameter.trim();
    const equals = trimmed.indexOf('=');
    return equals > 0 && equals < trimmed.length - 1;
  });
}

export function createWorkspaceServer(
  root: string,
  getExpectedOrigin: () => string | null = () => null,
  options: { webAssetsDir?: string | undefined } = {},
): http.Server {
  const credentials = createBackendCredentialStore();
  const webAssetsDir =
    options.webAssetsDir ??
    fileURLToPath(new URL('../../dist/web', import.meta.url));
  return http.createServer((request, response) => {
    dispatch(
      root,
      request,
      getExpectedOrigin(),
      credentials,
      webAssetsDir,
      response,
    )
      .then((reply) => {
        if (reply !== null) send(response, reply);
      })
      .catch((error: unknown) => {
        if (response.headersSent) {
          try {
            response.end();
          } catch {
            // the client disconnected while streaming
          }
          return;
        }
        send(response, {
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({
            error: messageOf(error),
            diagnostics: [],
          }),
        });
      });
  });
}

export async function startServer(
  root: string,
  options: WorkspaceServerOptions = {},
): Promise<ServerHandle> {
  const host = options.host ?? defaultServeHost;
  const requestedPort = options.port ?? defaultServePort;
  let boundOrigin: string | null = null;
  const server = createWorkspaceServer(root, () => boundOrigin, {
    webAssetsDir: options.webAssetsDir,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, host, () => {
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : requestedPort;
  const displayHost = host.includes(':') ? `[${host}]` : host;
  boundOrigin = `http://${displayHost}:${String(port)}`;
  let stopPromise: Promise<void> | null = null;
  const handle: ServerHandle = {
    root,
    host,
    port,
    url: boundOrigin,
    server,
    stop() {
      if (stopPromise === null) stopPromise = stopServer(handle);
      return stopPromise;
    },
  };
  return handle;
}

export async function stopServer(handle: ServerHandle): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    handle.server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    handle.server.closeIdleConnections();
  });
}

interface Reply {
  status: number;
  contentType: string;
  body: string | Buffer;
  headers?: Record<string, string>;
}

const postApiRoutes = new Set([
  'edit-frontmatter',
  'edit-body',
  'chats',
  'chat-messages',
  'chat-attach',
  'chat-detach',
  'chat-promote',
  'chat-open-chat',
  'backends-add',
  'backends-update',
  'backends-remove',
  'backends-default',
  'backends-test',
  'backends-models',
  'backends-credential',
  'projects',
  'project-repositories',
  'tasks',
  'tasks-add-open-chat',
  'task-open-chat',
  'task-update',
  'task-done',
  'task-reopen',
  'task-snooze',
  'drafts',
  'draft-update',
  'draft-discard',
  'draft-submit',
]);
const maxJsonBodyBytes = 5 * 1024 * 1024;

class RequestBodyTooLarge extends Error {}

type JsonBody = { ok: true; value: unknown } | { ok: false; message: string };

async function dispatch(
  root: string,
  request: http.IncomingMessage,
  expectedOrigin: string | null,
  credentials: BackendCredentialStore,
  webAssetsDir: string,
  rawResponse: http.ServerResponse,
): Promise<Reply | null> {
  const base = `http://${request.headers.host ?? 'localhost'}`;
  let url: URL;
  try {
    url = new URL(request.url ?? '/', base);
  } catch {
    return textReply(400, 'Bad request');
  }
  if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
    const asset = await readWebAsset(webAssetsDir, url.pathname);
    if (asset.status === 404) return textReply(404, 'Not found');
    return {
      status: 200,
      contentType: asset.contentType,
      body: asset.bytes,
      headers: { 'cache-control': 'no-store' },
    };
  }
  const match = matchRoute(url.pathname);
  const apiStyle = match?.area === 'api' || url.pathname.startsWith('/api/');
  if (match === null) {
    if (apiStyle) {
      return jsonReply(404, { error: 'Unknown route.', diagnostics: [] });
    }
    return htmlReply(await unknownPage(webAssetsDir));
  }
  if (match.area === 'api') {
    if (request.method === 'GET') {
      let params: Record<string, string>;
      try {
        params = decodeParams(match.params);
      } catch {
        return jsonReply(400, {
          error: 'The route parameters are not valid URL encoding.',
          diagnostics: [],
        });
      }
      const response = await dispatchApi(
        root,
        match.name,
        params,
        url.searchParams,
        credentials,
      );
      return jsonReply(response.status, response.body);
    }
    if (request.method === 'POST' && postApiRoutes.has(match.name)) {
      let params: Record<string, string>;
      try {
        params = decodeParams(match.params);
      } catch {
        return jsonReply(400, {
          error: 'The route parameters are not valid URL encoding.',
          diagnostics: [],
        });
      }
      const origin = request.headers.origin;
      if (origin !== undefined && !isSameOrigin(origin, expectedOrigin)) {
        return originRejectedReply(root, origin);
      }
      const contentType = request.headers['content-type'];
      if (!isJsonContentType(contentType)) {
        return unsupportedMediaTypeReply(root, contentType);
      }
      const payload = await readJsonBody(request);
      if (!payload.ok) {
        return jsonReply(400, { error: payload.message, diagnostics: [] });
      }
      if (
        (match.name === 'chat-messages' || match.name === 'draft-submit') &&
        acceptsNdjson(request.headers.accept)
      ) {
        const streamed = await dispatchStreamingApiPost(
          root,
          match.name,
          params,
          payload.value,
          credentials,
          expectedOrigin,
          rawResponse,
        );
        if (streamed !== null) {
          return jsonReply(streamed.status, streamed.body);
        }
        return null;
      }
      const response = await dispatchApiPost(
        root,
        match.name,
        params,
        payload.value,
        credentials,
        expectedOrigin,
      );
      return jsonReply(response.status, response.body);
    }
    return jsonReply(405, { error: 'Method not allowed.', diagnostics: [] });
  }
  if (request.method !== 'GET') {
    return textReply(405, 'Method not allowed');
  }
  const page = await appPage(webAssetsDir);
  return htmlReply(page);
}

async function dispatchApiPost(
  root: string,
  name: string,
  params: Record<string, string>,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl: string | null,
): Promise<ApiResponse> {
  switch (name) {
    case 'edit-frontmatter':
      return editFrontmatterApi(root, payload);
    case 'edit-body':
      return editBodyApi(root, payload);
    case 'chats':
      return createChatApi(root, payload);
    case 'chat-messages':
      return sendChatMessageApi(
        root,
        params.id ?? '',
        payload,
        credentials,
        serverUrl ?? undefined,
      );
    case 'chat-attach':
      return attachChatApi(root, params.id ?? '', payload);
    case 'chat-detach':
      return detachChatApi(root, params.id ?? '', payload);
    case 'chat-promote':
      return promoteChatApi(root, params.id ?? '', payload);
    case 'chat-open-chat':
      return openChatApi(root, params.id ?? '', payload);
    case 'backends-add':
      return backendsAddApi(root, payload);
    case 'backends-update':
      return backendsUpdateApi(root, payload);
    case 'backends-remove':
      return backendsRemoveApi(root, payload);
    case 'backends-default':
      return backendsDefaultApi(root, payload);
    case 'backends-test':
      return backendsTestApi(root, payload, credentials);
    case 'backends-models':
      return backendsModelsApi(root, payload);
    case 'backends-credential':
      return backendsCredentialApi(root, payload, credentials);
    case 'projects':
      return createProjectApi(root, payload);
    case 'project-repositories':
      return projectRepositoriesApi(root, params.id ?? '', payload);
    case 'tasks':
      return createTaskApi(root, payload);
    case 'tasks-add-open-chat':
      return addOpenChatTaskApi(root, payload);
    case 'task-open-chat':
      return openTaskChatApi(root, params.id ?? '', payload);
    case 'task-update':
      return updateTaskApi(root, params.id ?? '', payload);
    case 'task-done':
      return doneTaskApi(root, params.id ?? '', payload);
    case 'task-reopen':
      return reopenTaskApi(root, params.id ?? '', payload);
    case 'task-snooze':
      return snoozeTaskApi(root, params.id ?? '', payload);
    case 'drafts':
      return createDraftApi(root, payload);
    case 'draft-update':
      return updateDraftApi(root, params.id ?? '', payload);
    case 'draft-discard':
      return discardDraftApi(root, params.id ?? '');
    case 'draft-submit':
      return submitDraftApi(
        root,
        params.id ?? '',
        payload,
        credentials,
        serverUrl ?? undefined,
      );
    default:
      return {
        status: 405,
        body: { error: 'Method not allowed.', diagnostics: [] },
      };
  }
}

async function dispatchStreamingApiPost(
  root: string,
  name: string,
  params: Record<string, string>,
  payload: unknown,
  credentials: BackendCredentialStore,
  serverUrl: string | null,
  response: http.ServerResponse,
): Promise<ApiResponse | null> {
  if (name === 'chat-messages') {
    return streamChatMessageApi(
      root,
      params.id ?? '',
      payload,
      credentials,
      serverUrl ?? undefined,
      response,
    );
  }
  if (name === 'draft-submit') {
    return streamSubmitDraftApi(
      root,
      params.id ?? '',
      payload,
      credentials,
      serverUrl ?? undefined,
      response,
    );
  }
  return {
    status: 405,
    body: { error: 'Method not allowed.', diagnostics: [] },
  };
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxJsonBodyBytes) {
        request.destroy();
        reject(new RequestBodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonBody> {
  let raw: string;
  try {
    raw = await readBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLarge) {
      return { ok: false, message: 'The request body is too large.' };
    }
    return { ok: false, message: 'The request body could not be read.' };
  }
  if (raw.trim() === '') {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, message: 'The request body is not valid JSON.' };
  }
}

async function dispatchApi(
  root: string,
  name: string,
  params: Record<string, string>,
  query: URLSearchParams,
  credentials: BackendCredentialStore,
): Promise<ApiResponse> {
  switch (name) {
    case 'workspace':
      return workspaceApi(root);
    case 'projects':
      return projectsApi(root);
    case 'project':
      return projectApi(root, params.id ?? '');
    case 'chats':
      return chatsApi(root, query);
    case 'chat':
      return chatApi(root, params.id ?? '', query);
    case 'inbox':
      return inboxApi(root);
    case 'search':
      return searchApi(root, query);
    case 'file':
      return fileApi(root, query);
    case 'backends':
      return backendsApi(root, credentials);
    case 'tasks':
      return tasksApi(root);
    case 'task':
      return taskApi(root, params.id ?? '');
    case 'drafts':
      return draftsApi(root);
    case 'draft':
      return draftApi(root, params.id ?? '');
    case 'topics':
      return topicsApi(root);
    case 'attachables':
      return attachablesApi(root, query);
    case 'edit-frontmatter':
    case 'edit-body':
    case 'chat-messages':
    case 'chat-attach':
    case 'chat-detach':
    case 'chat-promote':
    case 'chat-open-chat':
    case 'backends-add':
    case 'backends-update':
    case 'backends-remove':
    case 'backends-default':
    case 'backends-test':
    case 'backends-models':
    case 'backends-credential':
    case 'project-repositories':
    case 'tasks-add-open-chat':
    case 'task-open-chat':
    case 'task-update':
    case 'task-done':
    case 'task-reopen':
    case 'task-snooze':
    case 'draft-update':
    case 'draft-discard':
    case 'draft-submit':
      return {
        status: 405,
        body: { error: 'Method not allowed.', diagnostics: [] },
      };
    default:
      return contextApi(root, query);
  }
}

function decodeParams(params: Record<string, string>): Record<string, string> {
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    decoded[key] = decodeURIComponent(value);
  }
  return decoded;
}

function jsonReply(status: number, body: unknown): Reply {
  return {
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  };
}

function originRejectedReply(root: string, origin: string): Reply {
  const entry = diagnostic(
    root,
    'serve.origin_rejected',
    'error',
    `Cross-origin write refused: request Origin '${origin}' does not match this server's origin.`,
    { fieldPath: 'origin' },
  );
  return jsonReply(403, { error: entry.message, diagnostics: [entry] });
}

function unsupportedMediaTypeReply(
  root: string,
  contentType: string | undefined,
): Reply {
  const entry = diagnostic(
    root,
    'serve.content_type_required',
    'error',
    contentType === undefined
      ? "Edit endpoints require a 'Content-Type: application/json' request header."
      : `Edit endpoints require 'Content-Type: application/json', not '${contentType}'.`,
    { fieldPath: 'content-type' },
  );
  return jsonReply(415, { error: entry.message, diagnostics: [entry] });
}

function htmlReply(page: PageResponse): Reply {
  return {
    status: page.status,
    contentType: 'text/html; charset=utf-8',
    body: page.html,
  };
}

function textReply(status: number, body: string): Reply {
  return {
    status,
    contentType: 'text/plain; charset=utf-8',
    body,
  };
}

function send(response: http.ServerResponse, reply: Reply): void {
  response.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': Buffer.byteLength(reply.body),
    ...reply.headers,
  });
  response.end(reply.body);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
