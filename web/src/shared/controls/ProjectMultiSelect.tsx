import { useEffect, useState } from 'react';

import { getJson } from '../api.js';
import { FilterMenu } from './Menu.js';
import {
  classNames,
  multiSelectLabel,
  toggleSelection,
  type OptionItem,
} from './logic.js';

export type ProjectOption = OptionItem;

export interface ProjectMultiSelectProps {
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  // When provided, these win over the fetched project list.
  items?: readonly ProjectOption[] | undefined;
  placeholder?: string | undefined;
  ariaLabel?: string | undefined;
  disabled?: boolean | undefined;
  className?: string | undefined;
  testId?: string | undefined;
}

let cachedProjects: ProjectOption[] | null = null;

function toProjectOptions(data: unknown): ProjectOption[] {
  if (typeof data !== 'object' || data === null) return [];
  const list = (data as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return [];
  const options: ProjectOption[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    const title = typeof record.title === 'string' ? record.title : null;
    if (id === null || title === null) continue;
    options.push({ id, label: title });
  }
  return options;
}

export function ProjectMultiSelect({
  selected,
  onChange,
  items,
  placeholder = 'Projects',
  ariaLabel = 'Projects',
  disabled = false,
  className,
  testId,
}: ProjectMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<ProjectOption[] | null>(
    cachedProjects,
  );

  useEffect(() => {
    if (!open || items !== undefined) return;
    if (cachedProjects !== null) {
      setFetched(cachedProjects);
      return;
    }
    let active = true;
    void getJson<unknown>('/api/projects').then((outcome) => {
      if (!active) return;
      const options = outcome.ok ? toProjectOptions(outcome.data) : [];
      cachedProjects = options;
      setFetched(options);
    });
    return () => {
      active = false;
    };
  }, [open, items]);

  const options = items ?? fetched ?? [];
  const label = multiSelectLabel(placeholder, selected.length);

  return (
    <FilterMenu
      items={options}
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      align="left"
      stack
      placeholder="Filter projects"
      menuTestId={testId}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className={classNames('btn', 'sm', className)}
          disabled={disabled}
          data-testid="project-multi-select"
        >
          {label} <span className="ct">▾</span>
        </button>
      )}
      renderItem={(item) => {
        const on = selected.includes(item.id);
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={on}
            aria-disabled={item.disabled === true ? true : undefined}
            disabled={item.disabled === true}
            className={classNames('check', on && 'on')}
            data-testid={`menu-item-${item.id}`}
            onClick={() => {
              if (item.disabled === true) return;
              onChange(toggleSelection(selected, item.id));
            }}
          >
            <i />
            {item.label}
          </button>
        );
      }}
    />
  );
}
