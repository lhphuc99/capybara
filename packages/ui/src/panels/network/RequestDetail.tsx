import { useState, type ReactNode } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { formatDuration, formatTime, toCurl } from '../../format';
import type { NetworkEntry, SessionState } from '../../store';
import { BodyView, KeyValues } from './DetailSections';
import { FailureView } from './FailureView';

type DetailTab = 'headers' | 'request' | 'response';

export function RequestDetail({
  entry,
  session,
  onClose,
  resize,
}: {
  entry: NetworkEntry;
  session: SessionState;
  onClose: () => void;
  resize: ReactNode;
}) {
  const [tab, setTab] = useState<DetailTab>('response');

  return (
    <aside className="detail">
      {resize}
      <div className="detail-head">
        <div className="subtabs" role="tablist">
          {(['headers', 'request', 'response'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'headers' ? 'Headers' : id === 'request' ? 'Request' : 'Response'}
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <CopyButton
            className="btn small"
            label="Copy as a cURL command"
            text={() => toCurl(entry).command}
            toast={() => toCurl(entry).note ?? 'Copied to clipboard'}
          >
            Copy cURL
          </CopyButton>
          <button type="button" className="btn small icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
      </div>
      <div className="detail-body">
        {tab === 'headers' && <HeadersTab entry={entry} />}
        {tab === 'request' && <BodyView body={entry.requestBody} empty="No request body" />}
        {tab === 'response' &&
          (entry.state === 'failed' ? (
            <FailureView entry={entry} session={session} />
          ) : entry.state === 'pending' && !entry.streaming ? (
            <p className="note">Waiting for the response…</p>
          ) : (
            <>
              {entry.streaming && <p className="note">Still arriving; this is what has come so far.</p>}
              <BodyView body={entry.responseBody} empty={entry.streaming ? 'Nothing has arrived yet' : 'No response body'} copyable />
            </>
          ))}
      </div>
    </aside>
  );
}

function HeadersTab({ entry }: { entry: NetworkEntry }) {
  const general: Array<[string, string]> = [
    ['URL', entry.url],
    ['Method', entry.method],
    [
      'Status',
      entry.state === 'pending'
        ? entry.streaming
          ? `${entry.status ?? ''} ${entry.statusText ?? ''} (body still arriving)`.trim()
          : 'Pending'
        : entry.state === 'failed'
          ? `Failed: ${entry.error ?? ''}`
          : `${entry.status ?? ''} ${entry.statusText ?? ''}`.trim(),
    ],
    ['Started', formatTime(entry.ts)],
    ['Duration', formatDuration(entry.duration)],
    ['Initiator', entry.initiator],
  ];
  return (
    <>
      <KeyValues title="General" rows={general} />
      {entry.responseHeaders && <KeyValues title="Response headers" rows={Object.entries(entry.responseHeaders)} />}
      <KeyValues title="Request headers" rows={Object.entries(entry.requestHeaders)} empty="No headers set by the app" />
    </>
  );
}
