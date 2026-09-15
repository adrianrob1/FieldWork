import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { bodyClassForRoute, navigate, useRoute } from '../router.js';
import { isSearchShortcut } from '../shortcut.js';
import { Drawer } from './Drawer.js';
import { SideNav } from './SideNav.js';
import { TitleBar, type BreadcrumbItem } from './TitleBar.js';
import { useProjectNavItems } from './useProjectNavItems.js';

export type { BreadcrumbItem } from './TitleBar.js';

// Each page renders its own AppShell, so a route change between pages mounts a
// fresh shell. This module flag distinguishes the very first shell mount (initial
// page load, where autofocus owns focus) from later navigations.
let appShellMounted = false;

export interface AppShellProps {
  breadcrumb: BreadcrumbItem[];
  title: string;
  parentPath: string;
  list?: ReactNode;
  actions?: ReactNode;
  contentClassName?: string;
  children: ReactNode;
}

export function AppShell({
  breadcrumb,
  title,
  parentPath,
  list,
  actions,
  contentClassName,
  children,
}: AppShellProps) {
  const route = useRoute();
  const projectNavItems = useProjectNavItems();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerButtonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.body.className = bodyClassForRoute(route.name);
    return () => {
      document.body.className = '';
    };
  }, [route.name]);

  useEffect(() => {
    setDrawerOpen(false);
    contentRef.current?.scrollTo({ top: 0 });
    listRef.current?.scrollTo({ top: 0 });
    // SPA navigation can remove the element that owned focus (for example a
    // list row that opens a detail pane). Land focus on the content region so
    // keyboard and screen reader users are not stranded on a detached node.
    // Skip the initial app load, where the page's own autofocus applies.
    const active = document.activeElement;
    const stranded =
      active === null ||
      active === document.body ||
      !document.body.contains(active);
    if (appShellMounted && stranded) {
      contentRef.current?.focus({ preventScroll: true });
    }
    appShellMounted = true;
  }, [route.pathname, route.search]);

  useEffect(() => {
    document.title = `${title} · FieldWork`;
  }, [title]);

  useEffect(() => {
    if (drawerOpen) {
      document.body.classList.add('menu-open');
    } else {
      document.body.classList.remove('menu-open');
    }
    return () => {
      document.body.classList.remove('menu-open');
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        drawerButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isSearchShortcut(event)) return;
      event.preventDefault();
      if (route.name === 'search') {
        const input = document.querySelector<HTMLElement>(
          '[data-testid="search-input"]',
        );
        input?.focus();
        if (input instanceof HTMLInputElement) input.select();
        return;
      }
      navigate('/search');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [route.name]);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    drawerButtonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="app">
        <TitleBar
          title={title}
          breadcrumb={breadcrumb}
          parentPath={parentPath}
          actions={actions}
          drawerOpen={drawerOpen}
          onOpenDrawer={openDrawer}
          drawerButtonRef={drawerButtonRef}
        />
        <div className="panes">
          <SideNav projects={projectNavItems} />
          {list !== undefined && (
            <aside className="list" data-testid="list-pane" ref={listRef}>
              {list}
            </aside>
          )}
          <main
            className={
              contentClassName === undefined
                ? 'content'
                : `content ${contentClassName}`
            }
            data-testid="content-pane"
            aria-label={title}
            tabIndex={-1}
            ref={contentRef}
          >
            {children}
          </main>
        </div>
      </div>
      <Drawer
        open={drawerOpen}
        onClose={closeDrawer}
        projects={projectNavItems}
      />
    </>
  );
}
