import { Fragment, type ReactNode, type RefObject } from 'react';

import { Link, useBack } from '../router.js';
import { searchShortcutLabel } from '../shortcut.js';
import { useTheme } from '../theme.js';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface TitleBarProps {
  title: string;
  breadcrumb: BreadcrumbItem[];
  parentPath: string;
  actions?: ReactNode;
  drawerOpen: boolean;
  onOpenDrawer: () => void;
  drawerButtonRef: RefObject<HTMLButtonElement | null>;
}

const menuIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

const backIcon = (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M19 12H5M12 19l-7-7 7-7" />
  </svg>
);

export function TitleBar({
  title,
  breadcrumb,
  parentPath,
  actions,
  drawerOpen,
  onOpenDrawer,
  drawerButtonRef,
}: TitleBarProps) {
  const [theme, toggleAt] = useTheme();
  const back = useBack(parentPath);
  const themeLabel = theme === 'dark' ? 'Light theme' : 'Dark theme';
  return (
    <header className="titlebar" data-testid="titlebar">
      <button
        ref={drawerButtonRef}
        className="mbtn"
        type="button"
        data-testid="drawer-button"
        aria-label="Open menu"
        aria-expanded={drawerOpen}
        onClick={onOpenDrawer}
      >
        {menuIcon}
      </button>
      <a
        className="mbtn"
        href={back.href}
        data-testid="back-button"
        aria-label="Go back"
        onClick={back.onClick}
      >
        {backIcon}
      </a>
      <span className="mtitle">{title}</span>
      <Link className="brand" to="/" title="Back to workspace overview">
        <span className="sq">F</span>FieldWork
      </Link>
      <span className="crumb" data-testid="breadcrumbs">
        {'/ '}
        {breadcrumb.map((item, index) => (
          <Fragment key={`${item.label}-${String(index)}`}>
            {item.href === undefined ? (
              item.label
            ) : (
              <Link to={item.href}>{item.label}</Link>
            )}
            {' / '}
          </Fragment>
        ))}
        <b>{title}</b>
      </span>
      <div className="tools">
        {actions}
        <Link
          className="tsearch"
          to="/search"
          data-testid="search-button"
          aria-label="Search"
        >
          Search · {searchShortcutLabel()}
        </Link>
        <button
          className="tbtn"
          type="button"
          data-testid="theme-toggle"
          aria-label={`Switch to ${themeLabel.toLowerCase()}`}
          onClick={toggleAt}
        >
          <i />
          <span>{themeLabel}</span>
        </button>
        <Link
          className="btn primary sm"
          to="/chats/new"
          data-testid="new-chat-button"
        >
          New chat
        </Link>
      </div>
    </header>
  );
}
