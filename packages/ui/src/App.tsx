import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { EmptyState } from './components/EmptyState';
import { SessionPicker } from './components/SessionPicker';
import type { ConnectionStatus } from './connection';
import { statusTone } from './format';
import { LogsPanel } from './panels/LogsPanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { StoragePanel } from './panels/StoragePanel';
import { useStore, type SessionState } from './store';

type Tab = 'logs' | 'network' | 'storage';
const TAB_KEY = 'devsight:tab';

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === 'logs' || saved === 'network' || saved === 'storage') return saved;
  } catch {
    // storage blocked: fall back to the default
  }
  return 'logs';
}

export function App() {
  const status = useStore((s) => s.status);
  const server = useStore((s) => s.server);
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const [tab, setTab] = useState<Tab>(initialTab);
  const session = selectedId ? sessions[selectedId] : undefined;

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // not essential
    }
  }, [tab]);

  const logs = session?.logs;
  const network = session?.network;
  const errorCount = useMemo(() => logs?.filter((entry) => entry.level === 'error').length ?? 0, [logs]);
  const failedCount = useMemo(() => network?.filter((entry) => statusTone(entry) === 'error').length ?? 0, [network]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          Devsight
        </div>
        <SessionPicker sessions={sessions} selectedId={selectedId} />
        {session && (
          <nav className="tabs" role="tablist">
            <TabButton active={tab === 'logs'} onClick={() => setTab('logs')}>
              Logs <Count total={session.logs.length} alerts={errorCount} />
            </TabButton>
            <TabButton active={tab === 'network'} onClick={() => setTab('network')}>
              Network <Count total={session.network.length} alerts={failedCount} />
            </TabButton>
            <TabButton active={tab === 'storage'} onClick={() => setTab('storage')}>
              Storage
            </TabButton>
          </nav>
        )}
        <ConnectionBadge status={status} session={session} />
      </header>
      <main className="main">
        {!session ? (
          <EmptyState status={status} server={server} />
        ) : !session.loaded ? (
          <div className="empty">Loading…</div>
        ) : tab === 'logs' ? (
          <LogsPanel session={session} />
        ) : tab === 'network' ? (
          <NetworkPanel session={session} />
        ) : (
          <StoragePanel session={session} />
        )}
      </main>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" className="tab" aria-selected={active} onClick={onClick}>
      {children}
    </button>
  );
}

function Count({ total, alerts }: { total: number; alerts: number }) {
  if (alerts > 0) return <span className="count alert">{alerts}</span>;
  return total > 0 ? <span className="count">{total}</span> : null;
}

function ConnectionBadge({ status, session }: { status: ConnectionStatus; session?: SessionState }) {
  const [tone, label] =
    status !== 'open'
      ? (['off', 'Server offline, reconnecting…'] as const)
      : session && !session.meta.connected
        ? (['wait', 'App disconnected'] as const)
        : session
          ? (['on', 'Live'] as const)
          : (['on', 'Server running'] as const);
  return (
    <div className="connection">
      <span className={`dot ${tone}`} />
      {label}
    </div>
  );
}

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="3.2" fill="currentColor" />
    </svg>
  );
}
