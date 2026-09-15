import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { WorkspaceDatabase } from './database.js';

export const SCHEMA_VERSION = 1;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export interface MigrationOutcome {
  applied: number[];
  diagnostics: Diagnostic[];
}

const initialSchema = `
CREATE TABLE files (
  path TEXT NOT NULL PRIMARY KEY,
  area TEXT NOT NULL,
  mtime_ms REAL NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL
);

CREATE TABLE objects (
  id TEXT NOT NULL PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  summary TEXT,
  path TEXT NOT NULL,
  metadata TEXT NOT NULL
);

CREATE TABLE "references" (
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (source, target, relation)
);

CREATE TABLE repositories (
  id TEXT NOT NULL PRIMARY KEY,
  path TEXT NOT NULL,
  source_path TEXT NOT NULL
);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title,
  summary,
  keywords,
  body,
  path UNINDEXED,
  object_id UNINDEXED
);
`;

export const migrations: Migration[] = [
  { version: 1, name: 'initial', sql: initialSchema },
];

export function runMigrations(
  database: WorkspaceDatabase,
  file: string,
): MigrationOutcome {
  createVersionTable(database);
  let recorded = recordedVersion(database);
  if (recorded === null) {
    database.run('INSERT INTO schema_version (version) VALUES (0)');
    recorded = 0;
  }
  if (recorded > SCHEMA_VERSION) {
    return {
      applied: [],
      diagnostics: [
        diagnostic(
          file,
          'index.schema_version_unknown',
          'error',
          `The index records schema version ${recorded}, but this build only understands up to version ${SCHEMA_VERSION}. Rebuild the index with a newer version of FieldWork.`,
        ),
      ],
    };
  }
  const pending = migrations.filter(
    (migration) => migration.version > recorded,
  );
  const applied: number[] = [];
  for (const migration of pending) {
    database.transaction(() => {
      database.exec(migration.sql);
      database.run('UPDATE schema_version SET version = ?', migration.version);
    });
    applied.push(migration.version);
  }
  return { applied, diagnostics: [] };
}

function createVersionTable(database: WorkspaceDatabase): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)',
  );
}

function recordedVersion(database: WorkspaceDatabase): number | null {
  const row = database.get<{ version: number }>(
    'SELECT version FROM schema_version',
  );
  return row === undefined ? null : row.version;
}
