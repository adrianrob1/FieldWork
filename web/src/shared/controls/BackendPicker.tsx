import { useEffect, useState, type ReactNode } from 'react';

import { getJson } from '../api.js';
import { FilterMenu, MenuItem } from './Menu.js';
import {
  backendIconKind,
  classNames,
  labelSeparator,
  type BackendIconKind,
  type OptionItem,
} from './logic.js';

export interface BackendOption {
  name: string;
  type: string;
  model: string | null;
  isDefault: boolean;
  status: string;
  credentialReady: boolean;
}

export interface BackendsSnapshot {
  backends: BackendOption[];
  default: string | null;
}

export interface BackendPickerProps {
  value: string | null;
  onChange: (name: string | null) => void;
  // When provided, these win over the fetched backend list.
  backends?: readonly BackendOption[] | undefined;
  defaultName?: string | null | undefined;
  ariaLabel?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  testId?: string | undefined;
  // 'bottom' opens below (default); 'top' opens upward for docked composers.
  placement?: 'top' | 'bottom' | undefined;
}

interface BackendMenuItem extends OptionItem {
  kind: 'default' | 'backend';
  backendType: string;
  model: string | null;
  credentialReady: boolean;
  status: string;
}

export const backendDefaultId = '__default__';

let cachedBackends: BackendsSnapshot | null = null;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toBackendOptions(data: unknown): BackendsSnapshot {
  if (typeof data !== 'object' || data === null) {
    return { backends: [], default: null };
  }
  const record = data as Record<string, unknown>;
  const list = Array.isArray(record.backends) ? record.backends : [];
  const backends: BackendOption[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const name = typeof item.name === 'string' ? item.name : null;
    if (name === null || name === '') continue;
    backends.push({
      name,
      type: typeof item.type === 'string' ? item.type : '',
      model: stringOrNull(item.model),
      isDefault: item.isDefault === true,
      status: typeof item.status === 'string' ? item.status : '',
      credentialReady: item.credentialReady === true,
    });
  }
  return {
    backends,
    default: stringOrNull(record.default),
  };
}

export function BackendIcon({
  kind,
  size = 14,
}: {
  kind: BackendIconKind;
  size?: number | undefined;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (kind === 'cloud') {
    return (
      <svg {...common}>
        <path d="M6.5 19a4.5 4.5 0 01-.42-8.98 6 6 0 0111.62-1.7A4 4 0 0117.5 19h-11z" />
      </svg>
    );
  }
  if (kind === 'plug') {
    return (
      <svg {...common}>
        <path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 01-5 5 5 5 0 01-5-5zM12 16v5" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  );
}

function backendLabel(backend: BackendOption | undefined): string {
  if (backend === undefined) return 'Workspace default';
  return backend.model ?? backend.name;
}

export function BackendPicker({
  value,
  onChange,
  backends,
  defaultName,
  ariaLabel = 'Backend',
  disabled = false,
  className,
  testId,
  placement,
}: BackendPickerProps) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<BackendsSnapshot | null>(
    cachedBackends,
  );

  useEffect(() => {
    if (!open || backends !== undefined) return;
    if (cachedBackends !== null) {
      setFetched(cachedBackends);
      return;
    }
    let active = true;
    void getJson<unknown>('/api/backends').then((outcome) => {
      if (!active) return;
      const snapshot = outcome.ok
        ? toBackendOptions(outcome.data)
        : { backends: [], default: null };
      cachedBackends = snapshot;
      setFetched(snapshot);
    });
    return () => {
      active = false;
    };
  }, [open, backends]);

  const list = backends ?? fetched?.backends ?? [];
  const resolvedDefault = defaultName ?? fetched?.default ?? null;
  const defaultBackend = list.find((entry) => entry.name === resolvedDefault);
  const current = list.find((entry) => entry.name === value);
  const currentType =
    value === null ? (defaultBackend?.type ?? '') : (current?.type ?? '');

  const items: BackendMenuItem[] = [
    {
      id: backendDefaultId,
      label:
        resolvedDefault === null
          ? 'Workspace default'
          : `Workspace default (${resolvedDefault})`,
      keywords: ['workspace', 'default', resolvedDefault ?? ''],
      kind: 'default',
      backendType: defaultBackend?.type ?? '',
      model: defaultBackend?.model ?? null,
      credentialReady: defaultBackend?.credentialReady ?? true,
      status: defaultBackend?.status ?? '',
    },
    ...list.map((entry): BackendMenuItem => ({
      id: entry.name,
      label: entry.name,
      keywords: [entry.name, entry.model ?? '', entry.type],
      kind: 'backend',
      backendType: entry.type,
      model: entry.model,
      credentialReady: entry.credentialReady,
      status: entry.status,
    })),
  ];

  const triggerLabel =
    value === null
      ? backendLabel(defaultBackend ?? list.find((e) => e.isDefault))
      : (current?.model ?? current?.name ?? value);

  return (
    <FilterMenu
      items={items}
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      align="left"
      placement={placement}
      placeholder="Filter backends"
      menuTestId={testId}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className={classNames('bpk', className)}
          disabled={disabled}
          title={ariaLabel + labelSeparator + triggerLabel}
          data-testid="backend-picker"
        >
          <BackendIcon kind={backendIconKind(currentType)} size={13} />
          <span>{triggerLabel}</span> <span className="ct">▾</span>
        </button>
      )}
      renderItem={(item) => {
        const selected =
          item.kind === 'default' ? value === null : item.id === value;
        const iconKind = backendIconKind(item.backendType);
        let hint: ReactNode;
        if (selected) {
          hint = 'active';
        } else if (!item.credentialReady) {
          hint = <span className="ready warn" />;
        }
        return (
          <MenuItem
            key={item.id}
            icon={<BackendIcon kind={iconKind} />}
            label={item.kind === 'default' ? item.label : item.id}
            sublabel={
              item.kind === 'backend' && item.model !== null
                ? item.model
                : undefined
            }
            selected={selected}
            role="menuitemradio"
            hint={hint}
            testId={`menu-item-${item.id}`}
            onSelect={() => {
              onChange(item.kind === 'default' ? null : item.id);
              setOpen(false);
            }}
          />
        );
      }}
    />
  );
}
