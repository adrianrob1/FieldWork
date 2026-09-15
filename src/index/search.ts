import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { openDatabase, type WorkspaceDatabase } from './database.js';
import { fileExists, indexPath, recoverIndexFiles } from './paths.js';

export type SearchScope =
  | { kind: 'workspace' }
  | { kind: 'project'; projectId: string }
  | { kind: 'topic'; topic: string }
  | { kind: 'path'; prefix: string };

export interface SearchHit {
  path: string;
  objectId: string | null;
  type: string | null;
  title: string | null;
  rank: number;
  snippet: string;
}

export interface SearchResult {
  hits: SearchHit[];
  diagnostics: Diagnostic[];
}

interface HitRow {
  path: string;
  object_id: string;
  type: string | null;
  title: string | null;
  rank: number;
  snippet: string;
}

export async function searchIndex(
  source: string | WorkspaceDatabase,
  query: string,
  scope: SearchScope = { kind: 'workspace' },
): Promise<SearchResult> {
  if (typeof source !== 'string') {
    return runSearch(source, query, scope, source.file);
  }
  const root = path.resolve(source);
  const target = indexPath(root);
  await recoverIndexFiles(root);
  if (!(await fileExists(target))) {
    return {
      hits: [],
      diagnostics: [
        diagnostic(
          target,
          'index.missing',
          'error',
          'The workspace index does not exist; rebuild it first.',
        ),
      ],
    };
  }
  const database = openDatabase(target, { readonly: true });
  try {
    return runSearch(database, query, scope, target);
  } finally {
    database.close();
  }
}

function runSearch(
  database: WorkspaceDatabase,
  query: string,
  scope: SearchScope,
  file: string,
): SearchResult {
  const match = escapeQuery(query);
  if (match === null) return { hits: [], diagnostics: [] };

  const diagnostics: Diagnostic[] = [];
  const conditions: string[] = [];
  const params: unknown[] = [match];
  if (scope.kind === 'project') {
    const project = database.get<{ path: string; type: string }>(
      "SELECT path, type FROM objects WHERE id = ? AND type = 'project'",
      scope.projectId,
    );
    if (project === undefined) {
      return {
        hits: [],
        diagnostics: [
          diagnostic(
            file,
            'project.missing',
            'error',
            `Project '${scope.projectId}' was not found in this workspace.`,
          ),
        ],
      };
    }
    const tree = `${path.posix.dirname(project.path)}/`;
    conditions.push(
      `(documents_fts.path LIKE ? ESCAPE '\\' OR documents_fts.object_id IN (SELECT source FROM "references" WHERE target = ?))`,
    );
    params.push(escapeLike(tree) + '%', scope.projectId);
  } else if (scope.kind === 'topic') {
    conditions.push(
      `EXISTS (SELECT 1 FROM json_each(objects.metadata, '$.topics') WHERE json_each.value = ?)`,
    );
    params.push(scope.topic);
  } else if (scope.kind === 'path') {
    const prefix = scope.prefix.replace(/\\/g, '/').replace(/\/+$/, '');
    conditions.push(
      `(documents_fts.path = ? OR documents_fts.path LIKE ? ESCAPE '\\')`,
    );
    params.push(prefix, escapeLike(`${prefix}/`) + '%');
  }

  const where =
    conditions.length === 0 ? '' : ` AND ${conditions.join(' AND ')}`;
  const sql = `
    SELECT documents_fts.path AS path,
           documents_fts.object_id AS object_id,
           objects.type AS type,
           objects.title AS title,
           documents_fts.rank AS rank,
           snippet(documents_fts, -1, '[', ']', ' … ', 12) AS snippet
    FROM documents_fts
    LEFT JOIN objects ON objects.id = documents_fts.object_id
    WHERE documents_fts MATCH ?${where}
    ORDER BY documents_fts.rank, documents_fts.path
  `;
  try {
    const rows = database.all<HitRow>(sql, ...params);
    return {
      hits: rows.map((row) => ({
        path: row.path,
        objectId: row.object_id === '' ? null : row.object_id,
        type: row.type,
        title: row.title,
        rank: row.rank,
        snippet: row.snippet,
      })),
      diagnostics,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /fts5|syntax/i.test(message)
      ? 'index.query_invalid'
      : 'index.query_failed';
    diagnostics.push(
      diagnostic(file, code, 'error', `The search query failed: ${message}`),
    );
    return { hits: [], diagnostics };
  }
}

export function escapeQuery(query: string): string | null {
  const terms = query.split(/\s+/).filter((term) => term.length > 0);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' ');
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
