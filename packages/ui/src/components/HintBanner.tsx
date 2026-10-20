import type { ServerInfo } from '@capybara-devtools/protocol';
import { useState } from 'react';

const KEY = 'capybara:dismissed-hints';
/** Hints name devices and apps, so the list would only grow. */
const KEEP = 50;

function readDismissed(): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** The newest hint from the server that was not dismissed. The desktop app has no terminal to print them in. */
export function HintBanner({ server }: { server?: ServerInfo }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const hint = [...(server?.hints ?? [])].reverse().find((text) => !dismissed.includes(text));
  if (!hint) return null;

  const dismiss = () => {
    const next = [...dismissed, hint].slice(-KEEP);
    setDismissed(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Hidden for this page load only.
    }
  };

  return (
    <div className="hint-banner" role="status">
      <span>{hint}</span>
      <button type="button" className="btn small icon dismiss" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
