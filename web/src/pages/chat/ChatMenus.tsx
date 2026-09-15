import { useState } from 'react';

import {
  FilterMenu,
  Menu,
  MenuItem,
  type OptionItem,
} from '../../shared/controls/index.js';
import { navigate } from '../../shared/router.js';

export interface ProjectChipMenuProps {
  projects: readonly OptionItem[];
  attached: readonly string[];
  onToggle: (projectId: string) => void;
  disabled?: boolean | undefined;
}

function primaryLabel(
  projects: readonly OptionItem[],
  attached: readonly string[],
): string {
  if (attached.length === 0) return 'Attach project';
  const first = attached[0];
  const match = projects.find((project) => project.id === first);
  const name = match?.label ?? first ?? 'Project';
  if (attached.length === 1) return name;
  return `${name} +${String(attached.length - 1)}`;
}

// The project chip dropdown, shared by the full header and the sticky bar.
// Unattached projects attach on pick; attached projects detach (mockup shows
// the "detach" hint).
export function ProjectChipMenu({
  projects,
  attached,
  onToggle,
  disabled = false,
}: ProjectChipMenuProps) {
  const [open, setOpen] = useState(false);
  const label = primaryLabel(projects, attached);

  return (
    <FilterMenu
      items={projects}
      open={open}
      onOpenChange={setOpen}
      ariaLabel="Projects on this chat"
      align="left"
      placeholder="Filter projects"
      menuTestId="project-chip-menu"
      emptyText="No projects"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="projbtn"
          title="Change project attachment"
          data-testid="project-chip"
          disabled={disabled}
        >
          <span className="pd" />
          <span className="pl">{label}</span>
          <span className="ct">▾</span>
        </button>
      )}
      renderItem={(item) => {
        const on = attached.includes(item.id);
        return (
          <MenuItem
            key={item.id}
            label={item.label}
            selected={on}
            role="menuitemradio"
            hint={on ? 'detach' : undefined}
            testId={`project-item-${item.id}`}
            onSelect={() => {
              onToggle(item.id);
              setOpen(false);
            }}
          />
        );
      }}
    />
  );
}

export interface ChatActionsMenuProps {
  chatPath: string;
  disabled?: boolean | undefined;
}

// The ⋯ chat menu, shared by the full header and the sticky bar.
export function ChatActionsMenu({
  chatPath,
  disabled = false,
}: ChatActionsMenuProps) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      align="right"
      ariaLabel="More chat actions"
      testId="chat-menu"
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className="dotsbtn"
          aria-label="More chat actions"
          disabled={disabled}
        >
          ⋯
        </button>
      )}
    >
      <MenuItem label="Promote to project" disabled hint="soon" />
      <MenuItem
        label="Edit file"
        onSelect={() => {
          setOpen(false);
          navigate(`/edit?path=${encodeURIComponent(chatPath)}`);
        }}
      />
    </Menu>
  );
}
