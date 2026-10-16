import type { ServerInfo, SessionInfo } from '@capybara-devtools/protocol';
import { useState } from 'react';
import { updateNotice } from '../updates';
import { CopyButton } from './CopyButton';

const KEY = 'capybara:dismissed-updates';

function readDismissed(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : []);
  } catch {
    return new Set();
  }
}

export function UpdateBanner({ server, session }: { server?: ServerInfo; session?: SessionInfo }) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const notice = updateNotice(server, session, window.capybaraDesktop !== undefined, dismissed);
  if (!notice) return null;

  const dismiss = () => {
    const next = new Set(dismissed).add(notice.key);
    setDismissed(next);
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
      // Hidden for this page load only.
    }
  };

  return (
    <div className="update-banner" role="status">
      <span>{notice.text}</span>
      <code>{notice.command}</code>
      <CopyButton className="btn small" label="Copy the command" text={() => notice.command} toast="Command copied">
        Copy
      </CopyButton>
      <button type="button" className="btn small icon dismiss" aria-label="Dismiss" title="Dismiss" onClick={dismiss}>
        ×
      </button>
    </div>
  );
}
