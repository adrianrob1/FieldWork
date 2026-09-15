import { useEffect, useState } from 'react';

import { getJson } from '../api.js';
import { useRoute } from '../router.js';

export interface ShellCounts {
  projects: number | null;
  chats: number | null;
  tasks: number | null;
  inbox: number | null;
}

const emptyCounts: ShellCounts = {
  projects: null,
  chats: null,
  tasks: null,
  inbox: null,
};

interface WorkspaceCountsResponse {
  counts?: Record<string, number>;
}

interface ChatsResponse {
  chats?: unknown[];
}

interface TasksResponse {
  groups?: {
    active?: unknown[];
    overdue?: unknown[];
    upcoming?: unknown[];
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function useShellCounts(): ShellCounts {
  const route = useRoute();
  const [counts, setCounts] = useState<ShellCounts>(emptyCounts);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [workspace, tasks, chats] = await Promise.all([
        getJson<WorkspaceCountsResponse>('/api/workspace'),
        getJson<TasksResponse>('/api/tasks'),
        getJson<ChatsResponse>('/api/chats?view=unassigned'),
      ]);
      if (cancelled) return;
      setCounts({
        projects: workspace.ok
          ? numberOrNull(workspace.data.counts?.project)
          : null,
        chats: workspace.ok ? numberOrNull(workspace.data.counts?.chat) : null,
        tasks: tasks.ok
          ? numberOrNull(tasks.data.groups?.active?.length)
          : null,
        inbox: chats.ok ? numberOrNull(chats.data.chats?.length) : null,
      });
    })();
    return () => {
      cancelled = true;
    };
    // Keyed by route name, not pathname: switching between chats (or between
    // two projects) keeps the same chrome and must not refetch the badge counts.
  }, [route.name]);

  return counts;
}
