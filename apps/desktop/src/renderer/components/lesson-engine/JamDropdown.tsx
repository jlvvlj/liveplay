import { useEffect, useId, useRef, useState } from 'react';
import './JamDropdown.css';

// A choice from a list, in the app's style: a field that opens its options
// below it, in groups, each with a dim detail on its right. Keys move through
// the options (arrows, Home, End), Enter picks, Escape closes.

export interface JamDropdownOption {
  value: string;
  label: string;
  detail?: string;
}

export interface JamDropdownGroup {
  label?: string;
  options: JamDropdownOption[];
}

interface JamDropdownProps {
  groups: JamDropdownGroup[];
  value: string;
  onChange: (value: string) => void;
  // Shown while nothing is picked
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}

const ChevronIcon = () => (
  <svg className="jam-dropdown-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path d="M5 12l5 5 9-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function JamDropdown({ groups, value, onChange, placeholder, className, autoFocus }: JamDropdownProps) {
  const options = groups.flatMap((group) => group.options);
  const picked = options.find((option) => option.value === value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  // A press anywhere else closes the list
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  // The active option stays in view while keys move through the list
  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const openList = () => {
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  };
  const pick = (option: JamDropdownOption) => {
    onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openList();
      }
      return;
    }
    const last = options.length - 1;
    const moves: Record<string, number> = {
      ArrowDown: Math.min(last, active + 1),
      ArrowUp: Math.max(0, active - 1),
      Home: 0,
      End: last,
    };
    if (event.key in moves) {
      event.preventDefault();
      setActive(moves[event.key]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (options[active]) pick(options[active]);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      setOpen(false);
    }
  };

  let index = 0;
  return (
    <div className={`jam-dropdown ${open ? 'open' : ''} ${className ?? ''}`} ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={trigger}
        className="jam-dropdown-field"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => (open ? setOpen(false) : openList())}
        autoFocus={autoFocus}
      >
        <span className={`jam-dropdown-value ${picked ? '' : 'placeholder'}`}>{picked?.label ?? placeholder}</span>
        {picked?.detail && <span className="jam-dropdown-detail">{picked.detail}</span>}
        <ChevronIcon />
      </button>
      {open && (
        <div className="jam-dropdown-list" role="listbox" id={id} ref={list} aria-activedescendant={`${id}-${active}`}>
          {groups.map((group, g) => (
            <div key={g} role="group" aria-label={group.label}>
              {group.label && <div className="jam-dropdown-group">{group.label}</div>}
              {group.options.map((option) => {
                const at = index++;
                const selected = option.value === value;
                return (
                  <div
                    key={option.value}
                    id={`${id}-${at}`}
                    data-index={at}
                    role="option"
                    aria-selected={selected}
                    className={`jam-dropdown-option ${at === active ? 'active' : ''} ${selected ? 'selected' : ''}`}
                    onPointerEnter={() => setActive(at)}
                    onClick={() => pick(option)}
                  >
                    <span className="jam-dropdown-check">{selected && <CheckIcon />}</span>
                    <span className="jam-dropdown-label">{option.label}</span>
                    {option.detail && <span className="jam-dropdown-detail">{option.detail}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
