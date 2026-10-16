import { useEffect, useRef, useState, type ReactNode } from 'react';
import { setAppearance, useAppearance, type Appearance } from '../appearance';
import { CheckIcon } from './CopyButton';

const OPTIONS: Array<{ value: Appearance; label: string; icon: ReactNode }> = [
  { value: 'system', label: 'System', icon: <SystemIcon /> },
  { value: 'light', label: 'Light', icon: <LightIcon /> },
  { value: 'dark', label: 'Dark', icon: <DarkIcon /> },
];

export function AppearanceMenu() {
  const appearance = useAppearance();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = OPTIONS.find((option) => option.value === appearance)!;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="appearance" ref={ref}>
      <button
        type="button"
        className="btn small icon"
        aria-label={`Appearance: ${current.label}`}
        title={`Appearance: ${current.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current.icon}
      </button>
      {open && (
        <div className="appearance-menu" role="menu" aria-label="Appearance">
          <div className="appearance-title">Appearance</div>
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === appearance}
              className="appearance-option"
              onClick={() => {
                setAppearance(option.value);
                setOpen(false);
              }}
            >
              {option.icon}
              <span>{option.label}</span>
              {option.value === appearance && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 14h5M8 11v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function LightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
