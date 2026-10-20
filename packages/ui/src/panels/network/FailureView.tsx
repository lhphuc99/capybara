import type { NetworkDiagnosis } from '@capybara-devtools/protocol';
import { useState } from 'react';
import { diagnose } from '../../connection';
import type { NetworkEntry, SessionState } from '../../store';

type DiagnosisState =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'done'; result: NetworkDiagnosis }
  | { state: 'error'; message: string };

const VERDICTS: Record<NetworkDiagnosis['verdict'], string> = {
  cors: 'Blocked by CORS',
  unreachable: 'The server could not be reached',
  ok: 'CORS allows this request',
  unknown: 'Capybara could not check this request',
};

export function FailureView({ entry, session }: { entry: NetworkEntry; session: SessionState }) {
  const [diagnosis, setDiagnosis] = useState<DiagnosisState>({ state: 'idle' });
  const { info } = session.meta;
  const { title, text } = explainFailure(entry, info.url);
  const cause = entry.failure?.cause;
  // Offline, CSP and mixed-content blocks are already certain, and only pages are subject to CORS.
  const checkable = Boolean(info.url) && !entry.failure?.aborted && cause !== 'offline' && cause !== 'csp' && cause !== 'mixed-content';
  const run = () => {
    setDiagnosis({ state: 'running' });
    diagnose(info.id, entry.id).then(
      (result) => setDiagnosis({ state: 'done', result }),
      (error: Error) => setDiagnosis({ state: 'error', message: error.message }),
    );
  };

  return (
    <>
      <div className="callout error">
        <strong>{title}</strong>
        {text && <p>{text}</p>}
        {entry.error && <p className="failure-message">{entry.error}</p>}
      </div>
      {checkable && diagnosis.state !== 'done' && (
        <div className="diagnose-bar">
          <button type="button" className="btn small primary" disabled={diagnosis.state === 'running'} onClick={run}>
            {diagnosis.state === 'running' ? 'Checking…' : 'Find out why'}
          </button>
          {diagnosis.state === 'error' ? (
            <span className="note diagnose-error">{diagnosis.message}</span>
          ) : (
            <span className="note">Capybara asks the server again from this computer and applies the browser's rules.</span>
          )}
        </div>
      )}
      {diagnosis.state === 'done' && <DiagnosisView diagnosis={diagnosis.result} onRetry={run} />}
    </>
  );
}

function explainFailure(entry: NetworkEntry, page: string | undefined): { title: string; text?: string } {
  const failure = entry.failure ?? {};
  const target = originOf(entry.url);
  if (failure.aborted) return { title: 'Cancelled', text: 'The app aborted the request before it finished, for example with an AbortController.' };
  if (failure.timeout) return { title: 'Timed out', text: "No answer within the request's timeout." };
  switch (failure.cause) {
    case 'offline':
      return { title: 'The browser is offline', text: 'The request failed while the browser had no network connection.' };
    case 'csp':
      return { title: 'Blocked by Content-Security-Policy', text: `The page's policy does not allow connections to ${target}. Add it to connect-src.` };
    case 'mixed-content':
      return { title: 'Blocked as mixed content', text: `The page is served over HTTPS, so the browser does not let it call ${target} over plain HTTP. Use https:// for this URL.` };
    case 'cross-origin':
      return {
        title: 'Cross-origin request failed',
        text:
          `Browsers do not tell a page why a cross-origin request failed. Usually it is CORS: the server's answer did not allow ${page ? originOf(page) : 'the page'}, but the server may also be unreachable.` +
          (failure.credentials ? ' The request sends cookies, so the server also has to answer with Access-Control-Allow-Credentials: true and cannot allow *.' : ''),
      };
  }
  return { title: 'Request failed' };
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function DiagnosisView({ diagnosis, onRetry }: { diagnosis: NetworkDiagnosis; onRetry: () => void }) {
  return (
    <div className={`diagnosis verdict-${diagnosis.verdict}`}>
      <div className="diagnosis-head">
        <strong>{VERDICTS[diagnosis.verdict]}</strong>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={onRetry}>
          Check again
        </button>
      </div>
      <p>{diagnosis.summary}</p>
      {diagnosis.checks.length > 0 && (
        <ul className="checks">
          {diagnosis.checks.map((check, index) => (
            <li key={index} className={`check ${check.outcome}`}>
              <span className="check-mark" role="img" aria-label={check.outcome}>
                {check.outcome === 'pass' ? '✓' : check.outcome === 'fail' ? '✕' : '•'}
              </span>
              <span className="check-label">{check.label}</span>
              {check.detail !== diagnosis.summary && <span className="check-detail">{check.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      {diagnosis.sent.length > 0 && (
        <div className="section">
          <h3>Sent from this computer</h3>
          <ul className="sent">
            {diagnosis.sent.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
