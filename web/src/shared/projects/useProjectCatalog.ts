import { useCallback, useEffect, useState } from 'react';

import { getJson, type ApiFailure } from '../api.js';
import {
  toProjectDetail,
  toProjectListEntries,
  type ProjectDetail,
  type ProjectListEntry,
} from './catalog.js';

export type ProjectCatalogStatus = 'loading' | 'ready' | 'error';

export interface ProjectCatalog {
  status: ProjectCatalogStatus;
  projects: ProjectListEntry[];
  details: Record<string, ProjectDetail | null>;
  failure: ApiFailure | null;
  reload: () => void;
}

// One request set for the project list plus a fan-out of project details. The
// list resolves first (status becomes ready) and details fill in per project;
// a failed detail stays null so callers can fall back to list-level data. The
// hook is called once per render tree (AppShell for the nav, and once per page
// that renders the catalog).
export function useProjectCatalog(): ProjectCatalog {
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<ProjectCatalogStatus>('loading');
  const [projects, setProjects] = useState<ProjectListEntry[]>([]);
  const [details, setDetails] = useState<Record<string, ProjectDetail | null>>(
    {},
  );
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  useEffect(() => {
    let active = true;
    setStatus('loading');
    setProjects([]);
    setDetails({});
    setFailure(null);
    void (async () => {
      const list = await getJson<unknown>('/api/projects');
      if (!active) return;
      if (!list.ok) {
        setFailure(list.failure);
        setStatus('error');
        return;
      }
      const entries = toProjectListEntries(list.data);
      setProjects(entries);
      setStatus('ready');
      await Promise.all(
        entries.map(async (project) => {
          const outcome = await getJson<unknown>(
            `/api/projects/${encodeURIComponent(project.id)}`,
          );
          if (!active) return;
          setDetails((previous) => ({
            ...previous,
            [project.id]: outcome.ok ? toProjectDetail(outcome.data) : null,
          }));
        }),
      );
    })();
    return () => {
      active = false;
    };
  }, [nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return { status, projects, details, failure, reload };
}
