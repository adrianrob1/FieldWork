import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { startServer, type ServerHandle } from '../../src/server/server.js';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const sampleWorkspace = path.join(repositoryRoot, 'examples/sample-workspace');
const temporaryDirectories: string[] = [];
const runningHandles: ServerHandle[] = [];
const serverTestTimeout = 20_000;

afterEach(async () => {
  await Promise.all(runningHandles.splice(0).map((handle) => handle.stop()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeFakeWebAssets(): Promise<string> {
  const directory = await tempDir('fieldwork-web-assets-');
  const manifest = {
    app: { js: 'assets/app.js', css: ['assets/app-A1b2C3.css'] },
  };
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(
    path.join(directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(path.join(directory, 'assets', 'app.js'), '// app entry\n');
  await writeFile(
    path.join(directory, 'assets', 'app-A1b2C3.css'),
    '/* app styles */\n',
  );
  return directory;
}

async function startWithSampleWorkspace(webAssetsDir: string): Promise<string> {
  const root = await tempDir('fieldwork-web-workspace-');
  await cp(sampleWorkspace, root, { recursive: true });
  const handle = await startServer(root, {
    host: '127.0.0.1',
    port: 0,
    webAssetsDir,
  });
  runningHandles.push(handle);
  return handle.url;
}

async function get(
  baseUrl: string,
  route: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const response = await fetch(`${baseUrl}${route}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

const spaRoutes = [
  '/',
  '/projects',
  '/projects/project_evon',
  '/chats',
  '/chats/new',
  '/chats/chat_rank_diagnostics',
  '/inbox',
  '/search',
  '/context',
  '/edit',
  '/settings',
  '/tasks',
];

describe('web frontend serving', () => {
  it(
    'serves the single app shell with its script and stylesheet on every route',
    async () => {
      const assets = await writeFakeWebAssets();
      const baseUrl = await startWithSampleWorkspace(assets);
      for (const route of spaRoutes) {
        const page = await get(baseUrl, route);
        expect(page.status, route).toBe(200);
        expect(page.contentType, route).toContain('text/html');
        expect(page.body, route).toContain('<div id="root">');
        expect(page.body, route).toContain(
          '<script type="module" src="/assets/app.js">',
        );
        expect(page.body, route).toContain(
          '<link rel="stylesheet" href="/assets/app-A1b2C3.css">',
        );
      }
      const unknown = await get(baseUrl, '/nope');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toContain('<div id="root">');
    },
    serverTestTimeout,
  );

  it(
    'serves built assets with content types and no-store caching',
    async () => {
      const assets = await writeFakeWebAssets();
      const baseUrl = await startWithSampleWorkspace(assets);
      const script = await fetch(`${baseUrl}/assets/app.js`);
      expect(script.status).toBe(200);
      expect(script.headers.get('content-type')).toContain('text/javascript');
      expect(script.headers.get('cache-control')).toBe('no-store');
      expect(await script.text()).toBe('// app entry\n');
      const styles = await fetch(`${baseUrl}/assets/app-A1b2C3.css`);
      expect(styles.status).toBe(200);
      expect(styles.headers.get('content-type')).toContain('text/css');
      expect(await styles.text()).toBe('/* app styles */\n');
    },
    serverTestTimeout,
  );

  it(
    'rejects traversal, subdirectories, and unknown assets with 404',
    async () => {
      const assets = await writeFakeWebAssets();
      const baseUrl = await startWithSampleWorkspace(assets);
      for (const route of [
        '/assets/../workspace.yml',
        '/assets/%2e%2e/workspace.yml',
        '/assets/..%5cworkspace.yml',
        '/assets/sub/app.js',
        '/assets/missing.js',
        '/assets/app.txt',
      ]) {
        const page = await get(baseUrl, route);
        expect(page.status, route).toBe(404);
      }
    },
    serverTestTimeout,
  );

  it(
    'keeps unknown API routes on the JSON 404 envelope',
    async () => {
      const assets = await writeFakeWebAssets();
      const baseUrl = await startWithSampleWorkspace(assets);
      const response = await fetch(`${baseUrl}/api/nope`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      const body = (await response.json()) as {
        error: string;
        diagnostics: unknown[];
      };
      expect(typeof body.error).toBe('string');
      expect(Array.isArray(body.diagnostics)).toBe(true);
    },
    serverTestTimeout,
  );

  it(
    'falls back to the build notice when the assets directory is missing',
    async () => {
      const baseUrl = await startWithSampleWorkspace(
        path.join(os.tmpdir(), 'fieldwork-web-assets-missing'),
      );
      for (const route of ['/', '/chats/new', '/settings', '/tasks']) {
        const page = await get(baseUrl, route);
        expect(page.status, route).toBe(200);
        expect(page.body, route).toContain('npm run build:web');
        expect(page.body, route).not.toContain('/assets/app.js');
      }
      const unknown = await get(baseUrl, '/nope');
      expect(unknown.status).toBe(404);
      expect(unknown.body).toContain('npm run build:web');
    },
    serverTestTimeout,
  );
});
