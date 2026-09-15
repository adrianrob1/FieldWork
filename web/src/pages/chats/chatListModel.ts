import type { OptionItem } from '../../shared/controls/index.js';

// Pure decisions behind the chat list pane: how a filter view maps to the API
// route that feeds it, which tab is active, and where a draft row should open
// on a given viewport. Kept fetch-free so the browser wiring stays thin and the
// behavior is unit-testable.

export type ChatFilterView =
  | { kind: 'all' }
  | { kind: 'unassigned' }
  | { kind: 'project'; projectId: string };

export type ChatFilterTab = ChatFilterView['kind'];

export interface ChatProjectOption {
  id: string;
  label: string;
}

// The breakpoint the draft-row target is decided at. Below it /chats is a pure
// list, so a draft opens on the dedicated /chats/new route; at or above it the
// embedded panel can show the draft in the two-pane layout.
export const mobileDraftMediaQuery = '(max-width: 719px)';

export function chatListViewUrl(view: ChatFilterView): string {
  switch (view.kind) {
    case 'all':
      return '/api/chats?view=all';
    case 'unassigned':
      return '/api/chats?view=unassigned';
    case 'project':
      return `/api/chats?view=project&project=${encodeURIComponent(
        view.projectId,
      )}`;
  }
}

export function chatFilterTabActive(
  view: ChatFilterView,
  tab: ChatFilterTab,
): boolean {
  return view.kind === tab;
}

export function filterTabLabel(
  tab: 'all' | 'unassigned',
  count: number,
): string {
  return tab === 'all' ? `All · ${count}` : `Unassigned · ${count}`;
}

export interface ChatFilterCounts {
  all: number;
  unassigned: number;
}

// The two live tab counts come from their own (always mounted) view fetches.
export function chatFilterCounts(input: {
  all: readonly unknown[];
  unassigned: readonly unknown[];
}): ChatFilterCounts {
  return { all: input.all.length, unassigned: input.unassigned.length };
}

// Which route a stored draft row opens. `mobile` is the matchMedia result for
// `mobileDraftMediaQuery`, decided at click time.
export function draftRoute(draftId: string, mobile: boolean): string {
  const id = encodeURIComponent(draftId);
  return mobile ? `/chats/new?draft=${id}` : `/chats?draft=${id}`;
}

export function projectTitlesOf(data: unknown): Map<string, string> {
  const map = new Map<string, string>();
  for (const option of projectOptionsOf(data)) {
    map.set(option.id, option.label);
  }
  return map;
}

export function projectOptionsOf(data: unknown): ChatProjectOption[] {
  if (typeof data !== 'object' || data === null) return [];
  const list = (data as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return [];
  const options: ChatProjectOption[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string') continue;
    options.push({
      id: record.id,
      label:
        typeof record.title === 'string' && record.title !== ''
          ? record.title
          : record.id,
    });
  }
  return options;
}

export function toProjectOptionItems(
  options: readonly ChatProjectOption[],
): OptionItem[] {
  return options.map((option) => ({ id: option.id, label: option.label }));
}
