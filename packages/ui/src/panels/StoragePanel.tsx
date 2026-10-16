import { METRO_SDK, type StorageAdapterInfo, type StorageEntries, type StorageEntry } from '@capybara/protocol';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { CopyButton } from '../components/CopyButton';
import { JsonTree } from '../components/JsonTree';
import { ResizeHandle, usePaneWidth } from '../components/ResizeHandle';
import { storageCommand } from '../connection';
import { formatBytes, makeMatcher, parseJson } from '../format';
import type { SessionState } from '../store';

export function StoragePanel({ session }: { session: SessionState }) {
  return <StorageBrowser key={session.meta.info.id} session={session} />;
}

function StorageBrowser({ session }: { session: SessionState }) {
  const sessionId = session.meta.info.id;
  const viaMetro = session.meta.info.sdk.name === METRO_SDK;
  const connected = session.meta.connected;
  const [adapters, setAdapters] = useState<StorageAdapterInfo[] | null>(null);
  const [adapterId, setAdapterId] = useState<string | null>(null);
  const [listing, setListing] = useState<StorageEntries | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [scanToken, setScanToken] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const pane = usePaneWidth('capybara:pane:storage', 40);
  const adapter = adapters?.find((a) => a.id === adapterId);
  const version = adapterId ? (session.storageVersions[adapterId] ?? 0) : 0;

  useEffect(() => {
    setAdapters(null);
    setListing(null);
    setError(null);
    setAdapterId(null);
    if (!connected) return;
    let cancelled = false;
    storageCommand(sessionId, 'list', undefined).then(
      (list) => {
        if (cancelled) return;
        setAdapters(list);
        setAdapterId((current) => (current && list.some((a) => a.id === current) ? current : (list[0]?.id ?? null)));
      },
      (reason: Error) => {
        if (!cancelled) setError(reason.message);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, connected, scanToken]);

  useEffect(() => {
    if (!connected || !adapterId) return;
    let cancelled = false;
    // Persisted stores can write many times a second; refresh at most every 250 ms after the first load.
    const delay = version === 0 && reloadToken === 0 ? 0 : 250;
    const timer = window.setTimeout(() => {
      setLoading(true);
      storageCommand(sessionId, 'entries', { adapter: adapterId })
        .then(
          (result) => {
            if (cancelled) return;
            setListing(result);
            setError(null);
          },
          (reason: Error) => {
            if (!cancelled) setError(reason.message);
          },
        )
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, connected, adapterId, version, reloadToken]);

  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () => (listing?.entries ?? []).filter((entry) => !matcher || matcher.test(`${entry.key}\n${entry.value ?? ''}`)),
    [listing, matcher],
  );
  const selectedEntry = listing?.entries.find((entry) => entry.key === selectedKey);

  const reload = () => setReloadToken((n) => n + 1);
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      reload();
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
  };

  if (!connected) {
    return (
      <section className="panel">
        <div className="empty">
          <strong>The app is offline</strong>
          <p>Storage is read live from the app. Reconnect it to browse and edit values.</p>
        </div>
      </section>
    );
  }

  if (adapters && adapters.length === 0) {
    if (viaMetro) {
      return (
        <section className="panel">
          <div className="empty">
            <strong>No storage found yet</strong>
            <p>Open the app screen that uses AsyncStorage or MMKV, then scan again.</p>
            <p>MMKV v2/v3: use the store again after connecting. MMKV v4: new instances can be detected after connecting; existing private instances may remain unavailable.</p>
            <button type="button" className="btn" onClick={() => setScanToken((n) => n + 1)}>Find stores</button>
          </div>
        </section>
      );
    }
    return (
      <section className="panel">
        <div className="empty">
          <strong>No storage configured</strong>
          <p>Pass the storages your app uses to init():</p>
          <pre className="code left">{`import AsyncStorage from '@react-native-async-storage/async-storage';
import { asyncStorage, mmkvStorage } from '@capybara/react-native';

init({ storage: [asyncStorage(AsyncStorage), mmkvStorage(storage)] });`}</pre>
        </div>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="toolbar">
        <input
          className={`search${matcher?.invalid ? ' invalid' : ''}`}
          placeholder="Filter keys and values"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
        />
        <span className="spacer" />
        {viaMetro && (
          <>
            <span className="tag">Read-only via Metro</span>
            <button type="button" className="btn" onClick={() => setScanToken((n) => n + 1)}>Find stores</button>
          </>
        )}
        {listing && (
          <span className="note">
            {listing.total > listing.entries.length
              ? `${listing.entries.length} of ${listing.total} keys`
              : `${listing.total} ${listing.total === 1 ? 'key' : 'keys'}`}
          </span>
        )}
        <button type="button" className="btn" onClick={reload} disabled={!adapterId}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {adapter && !adapter.readOnly && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAdding(true);
              setSelectedKey(null);
            }}
          >
            Add key
          </button>
        )}
        {adapter?.canClear && (
          <button
            type="button"
            className="btn danger"
            disabled={!listing || listing.total === 0}
            onClick={() => {
              if (window.confirm(`Remove every key in ${adapter.label}?`)) {
                void run(() => storageCommand(sessionId, 'clear', { adapter: adapter.id }));
              }
            }}
          >
            Clear all
          </button>
        )}
      </div>
      {error && <div className="callout error inline">{error}</div>}

      <div ref={layoutRef} className="storage" style={{ '--pane-width': `${pane.width}%` } as CSSProperties}>
        <nav className="adapters">
          {adapters?.map((a) => (
            <button
              key={a.id}
              type="button"
              className="adapter"
              aria-selected={a.id === adapterId}
              onClick={() => {
                setAdapterId(a.id);
                setSelectedKey(null);
                setAdding(false);
              }}
            >
              <span>{a.label}</span>
              {a.readOnly && <span className="tag">read-only</span>}
            </button>
          ))}
          {adapter?.note && <p className="adapter-note">{adapter.note}</p>}
        </nav>

        <div className="entries">
          <div className="entry-head">
            <span>Key</span>
            <span>Value</span>
            <span className="num">Size</span>
          </div>
          <div className="entry-body">
            {visible.map((entry) => (
              <div
                key={entry.key}
                className={`entry-row${entry.key === selectedKey ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedKey(entry.key);
                  setAdding(false);
                }}
              >
                <span className="entry-key" title={entry.key}>
                  {entry.key}
                </span>
                <span className="entry-value">{entry.value ?? 'null'}</span>
                <span className="num muted">{formatBytes(entry.size)}</span>
              </div>
            ))}
            {listing && visible.length === 0 && (
              <div className="empty small">{listing.total === 0 ? 'This storage is empty.' : 'No keys match the filter.'}</div>
            )}
          </div>
        </div>

        <div className="editor-pane">
          <ResizeHandle
            container={layoutRef}
            width={pane.width}
            min={25}
            max={65}
            onChange={pane.setWidth}
            onCommit={pane.save}
            onReset={pane.reset}
            label="Resize the value pane"
          />
          {adding && adapter ? (
            <NewEntry
              onCancel={() => setAdding(false)}
              onSave={async (key, value) => {
                if (await run(() => storageCommand(sessionId, 'set', { adapter: adapter.id, key, value }))) {
                  setAdding(false);
                  setSelectedKey(key);
                }
              }}
            />
          ) : selectedEntry && adapter ? (
            <ValueEditor
              key={`${adapter.id}:${selectedEntry.key}`}
              sessionId={sessionId}
              adapter={adapter}
              entry={selectedEntry}
              onChanged={reload}
              onRemoved={() => {
                setSelectedKey(null);
                reload();
              }}
            />
          ) : (
            <div className="empty small">Select a key to view or edit its value.</div>
          )}
        </div>
      </div>
    </section>
  );
}

function ValueEditor({
  sessionId,
  adapter,
  entry,
  onChanged,
  onRemoved,
}: {
  sessionId: string;
  adapter: StorageAdapterInfo;
  entry: StorageEntry;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [full, setFull] = useState<StorageEntry>(entry);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [raw, setRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The listing only carries a preview of long values.
  useEffect(() => {
    setFull(entry);
    if (!entry.truncated) return;
    let cancelled = false;
    storageCommand(sessionId, 'get', { adapter: adapter.id, key: entry.key }).then(
      (value) => {
        if (!cancelled && value) setFull(value);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, adapter.id, entry]);

  const value = full.value ?? '';
  const parsed = useMemo(() => parseJson(value), [value]);

  const save = async () => {
    let next = draft;
    // Keep minified JSON minified; the editor pretty-prints it for reading only.
    if (parsed.ok && !value.includes('\n')) {
      const edited = parseJson(draft);
      if (edited.ok) next = JSON.stringify(edited.value);
    }
    setBusy(true);
    try {
      await storageCommand(sessionId, 'set', { adapter: adapter.id, key: entry.key, value: next });
      setEditing(false);
      setError(null);
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Remove "${entry.key}" from ${adapter.label}?`)) return;
    setBusy(true);
    try {
      await storageCommand(sessionId, 'remove', { adapter: adapter.id, key: entry.key });
      onRemoved();
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <div className="editor-head">
        <strong className="editor-key" title={entry.key}>
          {entry.key}
        </strong>
        <span className="note">{formatBytes(full.size)}</span>
        <div className="pane-actions">
          {!editing && full.value !== null && (
            <CopyButton
              className="btn small"
              label={`Copy the value of ${entry.key}`}
              // The tree view copies indented JSON; Raw copies the value exactly as stored.
              text={() => (parsed.ok && !raw ? JSON.stringify(parsed.value, null, 2) : value)}
            >
              Copy
            </CopyButton>
          )}
          {!editing && parsed.ok && (
            <button type="button" className="btn small" onClick={() => setRaw(!raw)}>
              {raw ? 'Tree' : 'Raw'}
            </button>
          )}
          {!adapter.readOnly && !editing && (
            <button
              type="button"
              className="btn small"
              onClick={() => {
                setDraft(parsed.ok ? JSON.stringify(parsed.value, null, 2) : value);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {!adapter.readOnly && (
            <button type="button" className="btn small danger" onClick={remove} disabled={busy}>
              Delete
            </button>
          )}
        </div>
      </div>
      {error && <p className="callout error">{error}</p>}
      {editing ? (
        <>
          <textarea
            className="editor-text"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            autoFocus
          />
          <div className="editor-actions">
            <button type="button" className="btn" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={save} disabled={busy}>
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="editor-view">
          {full.value === null ? (
            <p className="note">null</p>
          ) : parsed.ok && !raw ? (
            <JsonTree value={parsed.value} raw expandDepth={2} />
          ) : (
            <pre className="code">{value}</pre>
          )}
        </div>
      )}
      {full.truncated && <p className="callout">This value is over 1 MB; only the beginning is shown.</p>}
    </div>
  );
}

function NewEntry({ onSave, onCancel }: { onSave: (key: string, value: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  return (
    <div className="editor">
      <div className="editor-head">
        <strong>New key</strong>
      </div>
      <input
        className="search full"
        placeholder="Key"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        spellCheck={false}
        autoFocus
      />
      <textarea
        className="editor-text"
        placeholder="Value"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        spellCheck={false}
      />
      <div className="editor-actions">
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={!key} onClick={() => onSave(key, value)}>
          Save
        </button>
      </div>
    </div>
  );
}
