import { useState, type ReactNode } from 'react';

import { FilterMenu, MenuItem } from './Menu.js';
import { classNames, type OptionItem } from './logic.js';

export type SearchableSelectItem = OptionItem;

export interface SearchableSelectProps {
  items: readonly SearchableSelectItem[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder?: string | undefined;
  ariaLabel: string;
  disabled?: boolean | undefined;
  className?: string | undefined;
  renderValue?: ((item: SearchableSelectItem) => ReactNode) | undefined;
  testId?: string | undefined;
}

export function SearchableSelect({
  items,
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled = false,
  className,
  renderValue,
  testId,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const current = items.find((item) => item.id === value) ?? null;
  const label =
    current === null
      ? (placeholder ?? '')
      : (renderValue?.(current) ?? current.label);

  return (
    <FilterMenu
      items={items}
      open={open}
      onOpenChange={setOpen}
      ariaLabel={ariaLabel}
      align="left"
      placeholder={placeholder ?? ariaLabel}
      menuTestId={testId}
      trigger={(props) => (
        <button
          {...props}
          type="button"
          className={classNames('btn', 'sm', className)}
          disabled={disabled}
        >
          {label !== '' ? label : (placeholder ?? '')}{' '}
          <span className="ct">▾</span>
        </button>
      )}
      renderItem={(item) => (
        <MenuItem
          key={item.id}
          label={item.label}
          selected={item.id === value}
          disabled={item.disabled === true}
          role="menuitemradio"
          testId={`menu-item-${item.id}`}
          onSelect={() => {
            onChange(item.id);
            setOpen(false);
          }}
        />
      )}
    />
  );
}
