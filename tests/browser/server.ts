import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { test as base, expect } from '@playwright/test';

import {
  startStubBackend,
  writeFixtureFiles,
  type FixtureOptions,
  type StubBackend,
} from './fixture.js';

export { expect };

const repoRoot = process.cwd();
const sampleWorkspace = path.join(repoRoot, 'examples', 'sample-workspace');
const cliEntry = path.join(repoRoot, 'dist', 'cli.js');
const startupTimeoutMs = 30_000;

export interface ApiReply {
  status: number;
  body: unknown;
}

export interface SidecarApi {
  get(route: string): Promise<ApiReply>;
  post(route: string, payload?: unknown): Promise<ApiReply>;
}

// Per-worker harness: one private temp workspace, one FieldWork server child
// process, and (when the fixture asks for it) one stub backend. Tests read the
// live baseUrl, so a restart that lands on a new port is transparent.
export interface Sidecar {
  readonly root: string;
  readonly baseUrl: string;
  readonly api: SidecarApi;
  readonly stub: StubBackend | null;
  url(route: string): string;
  restart(): Promise<void>;
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  stderr(): string;
}

type WorkerFixtures = {
  fixtureOptions: FixtureOptions;
  sidecar: Sidecar;
};

export const test = base.extend<Record<string, never>, WorkerFixtures>({
  fixtureOptions: [{}, { scope: 'worker', option: true }],

  sidecar: [
    async ({ fixtureOptions }, use) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), 'fieldwork-e2e-workspace-'),
      );
      let stub: StubBackend | null = null;
      let running: RunningServer | null = null;
      let currentBaseUrl = '';
      try {
        await cp(sampleWorkspace, root, { recursive: true });
        if (fixtureOptions.stubBackend === true) {
          stub = await startStubBackend(fixtureOptions);
        }
        await writeFixtureFiles(root, {
          ...fixtureOptions,
          ...(stub === null ? {} : { stubUrl: stub.url }),
        });
        running = await spawnServer(root);
        currentBaseUrl = running.baseUrl;
      } catch (error) {
        if (running !== null) await killServer(running.child);
        if (stub !== null) await stub.close();
        await removeDirectory(root);
        throw error;
      }

      const api: SidecarApi = {
        get: (route) => request(currentBaseUrl, route),
        post: (route, payload) =>
          request(currentBaseUrl, route, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          }),
      };
      const sidecar: Sidecar = {
        root,
        get baseUrl() {
          return currentBaseUrl;
        },
        api,
        stub,
        url: (route) => `${currentBaseUrl}${route}`,
        async restart() {
          if (running !== null) await killServer(running.child);
          running = await spawnServer(root);
          currentBaseUrl = running.baseUrl;
        },
      };

      try {
        await use(sidecar);
      } finally {
        if (running !== null) await killServer(running.child);
        if (stub !== null) await stub.close();
        await removeDirectory(root);
      }
    },
    { scope: 'worker' },
  ],
});

async function spawnServer(root: string): Promise<RunningServer> {
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      cliEntry,
      'serve',
      '--workspace',
      root,
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
    ],
    { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.stdout?.on('data', () => {
    // Drain stdout so a chatty server cannot fill the pipe buffer.
  });
  const running: RunningServer = {
    child,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    stderr: () => stderr,
  };
  await waitForServer(running);
  return running;
}

async function waitForServer(running: RunningServer): Promise<void> {
  const deadline = Date.now() + startupTimeoutMs;
  let reason = 'no response yet';
  while (Date.now() < deadline) {
    if (running.child.exitCode !== null) {
      throw new Error(
        `FieldWork server exited with code ${String(running.child.exitCode)}.\n${running.stderr()}`,
      );
    }
    try {
      const response = await fetch(`${running.baseUrl}/api/workspace`);
      if (response.status === 200) return;
      reason = `HTTP ${String(response.status)}`;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    await delay(150);
  }
  throw new Error(
    `FieldWork server did not become ready (${reason}).\n${running.stderr()}`,
  );
}

async function killServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

async function request(
  baseUrl: string,
  route: string,
  init?: RequestInit,
): Promise<ApiReply> {
  const response = await fetch(`${baseUrl}${route}`, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function removeDirectory(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
