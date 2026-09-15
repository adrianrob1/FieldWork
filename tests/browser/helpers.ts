// Small pure extractors shared by the browser specs. API bodies arrive as
// unknown, so every helper is defensive and returns null/[] rather than
// throwing, which keeps test failures about the assertion, not the parsing.

export function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// GET /api/drafts/:id nests the record as { draft: { draft, contentHash } }.
export function draftRecord(body: unknown): Record<string, unknown> | null {
  const outer = recordOf(recordOf(body)?.draft);
  if (outer === null) return null;
  return recordOf(outer.draft) ?? outer;
}

// GET /api/drafts returns { drafts: [{ draft, contentHash, route }] }.
export function draftList(body: unknown): Array<Record<string, unknown>> {
  const drafts: unknown = recordOf(body)?.drafts;
  if (!Array.isArray(drafts)) return [];
  return drafts
    .map((entry: unknown) => draftRecord({ draft: entry }))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export function stringListOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function chatProjects(body: unknown): string[] {
  return stringListOf(recordOf(body)?.projects);
}

export function chatPath(body: unknown): string | null {
  const value = recordOf(body)?.path;
  return typeof value === 'string' ? value : null;
}

export function fileBody(body: unknown): string {
  const value = recordOf(body)?.body;
  return typeof value === 'string' ? value : '';
}

export function fileHash(body: unknown): string | null {
  const value = recordOf(body)?.contentHash;
  return typeof value === 'string' ? value : null;
}

export function taskList(body: unknown): Array<Record<string, unknown>> {
  const tasks: unknown = recordOf(body)?.tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .map((entry: unknown) => recordOf(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

export function taskRecord(body: unknown): Record<string, unknown> | null {
  return recordOf(recordOf(body)?.task);
}
