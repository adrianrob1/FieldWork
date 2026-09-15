import {
  useCallback,
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

export type RouteName =
  | 'workspace'
  | 'projects'
  | 'project'
  | 'chats'
  | 'chat-new'
  | 'chat'
  | 'inbox'
  | 'search'
  | 'edit'
  | 'settings'
  | 'tasks'
  | 'not-found';

export type NavName =
  'overview' | 'projects' | 'chats' | 'tasks' | 'inbox' | 'search' | 'settings';

export interface RouteMatch {
  name: RouteName;
  params: Record<string, string>;
}

export interface RouteInfo {
  pathname: string;
  search: string;
  name: RouteName;
  params: Record<string, string>;
  query: URLSearchParams;
}

interface RoutePattern {
  name: RouteName;
  segments: string[];
}

const routePatterns: RoutePattern[] = [
  { name: 'workspace', segments: [] },
  { name: 'projects', segments: ['projects'] },
  { name: 'project', segments: ['projects', ':id'] },
  { name: 'chats', segments: ['chats'] },
  { name: 'chat-new', segments: ['chats', 'new'] },
  { name: 'chat', segments: ['chats', ':id'] },
  { name: 'inbox', segments: ['inbox'] },
  { name: 'search', segments: ['search'] },
  { name: 'edit', segments: ['edit'] },
  { name: 'settings', segments: ['settings'] },
  { name: 'tasks', segments: ['tasks'] },
];

function splitPath(pathname: string): string[] {
  let path = pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '' || path === '/') return [];
  return path.split('/').slice(1);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function matchSegments(
  pattern: string[],
  segments: string[],
): Record<string, string> | null {
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index];
    if (segment === undefined) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeSegment(segment);
      continue;
    }
    if (part !== segment) return null;
  }
  return params;
}

export function matchRoutePath(pathname: string): RouteMatch | null {
  const segments = splitPath(pathname);
  for (const pattern of routePatterns) {
    const params = matchSegments(pattern.segments, segments);
    if (params !== null) return { name: pattern.name, params };
  }
  return null;
}

export function parseRoute(pathname: string, search = ''): RouteInfo {
  const match = matchRoutePath(pathname);
  const query = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  return {
    pathname,
    search,
    name: match?.name ?? 'not-found',
    params: match?.params ?? {},
    query,
  };
}

const listRoutes: ReadonlySet<RouteName> = new Set<RouteName>([
  'chats',
  'tasks',
]);

export function isListRoute(name: RouteName): boolean {
  return listRoutes.has(name);
}

const navNames: Partial<Record<RouteName, NavName>> = {
  workspace: 'overview',
  projects: 'projects',
  project: 'projects',
  chats: 'chats',
  'chat-new': 'chats',
  chat: 'chats',
  tasks: 'tasks',
  inbox: 'inbox',
  search: 'search',
  settings: 'settings',
};

export function navNameForRoute(name: RouteName): NavName | null {
  return navNames[name] ?? null;
}

export function bodyClassForRoute(name: RouteName): string {
  switch (name) {
    case 'chats':
      return 'chatlist';
    case 'chat':
      return 'chatpg';
    case 'chat-new':
      return 'ncpg';
    case 'edit':
      return 'editpg';
    default:
      return '';
  }
}

// ————— external store: current route + in-app history depth —————

let currentRoute: RouteInfo = initialRoute();
let historyDepth = 0;
let popStateAttached = false;
const routeListeners = new Set<() => void>();

function initialRoute(): RouteInfo {
  if (typeof window === 'undefined') return parseRoute('/', '');
  return parseRoute(window.location.pathname, window.location.search);
}

function currentLocation(): RouteInfo {
  if (typeof window === 'undefined') return currentRoute;
  return parseRoute(window.location.pathname, window.location.search);
}

function emitRoute(): void {
  for (const listener of routeListeners) listener();
}

function attachPopState(): void {
  if (popStateAttached || typeof window === 'undefined') return;
  popStateAttached = true;
  window.addEventListener('popstate', () => {
    historyDepth = Math.max(0, historyDepth - 1);
    currentRoute = currentLocation();
    emitRoute();
  });
}

function subscribeRoute(listener: () => void): () => void {
  attachPopState();
  routeListeners.add(listener);
  return () => {
    routeListeners.delete(listener);
  };
}

function routeSnapshot(): RouteInfo {
  return currentRoute;
}

export function inAppHistoryDepth(): number {
  return historyDepth;
}

export function navigate(
  to: string,
  options: { replace?: boolean } = {},
): void {
  if (typeof window === 'undefined') return;
  if (options.replace === true) {
    window.history.replaceState(null, '', to);
  } else {
    window.history.pushState(null, '', to);
    historyDepth += 1;
  }
  currentRoute = currentLocation();
  emitRoute();
}

export function useRoute(): RouteInfo {
  return useSyncExternalStore(subscribeRoute, routeSnapshot, routeSnapshot);
}

export interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> {
  to: string;
  children?: ReactNode;
}

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    if (rest.target !== undefined && rest.target !== '_self') return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a {...rest} href={to} onClick={handleClick}>
      {children}
    </a>
  );
}

export interface BackLink {
  href: string;
  onClick: (event: MouseEvent<HTMLAnchorElement>) => void;
}

export function useBack(parentPath: string): BackLink {
  const onClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      if (typeof window !== 'undefined' && historyDepth > 0) {
        window.history.back();
        return;
      }
      navigate(parentPath);
    },
    [parentPath],
  );
  return { href: parentPath, onClick };
}
