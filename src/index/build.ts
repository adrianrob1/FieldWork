import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  parseWorkspace,
  type WorkspaceParseResult,
} from '../files/workspace.js';
import { openDatabase, type WorkspaceDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import {
  fileExists,
  indexDirectory,
  indexNewPath,
  indexOldPath,
  indexPath,
  recoverIndexFiles,
} from './paths.js';
import type { IndexCounts, IndexResult } from './result.js';
import {
  buildFileRows,
  canonicalPath,
  collectKnownIds,
  fingerprint,
  insertDocumentRow,
  insertFileRows,
  insertReferenceRows,
  insertRepositoryRows,
  type FileFingerprint,
  type FileRows,
} from './rows.js';

export interface RebuildOptions {
  parse?: (root: string) => Promise<WorkspaceParseResult>;
}

export async function rebuildIndex(
  root: string,
  options: RebuildOptions = {},
): Promise<IndexResult> {
  const parse = options.parse ?? parseWorkspace;
  const workspaceRoot = path.resolve(root);
  const target = indexPath(workspaceRoot);
  const staging = indexNewPath(workspaceRoot);

  let parsed: WorkspaceParseResult;
  try {
    await recoverIndexFiles(workspaceRoot);
    parsed = await parse(workspaceRoot);
  } catch (error) {
    await rm(staging, { force: true });
    return failure(target, error);
  }

  let database: WorkspaceDatabase | null = null;
  try {
    await mkdir(indexDirectory(workspaceRoot), { recursive: true });
    await rm(staging, { force: true });
    const opened = openDatabase(staging);
    database = opened;
    const migration = runMigrations(opened, staging);
    const migrationError = migration.diagnostics.find(
      (entry) => entry.severity === 'error',
    );
    if (migrationError !== undefined) throw new Error(migrationError.message);
    const prepared = await prepareRows(parsed);
    opened.transaction(() => {
      for (const item of prepared) {
        insertFileRows(
          opened,
          item.canonical,
          item.area,
          item.print,
          item.rows,
        );
        insertRepositoryRows(opened, item.rows.repositories);
        if (item.rows.document !== null) {
          insertDocumentRow(opened, item.rows.document);
        }
        insertReferenceRows(opened, item.rows.references);
      }
    });
    const counts = validateIndex(opened, parsed.files.length, staging);
    opened.close();
    database = null;
    await swapIntoPlace(workspaceRoot, target, staging);
    return {
      indexPath: target,
      rebuilt: true,
      counts,
      diagnostics: [
        ...parsed.diagnostics,
        ...prepared.flatMap((item) => item.rows.diagnostics),
      ],
    };
  } catch (error) {
    database?.close();
    await rm(staging, { force: true });
    return failure(target, error, parsed.diagnostics);
  }
}

interface PreparedRows {
  canonical: string;
  area: string;
  print: FileFingerprint;
  rows: FileRows;
}

async function prepareRows(
  parsed: WorkspaceParseResult,
): Promise<PreparedRows[]> {
  const knownIds = collectKnownIds(parsed.files);
  const prepared: PreparedRows[] = [];
  for (const file of parsed.files) {
    let print: FileFingerprint;
    try {
      print = await fingerprint(file.file);
    } catch (error) {
      throw new Error(`Could not hash '${file.file}': ${messageOf(error)}`);
    }
    prepared.push({
      canonical: canonicalPath(parsed.root, file.file),
      area: file.area,
      print,
      rows: buildFileRows(file, parsed.root, knownIds),
    });
  }
  return prepared;
}

async function swapIntoPlace(
  root: string,
  target: string,
  staging: string,
): Promise<void> {
  await rm(indexOldPath(root), { force: true });
  if (await fileExists(target)) await rename(target, indexOldPath(root));
  await rename(staging, target);
  await rm(indexOldPath(root), { force: true });
}

export function validateIndex(
  database: WorkspaceDatabase,
  expectedFiles: number,
  staging: string,
): IndexCounts {
  const counts: IndexCounts = {
    files: countRows(database, 'files'),
    objects: countRows(database, 'objects'),
    references: countRows(database, '"references"'),
    repositories: countRows(database, 'repositories'),
    documents: countRows(database, 'documents_fts'),
  };
  const orphan = database.get<{ id: string }>(
    'SELECT id FROM objects WHERE path NOT IN (SELECT path FROM files) LIMIT 1',
  );
  const outside = database.get<{ source: string }>(
    'SELECT source FROM "references" WHERE target NOT IN (SELECT id FROM objects UNION SELECT id FROM repositories) LIMIT 1',
  );
  if (counts.files !== expectedFiles) {
    throw new Error(
      `Index validation failed for ${staging}: expected ${String(expectedFiles)} file rows, found ${String(counts.files)}.`,
    );
  }
  if (counts.documents !== counts.objects) {
    throw new Error(
      `Index validation failed for ${staging}: ${String(counts.documents)} documents for ${String(counts.objects)} objects.`,
    );
  }
  if (orphan !== undefined) {
    throw new Error(
      `Index validation failed for ${staging}: object '${orphan.id}' has no matching file row.`,
    );
  }
  if (outside !== undefined) {
    throw new Error(
      `Index validation failed for ${staging}: reference from '${outside.source}' points outside the index.`,
    );
  }
  return counts;
}

export function countRows(database: WorkspaceDatabase, table: string): number {
  return (
    database.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0
  );
}

function failure(
  target: string,
  error: unknown,
  earlier: Diagnostic[] = [],
): IndexResult {
  return {
    indexPath: target,
    rebuilt: false,
    counts: {
      files: 0,
      objects: 0,
      references: 0,
      repositories: 0,
      documents: 0,
    },
    diagnostics: [
      ...earlier,
      diagnostic(
        target,
        'index.rebuild_failed',
        'error',
        `The index rebuild failed; the previous valid index was left in place: ${messageOf(error)}`,
      ),
    ],
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
