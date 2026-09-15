import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface WebManifestEntry {
  js: string;
  css: string[];
}

export async function readWebManifestEntry(
  assetsDir: string | undefined,
  entry: string,
): Promise<WebManifestEntry | null> {
  if (assetsDir === undefined) return null;
  let raw: string;
  try {
    raw = await readFile(path.join(assetsDir, 'manifest.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const candidate = parsed[entry];
  if (!isManifestEntry(candidate)) return null;
  if (assetUrlOf(candidate.js) === null) return null;
  const css = candidate.css.filter((ref) => assetUrlOf(ref) !== null);
  return { js: candidate.js, css };
}

export function assetUrlOf(reference: string): string | null {
  if (!reference.startsWith('assets/')) return null;
  const name = reference.slice('assets/'.length);
  return assetNameOfName(name) === null ? null : `/${reference}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManifestEntry(value: unknown): value is WebManifestEntry {
  if (!isRecord(value)) return false;
  if (typeof value.js !== 'string') return false;
  if (!Array.isArray(value.css)) return false;
  return value.css.every((item): item is string => typeof item === 'string');
}

export type WebAssetOutcome =
  { status: 200; contentType: string; bytes: Buffer } | { status: 404 };

const assetContentTypes: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export async function readWebAsset(
  assetsDir: string | undefined,
  pathname: string,
): Promise<WebAssetOutcome> {
  if (assetsDir === undefined) return { status: 404 };
  if (!pathname.startsWith('/assets/')) return { status: 404 };
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    return { status: 404 };
  }
  if (assetNameOfName(name) === null) return { status: 404 };
  const contentType = assetContentTypes[path.extname(name)];
  if (contentType === undefined) return { status: 404 };
  try {
    const bytes = await readFile(path.join(assetsDir, 'assets', name));
    return { status: 200, contentType, bytes };
  } catch {
    return { status: 404 };
  }
}

function assetNameOfName(name: string): string | null {
  if (name === '' || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\')) return null;
  if (name !== path.basename(name)) return null;
  return name;
}
