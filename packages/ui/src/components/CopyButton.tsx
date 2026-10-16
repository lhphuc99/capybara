import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../format';
import { showToast } from '../toast';

interface Props {
  /** Built on click, so large values are only turned into text when someone copies them. */
  text: () => string;
  /** Tooltip and accessible name, e.g. "Copy this log entry". */
  label: string;
  /** Text shown next to the icon; without it the button is just the icon. */
  children?: ReactNode;
  className?: string;
  /** Message after copying; a function gets the copied text, to say what was copied. */
  toast?: string | ((copied: string) => string);
  disabled?: boolean;
}

export function CopyButton({ text, label, children, className = 'copy-icon', toast = 'Copied to clipboard', disabled }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <button
      type="button"
      className={`${className}${copied ? ' copied' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        // Rows and tree branches toggle on click.
        event.stopPropagation();
        const content = text();
        void copyText(content).then((ok) => {
          const message = typeof toast === 'function' ? toast(content) : toast;
          showToast(ok ? message : 'Could not copy to the clipboard', ok ? 'ok' : 'error');
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1_200);
        });
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {children}
    </button>
  );
}

export function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.5 3.6V3.2A1.7 1.7 0 0 0 8.8 1.5H3.2A1.7 1.7 0 0 0 1.5 3.2v5.6a1.7 1.7 0 0 0 1.7 1.7h.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.2 8.6l3.1 3.1 6.5-6.9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
