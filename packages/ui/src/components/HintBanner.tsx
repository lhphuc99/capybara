import type { ServerInfo } from '@capybara-devtools/protocol';
import { useState } from 'react';
import { readStringsPref, writePref } from '../prefs';

const KEY = 'capybara:dismissed-hints';
/** Hints name devices and apps, so the list would only grow. */
const KEEP = 50;

/** The newest hint from the server that was not dismissed. The desktop app has no terminal to print them in. */
export function HintBanner({ server }: { server?: ServerInfo }) {
  const [dismissed, setDismissed] = useState(() => readStringsPref(KEY));
  const hint = [...(server?.hints ?? [])].reverse().find((text) => !dismissed.includes(text));
  if (!hint) return null;

  const dismiss = () => {
    const next = [...dismissed, hint].slice(-KEEP);
    setDismissed(next);
    writePref(KEY, JSON.stringify(next));
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
