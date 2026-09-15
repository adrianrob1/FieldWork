import { useEffect, useRef } from 'react';

import { Link, navNameForRoute, useRoute, type NavName } from '../router.js';
import { useTheme } from '../theme.js';
import { useShellCounts, type ShellCounts } from './useShellCounts.js';
import type { ProjectNavItem } from './useProjectNavItems.js';

interface DrawerItem {
  name: NavName;
  label: string;
  href: string;
  count?: keyof ShellCounts;
}

const drawerItems: DrawerItem[] = [
  { name: 'search', label: 'Search', href: '/search' },
  { name: 'overview', label: 'Overview', href: '/' },
  { name: 'projects', label: 'Projects', href: '/projects', count: 'projects' },
  { name: 'chats', label: 'Chats', href: '/chats', count: 'chats' },
  { name: 'tasks', label: 'Tasks', href: '/tasks', count: 'tasks' },
  { name: 'inbox', label: 'Inbox', href: '/inbox', count: 'inbox' },
  { name: 'settings', label: 'Settings', href: '/settings' },
];

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  projects: readonly ProjectNavItem[];
}

export function Drawer({ open, onClose, projects }: DrawerProps) {
  const route = useRoute();
  const counts = useShellCounts();
  const [theme, toggleAt] = useTheme();
  const containerRef = useRef<HTMLElement | null>(null);
  const active = navNameForRoute(route.name);
  const themeLabel = theme === 'dark' ? 'Light theme' : 'Dark theme';

  useEffect(() => {
    if (!open) return;
    const first =
      containerRef.current?.querySelector<HTMLElement>('.dgrp a, .dacts a');
    first?.focus();
  }, [open]);

  return (
    <>
      <div
        className={`scrim${open ? ' open' : ''}`}
        data-scrim
        onClick={onClose}
      />
      <nav
        ref={containerRef}
        className={`drawer${open ? ' open' : ''}`}
        data-drawer
        data-testid="drawer"
        aria-label="Workspace menu"
        aria-hidden={!open}
        inert={!open}
      >
        <div className="dhead">
          <span>Menu</span>
          <button
            className="x"
            type="button"
            aria-label="Close menu"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className="dgrp">
          <p className="lbl">Workspace</p>
          {drawerItems.map((item) => {
            const count = item.count === undefined ? null : counts[item.count];
            return (
              <Link
                key={item.name}
                className={active === item.name ? 'on' : undefined}
                to={item.href}
                onClick={onClose}
              >
                {item.label}
                {count !== null && <span className="n">{count}</span>}
              </Link>
            );
          })}
        </div>
        {projects.length > 0 && (
          <div className="dgrp" data-testid="nav-projects">
            <p className="lbl">Projects</p>
            {projects.map((project) => (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                onClick={onClose}
                data-testid={`nav-item-project-${project.id}`}
              >
                {project.title}
                <span className="n">{project.chatCount}</span>
              </Link>
            ))}
          </div>
        )}
        <div className="dacts">
          <Link className="btn primary block" to="/chats/new" onClick={onClose}>
            New chat
          </Link>
          <button
            className="tbtn"
            type="button"
            data-theme-toggle
            aria-label={`Switch to ${themeLabel.toLowerCase()}`}
            onClick={toggleAt}
          >
            <i />
            <span>{themeLabel}</span>
          </button>
        </div>
      </nav>
    </>
  );
}
