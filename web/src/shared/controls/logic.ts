// Pure helpers for the shared controls. Components import these so the
// decision logic can be unit tested without rendering a DOM.

export function classNames(
  ...values: readonly (string | false | null | undefined)[]
): string {
  return values
    .filter(
      (value): value is string => typeof value === 'string' && value !== '',
    )
    .join(' ');
}

// ————— filterable menu items —————

export interface OptionItem {
  id: string;
  label: string;
  keywords?: readonly string[] | undefined;
  disabled?: boolean | undefined;
}

export function matchesQuery(item: OptionItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  if (item.label.toLowerCase().includes(needle)) return true;
  const keywords = item.keywords ?? [];
  return keywords.some((keyword) => keyword.toLowerCase().includes(needle));
}

export function filterItems<T extends OptionItem>(
  items: readonly T[],
  query: string,
): T[] {
  if (query.trim() === '') return items.slice();
  return items.filter((item) => matchesQuery(item, query));
}

// Two-stage Escape for a filter menu: an entered query clears first, and a
// second Escape (empty query) closes the menu.
export function escapeAction(query: string): 'clear' | 'close' {
  return query.length > 0 ? 'clear' : 'close';
}

// ————— multi-select —————

export const labelSeparator = ' · ';

export function multiSelectLabel(base: string, count: number): string {
  return count > 0 ? `${base}${labelSeparator}${String(count)}` : base;
}

export function toggleSelection(
  selected: readonly string[],
  id: string,
): string[] {
  if (selected.includes(id)) return selected.filter((entry) => entry !== id);
  return [...selected, id];
}

export function selectedCount(selected: readonly string[]): number {
  return selected.length;
}

// ————— rename titles —————

export type RenameIntent = 'commit' | 'cancel';

// Commit keeps the trimmed value, but an empty or whitespace-only edit is not
// a commit: the original title is restored. Cancel always restores.
export function resolveRenameValue(
  original: string,
  value: string,
  intent: RenameIntent,
): string {
  if (intent === 'cancel') return original;
  const next = value.trim();
  return next === '' ? original : next;
}

// ————— backend icons —————

export type BackendIconKind = 'cloud' | 'terminal' | 'plug';

// openai drives an OpenAI-compatible endpoint (cloud), opencode is the local
// OpenCode CLI (terminal), and agent drives an ACP harness over stdio (plug).
// Long agent-* style names fall through to terminal, as does anything unknown.
export function backendIconKind(type: string): BackendIconKind {
  if (type === 'openai') return 'cloud';
  if (type === 'agent') return 'plug';
  return 'terminal';
}
