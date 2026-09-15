import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { ParsedWorkspaceFile } from '../files/workspace.js';
import type { WorkspaceDatabase } from './database.js';

export interface FileFingerprint {
  hash: string;
  size: number;
  mtimeMs: number;
}

export interface ObjectRow {
  id: string;
  type: string;
  title: string | null;
  summary: string | null;
  path: string;
  metadata: string;
}

export interface ReferenceRow {
  source: string;
  target: string;
  relation: string;
}

export interface RepositoryRow {
  id: string;
  path: string;
  sourcePath: string;
}

export interface DocumentRow {
  title: string;
  summary: string;
  keywords: string;
  body: string;
  path: string;
  objectId: string;
}

export interface FileRows {
  object: ObjectRow | null;
  references: ReferenceRow[];
  repositories: RepositoryRow[];
  document: DocumentRow | null;
  diagnostics: Diagnostic[];
}

export function canonicalPath(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export async function fingerprint(file: string): Promise<FileFingerprint> {
  const [content, stats] = await Promise.all([readFile(file), stat(file)]);
  return {
    hash: createHash('sha256').update(content).digest('hex'),
    size: stats.size,
    mtimeMs: stats.mtimeMs,
  };
}

export function buildFileRows(
  file: ParsedWorkspaceFile,
  root: string,
  knownIds: ReadonlySet<string> | null,
): FileRows {
  const rows: FileRows = {
    object: null,
    references: [],
    repositories: [],
    document: null,
    diagnostics: [],
  };
  const relative = canonicalPath(root, file.file);
  if (file.kind === 'project') {
    rows.repositories.push(...inlineRepositories(file, relative));
  }
  const metadata = file.metadata;
  const id = typeof metadata?.id === 'string' ? metadata.id : null;
  if (metadata === null || id === null || file.kind === 'workspace') {
    return rows;
  }
  if (file.diagnostics.some((entry) => entry.severity === 'error')) {
    return rows;
  }
  rows.object = {
    id,
    type: file.kind,
    title: typeof metadata.title === 'string' ? metadata.title : null,
    summary: typeof metadata.summary === 'string' ? metadata.summary : null,
    path: relative,
    metadata: JSON.stringify(routingMetadata(file.kind, metadata)),
  };
  if (knownIds !== null) {
    rows.references.push(
      ...buildReferenceRows(file, id, knownIds, rows.diagnostics),
    );
  }
  rows.document = {
    title: rows.object.title ?? '',
    summary: rows.object.summary ?? '',
    keywords: stringList(metadata.keywords).join(' '),
    body: file.body ?? '',
    path: relative,
    objectId: id,
  };
  return rows;
}

export function buildReferenceRows(
  file: ParsedWorkspaceFile,
  source: string,
  knownIds: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): ReferenceRow[] {
  const rows: ReferenceRow[] = [];
  for (const [field, relation] of referenceFields(file.kind)) {
    const value = file.metadata?.[field];
    const targets = typeof value === 'string' ? [value] : stringList(value);
    for (const target of targets) {
      if (!knownIds.has(target)) {
        diagnostics.push(
          diagnostic(
            file.file,
            'index.reference_dangling',
            'warning',
            `Reference '${field}' to '${target}' was skipped because the target object is not indexed.`,
            { fieldPath: field },
          ),
        );
        continue;
      }
      rows.push({ source, target, relation });
    }
  }
  return rows;
}

export function collectKnownIds(files: ParsedWorkspaceFile[]): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (file.kind === 'project' && Array.isArray(file.metadata?.repositories)) {
      for (const entry of file.metadata.repositories) {
        if (isRecord(entry) && typeof entry.id === 'string') ids.add(entry.id);
      }
    }
    if (hasErrors(file)) continue;
    const id = file.metadata?.id;
    if (file.kind !== 'workspace' && typeof id === 'string') ids.add(id);
  }
  return ids;
}

export function knownIdsFromIndex(database: WorkspaceDatabase): Set<string> {
  const ids = new Set<string>();
  for (const row of database.all<{ id: string }>('SELECT id FROM objects')) {
    ids.add(row.id);
  }
  for (const row of database.all<{ id: string }>(
    'SELECT id FROM repositories',
  )) {
    ids.add(row.id);
  }
  return ids;
}

export function insertFileRows(
  database: WorkspaceDatabase,
  canonical: string,
  area: string,
  fingerprintOf: FileFingerprint,
  rows: FileRows,
): void {
  const object = rows.object;
  database.run(
    'INSERT INTO files (path, area, mtime_ms, size, hash) VALUES (?, ?, ?, ?, ?)',
    canonical,
    area,
    fingerprintOf.mtimeMs,
    fingerprintOf.size,
    fingerprintOf.hash,
  );
  if (object !== null) {
    database.run(
      'INSERT INTO objects (id, type, title, summary, path, metadata) VALUES (?, ?, ?, ?, ?, ?)',
      object.id,
      object.type,
      object.title,
      object.summary,
      object.path,
      object.metadata,
    );
  }
}

export function insertDocumentRow(
  database: WorkspaceDatabase,
  document: DocumentRow,
): void {
  database.run(
    'INSERT INTO documents_fts (title, summary, keywords, body, path, object_id) VALUES (?, ?, ?, ?, ?, ?)',
    document.title,
    document.summary,
    document.keywords,
    document.body,
    document.path,
    document.objectId,
  );
}

export function insertReferenceRows(
  database: WorkspaceDatabase,
  references: ReferenceRow[],
): void {
  for (const reference of references) {
    database.run(
      'INSERT OR IGNORE INTO "references" (source, target, relation) VALUES (?, ?, ?)',
      reference.source,
      reference.target,
      reference.relation,
    );
  }
}

export function insertRepositoryRows(
  database: WorkspaceDatabase,
  repositories: RepositoryRow[],
): void {
  for (const repository of repositories) {
    database.run(
      'INSERT OR REPLACE INTO repositories (id, path, source_path) VALUES (?, ?, ?)',
      repository.id,
      repository.path,
      repository.sourcePath,
    );
  }
}

export function deleteFileRows(
  database: WorkspaceDatabase,
  canonical: string,
): void {
  database.run(
    'DELETE FROM "references" WHERE source IN (SELECT id FROM objects WHERE path = ?)',
    canonical,
  );
  database.run('DELETE FROM documents_fts WHERE path = ?', canonical);
  database.run('DELETE FROM repositories WHERE source_path = ?', canonical);
  database.run('DELETE FROM objects WHERE path = ?', canonical);
  database.run('DELETE FROM files WHERE path = ?', canonical);
}

function inlineRepositories(
  file: ParsedWorkspaceFile,
  sourcePath: string,
): RepositoryRow[] {
  const entries = Array.isArray(file.metadata?.repositories)
    ? file.metadata.repositories
    : [];
  const rows: RepositoryRow[] = [];
  entries.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    if (typeof entry.id !== 'string' || typeof entry.path !== 'string') return;
    const resolution = file.resolvedPaths.find(
      (candidate) => candidate.fieldPath === `repositories.${index}.path`,
    );
    if (!resolution) return;
    rows.push({
      id: entry.id,
      path: resolution.resolvedPath,
      sourcePath,
    });
  });
  return rows;
}

function referenceFields(
  kind: ParsedWorkspaceFile['kind'],
): [string, string][] {
  switch (kind) {
    case 'project':
      return [
        ['resources', 'resource'],
        ['links', 'link'],
      ];
    case 'chat':
    case 'resource':
      return [
        ['projects', 'project'],
        ['links', 'link'],
      ];
    case 'task':
      return [['projects', 'project']];
    case 'summary':
      return [
        ['sources', 'source'],
        ['links', 'link'],
        ['project', 'project'],
      ];
    case 'link':
      return [
        ['from', 'from'],
        ['to', 'to'],
      ];
    default:
      return [];
  }
}

function routingMetadata(
  kind: ParsedWorkspaceFile['kind'],
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const keys: string[] = (() => {
    switch (kind) {
      case 'project':
        return ['topics', 'summary'];
      case 'chat':
        return [
          'projects',
          'topics',
          'provider',
          'model',
          'created',
          'updated',
        ];
      case 'task':
        return [
          'status',
          'projects',
          'deadline',
          'created',
          'updated',
          'completed',
        ];
      case 'resource':
        return ['kind', 'projects', 'topics', 'path', 'url'];
      case 'summary':
        return ['kind', 'project', 'keywords', 'reviewed'];
      case 'link':
        return ['from', 'to', 'relation', 'label', 'created'];
      default:
        return [];
    }
  })();
  const routing: Record<string, unknown> = {};
  for (const key of keys) {
    if (metadata[key] !== undefined) routing[key] = metadata[key];
  }
  return routing;
}

function hasErrors(file: ParsedWorkspaceFile): boolean {
  return file.diagnostics.some((entry) => entry.severity === 'error');
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
