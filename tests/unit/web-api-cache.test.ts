import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getJson,
  invalidateGetCache,
  postJson,
} from '../../web/src/shared/api.js';

// A minimal Response stand-in: requestJson only reads ok, status, and json().
function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Call {
  method: string;
  url: string;
}

function installFetch(handler: (method: string, url: string) => Response): {
  calls: Call[];
} {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({ method, url });
      return Promise.resolve(handler(method, url));
    }),
  );
  return { calls };
}

beforeEach(() => {
  invalidateGetCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getJson cache', () => {
  it('coalesces concurrent identical reads into one fetch', async () => {
    const { calls } = installFetch(() => jsonResponse(200, { value: 1 }));

    const [first, second] = await Promise.all([
      getJson<{ value: number }>('/api/things'),
      getJson<{ value: number }>('/api/things'),
    ]);

    expect(calls).toHaveLength(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it('serves a cached response to later reads', async () => {
    let serial = 0;
    const { calls } = installFetch(() =>
      jsonResponse(200, { value: (serial += 1) }),
    );

    const first = await getJson<{ value: number }>('/api/things');
    const second = await getJson<{ value: number }>('/api/things');

    expect(calls).toHaveLength(1);
    expect(first.ok && first.data.value).toBe(1);
    expect(second.ok && second.data.value).toBe(1);
  });

  it('does not cache different URLs together', async () => {
    const { calls } = installFetch(() => jsonResponse(200, { ok: true }));

    await getJson('/api/one');
    await getJson('/api/two');
    await getJson('/api/one');
    await getJson('/api/two');

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url).sort()).toEqual([
      '/api/one',
      '/api/two',
    ]);
  });

  it('bypasses and refreshes the cache when asked', async () => {
    let serial = 0;
    const { calls } = installFetch(() =>
      jsonResponse(200, { value: (serial += 1) }),
    );

    const cached = await getJson<{ value: number }>('/api/things');
    const fresh = await getJson<{ value: number }>('/api/things', {
      bypassCache: true,
    });

    expect(calls).toHaveLength(2);
    expect(cached.ok && cached.data.value).toBe(1);
    expect(fresh.ok && fresh.data.value).toBe(2);
  });

  it('does not cache a failed read', async () => {
    const { calls } = installFetch(() => jsonResponse(500, { error: 'boom' }));

    await getJson('/api/things');
    await getJson('/api/things');

    expect(calls).toHaveLength(2);
  });
});

describe('write invalidation', () => {
  it('invalidates the whole cache after a successful POST', async () => {
    let serial = 0;
    const { calls } = installFetch((method) =>
      method === 'POST'
        ? jsonResponse(200, { ok: true })
        : jsonResponse(200, { value: (serial += 1) }),
    );

    const before = await getJson<{ value: number }>('/api/things');
    await postJson('/api/things', { value: 'new' });
    const after = await getJson<{ value: number }>('/api/things');

    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST', 'GET']);
    expect(before.ok && before.data.value).toBe(1);
    expect(after.ok && after.data.value).toBe(2);
  });

  it('leaves the cache intact after a failed POST', async () => {
    const { calls } = installFetch((method) =>
      method === 'POST'
        ? jsonResponse(422, { diagnostics: [] })
        : jsonResponse(200, { value: 'cached' }),
    );

    await getJson('/api/things');
    const failed = await postJson('/api/things', { value: 'bad' });
    const after = await getJson('/api/things');

    expect(failed.ok).toBe(false);
    // The failed write did not invalidate, so the third read is a cache hit.
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(after.ok && after.data.value).toBe('cached');
  });

  it('scopes invalidation to a prefix', async () => {
    let one = 0;
    let two = 0;
    const { calls } = installFetch((_method, url) =>
      jsonResponse(200, {
        value: url === '/api/one' ? (one += 1) : (two += 1),
      }),
    );

    await getJson('/api/one');
    await getJson('/api/two');
    invalidateGetCache('/api/one');
    await getJson('/api/one');
    await getJson('/api/two');

    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.url === '/api/one')).toHaveLength(2);
    expect(calls.filter((call) => call.url === '/api/two')).toHaveLength(1);
  });
});
