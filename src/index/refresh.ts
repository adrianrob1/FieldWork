import { stat } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  discoverWorkspaceFiles,
  parseWorkspaceFile,
  type DiscoveredWorkspaceFile,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { countRows, rebuildIndex, type RebuildOptions } from './build.js';
import { openDatabase, type WorkspaceDatabase } from './database.js';
import { runMigrations } from './migrations.js';
import { fileExists, indexPath, recoverIndexFiles } from './paths.js';
import type { IndexCounts, IndexResult } from './result.js';
import {
  buildFileRows,
  buildReferenceRows,
  canonicalPath,
  deleteFileRows,
  fingerprint,
  insertDocumentRow,
  insertFileRows,
  insertReferenceRows,
  insertRepositoryRows,
  knownIdsFromIndex,
  type FileFingerprint,
  type FileRows,
  type ReferenceRow,
} from './rows.js';

interface FileStateRow {
  path: string;
  mtime: number;
  size: number;
  hash: string;
}

interface ReparsedFile {
  file: ParsedWorkspaceFile;
  canonical: string;
  print: FileFingerprint;
  rows: FileRows;
}

export async function refreshIndex(
  root: string,
  options: RebuildOptions = {},
): Promise<IndexResult> {
  const workspaceRoot = path.resolve(root);
  const target = indexPath(workspaceRoot);
  await recoverIndexFiles(workspaceRoot);
  if (!(await fileExists(target))) {
    return rebuildIndex(workspaceRoot, options);
  }

  const diagnostics: Diagnostic[] = [];
  const database = openDatabase(target);
  try {
    const migration = runMigrations(database, target);
    diagnostics.push(...migration.diagnostics);
    if (diagnostics.some((entry) => entry.severity === 'error')) {
      return result(target, database, diagnostics);
    }

    const recorded = database.all<FileStateRow>(
      'SELECT path, mtime_ms AS mtime, size, hash FROM files',
    );
    const removed: string[] = [];
    const changed = new Set<string>();
    for (const row of recorded) {
      const absolute = path.resolve(workspaceRoot, fromStored(row.path));
      const stats = await statOrNull(absolute);
      if (stats === null) {
        removed.push(row.path);
        continue;
      }
      if (stats.size === row.size && stats.mtimeMs === row.mtime) continue;
      const print = await fingerprint(absolute);
      if (print.hash === row.hash) {
        database.run(
          'UPDATE files SET mtime_ms = ?, size = ? WHERE path = ?',
          print.mtimeMs,
          print.size,
          row.path,
        );
      } else {
        changed.add(row.path);
      }
    }

    const candidates = await discoverWorkspaceFiles(workspaceRoot);
    diagnostics.push(...candidates.diagnostics);
    const discovered: DiscoveredWorkspaceFile[] = [...candidates.files];
    if (candidates.settings !== null) {
      discovered.unshift({
        file: candidates.settings.file,
        kind: 'workspace',
        area: candidates.settings.area,
      });
    }
    const recordedPaths = new Set(recorded.map((row) => row.path));
    const removedSet = new Set(removed);
    const reparsed: ReparsedFile[] = [];
    for (const candidate of discovered) {
      const canonical = canonicalPath(workspaceRoot, candidate.file);
      if (removedSet.has(canonical)) continue;
      if (!changed.has(canonical) && recordedPaths.has(canonical)) continue;
      const parsedFile = await parseWorkspaceFile(
        candidate.file,
        candidate.kind,
        candidate.area,
        workspaceRoot,
      );
      reparsed.push({
        file: parsedFile,
        canonical,
        print: await fingerprint(candidate.file),
        rows: buildFileRows(parsedFile, workspaceRoot, null),
      });
    }

    const referenceRows: ReferenceRow[] = [];
    database.transaction(() => {
      for (const canonical of removed) deleteFileRows(database, canonical);
      for (const item of reparsed) deleteFileRows(database, item.canonical);
      for (const item of reparsed) {
        insertFileRows(
          database,
          item.canonical,
          item.file.area,
          item.print,
          item.rows,
        );
        insertRepositoryRows(database, item.rows.repositories);
        if (item.rows.document !== null) {
          insertDocumentRow(database, item.rows.document);
        }
      }
      const knownIds = knownIdsFromIndex(database);
      for (const item of reparsed) {
        if (item.rows.object === null) continue;
        referenceRows.push(
          ...buildReferenceRows(
            item.file,
            item.rows.object.id,
            knownIds,
            item.rows.diagnostics,
          ),
        );
      }
      insertReferenceRows(database, referenceRows);
    });
    for (const item of reparsed) {
      diagnostics.push(...item.file.diagnostics, ...item.rows.diagnostics);
    }
    return result(target, database, diagnostics);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        target,
        'index.refresh_failed',
        'error',
        `The index refresh failed: ${messageOf(error)}`,
      ),
    );
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
      diagnostics,
    };
  } finally {
    database.close();
  }
}

function result(
  target: string,
  database: WorkspaceDatabase,
  diagnostics: Diagnostic[],
): IndexResult {
  return {
    indexPath: target,
    rebuilt: false,
    counts: currentCounts(database),
    diagnostics,
  };
}

function currentCounts(database: WorkspaceDatabase): IndexCounts {
  return {
    files: countRows(database, 'files'),
    objects: countRows(database, 'objects'),
    references: countRows(database, '"references"'),
    repositories: countRows(database, 'repositories'),
    documents: countRows(database, 'documents_fts'),
  };
}

async function statOrNull(file: string): Promise<{
  size: number;
  mtimeMs: number;
} | null> {
  try {
    const stats = await stat(file);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

function fromStored(stored: string): string {
  return stored.split('/').join(path.sep);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
