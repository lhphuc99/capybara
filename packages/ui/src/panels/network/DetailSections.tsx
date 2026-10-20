import type { BodyPreview } from '@capybara-devtools/protocol';
import { useMemo, useState } from 'react';
import { CopyButton } from '../../components/CopyButton';
import { JsonTree } from '../../components/JsonTree';
import { formatBytes, parseJson } from '../../format';

export function KeyValues({ title, rows, empty }: { title: string; rows: Array<[string, string]>; empty?: string }) {
  return (
    <div className="section">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="note">{empty ?? 'None'}</p>
      ) : (
        <dl className="kv">
          {rows.map(([key, value]) => (
            <div key={key} className="kv-row">
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function BodyView({ body, empty, copyable }: { body?: BodyPreview; empty: string; copyable?: boolean }) {
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => (body?.text !== undefined ? parseJson(body.text) : { ok: false as const }), [body]);

  if (!body) return <p className="note">{empty}</p>;
  if (body.text === undefined) {
    return (
      <div className="section">
        <p className="note">
          {body.summary ?? body.kind} {body.size !== undefined && `· ${formatBytes(body.size)}`} · not captured as text
        </p>
      </div>
    );
  }

  return (
    <div className="section">
      <div className="body-meta">
        <span className="note">
          {body.contentType ?? (body.kind === 'form' ? 'form data' : 'text')} · {formatBytes(body.size)}
        </span>
        <span className="spacer" />
        {parsed.ok && (
          <button type="button" className="btn small" onClick={() => setRaw(!raw)}>
            {raw ? 'Tree' : 'Raw'}
          </button>
        )}
        {copyable && (
          <CopyButton className="btn small" label="Copy the body" text={() => body.text!}>
            Copy
          </CopyButton>
        )}
      </div>
      {body.truncated && <p className="callout">Truncated by the SDK; only the beginning was captured.</p>}
      {parsed.ok && !raw ? <JsonTree value={parsed.value} raw expandDepth={2} /> : <pre className="code">{body.text}</pre>}
    </div>
  );
}
