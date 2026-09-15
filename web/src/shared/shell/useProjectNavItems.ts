import { useProjectCatalog } from '../projects/useProjectCatalog.js';

export interface ProjectNavItem {
  id: string;
  title: string;
  chatCount: number;
}

// Sidebar/drawer project group data. Hidden silently while the catalog loads
// or fails, so the nav never shows a broken group. AppShell calls this once
// and passes the items to both SideNav and Drawer.
export function useProjectNavItems(): ProjectNavItem[] {
  const { status, projects, details } = useProjectCatalog();
  if (status !== 'ready') return [];
  return projects.map((project) => ({
    id: project.id,
    title: project.title,
    chatCount: details[project.id]?.chatCount ?? 0,
  }));
}
