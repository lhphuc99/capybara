import type { ServerInfo, SessionInfo } from '@capybara-devtools/protocol';
import { useState } from 'react';
import { readStringsPref, writePref } from '../prefs';
import { updateNotice } from '../updates';
import { CopyButton } from './CopyButton';

const KEY = 'capybara:dismissed-updates';

export function UpdateBanner({ server, session }: { server?: ServerInfo; session?: SessionInfo }) {
  const [dismissed, setDismissed] = useState(() => new Set(readStringsPref(KEY)));
  const notice = updateNotice(server, session, window.capybaraDesktop !== undefined, dismissed);
  if (!notice) return null;

  const dismiss = () => {
    const next = new Set(dismissed).add(notice.key);
    setDismissed(next);
    writePref(KEY, JSON.stringify([...next]));
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
