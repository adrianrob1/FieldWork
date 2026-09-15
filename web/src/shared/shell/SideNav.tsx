import { Link, navNameForRoute, useRoute, type NavName } from '../router.js';
import { useShellCounts, type ShellCounts } from './useShellCounts.js';
import type { ProjectNavItem } from './useProjectNavItems.js';

interface NavItem {
  name: NavName;
  label: string;
  href: string;
  icon: string;
  count?: keyof ShellCounts;
}

const workspaceItems: NavItem[] = [
  { name: 'overview', label: 'Overview', href: '/', icon: '⌂' },
  {
    name: 'projects',
    label: 'Projects',
    href: '/projects',
    icon: '▦',
    count: 'projects',
  },
  { name: 'chats', label: 'Chats', href: '/chats', icon: '◔', count: 'chats' },
  { name: 'tasks', label: 'Tasks', href: '/tasks', icon: '☑', count: 'tasks' },
  { name: 'inbox', label: 'Inbox', href: '/inbox', icon: '◫', count: 'inbox' },
  { name: 'search', label: 'Search', href: '/search', icon: '⌕' },
];

const systemItems: NavItem[] = [
  { name: 'settings', label: 'Settings', href: '/settings', icon: '◌' },
];

function SideNavLink({
  item,
  active,
  counts,
}: {
  item: NavItem;
  active: NavName | null;
  counts: ShellCounts;
}) {
  const count = item.count === undefined ? null : counts[item.count];
  return (
    <Link
      className={active === item.name ? 'on' : undefined}
      data-testid={`nav-item-${item.name}`}
      to={item.href}
    >
      <span>
        <span className="ic">{item.icon}</span>
        {item.label}
      </span>
      {count !== null && <span className="n">{count}</span>}
    </Link>
  );
}

export function SideNav({ projects }: { projects: readonly ProjectNavItem[] }) {
  const route = useRoute();
  const counts = useShellCounts();
  const active = navNameForRoute(route.name);
  return (
    <nav className="side" data-testid="nav" aria-label="Workspace">
      <div className="grp">
        <p className="lbl">Workspace</p>
        {workspaceItems.map((item) => (
          <SideNavLink
            key={item.name}
            item={item}
            active={active}
            counts={counts}
          />
        ))}
      </div>
      {projects.length > 0 && (
        <div className="grp" data-testid="nav-projects">
          <p className="lbl">Projects</p>
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/projects/${project.id}`}
              data-testid={`nav-item-project-${project.id}`}
            >
              <span>
                <span className="ic">▣</span>
                {project.title}
              </span>
              <span className="n">{project.chatCount}</span>
            </Link>
          ))}
        </div>
      )}
      <div className="grp">
        <p className="lbl">System</p>
        {systemItems.map((item) => (
          <SideNavLink
            key={item.name}
            item={item}
            active={active}
            counts={counts}
          />
        ))}
      </div>
    </nav>
  );
}
