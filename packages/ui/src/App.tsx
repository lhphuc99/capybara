import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppearanceMenu } from './components/AppearanceMenu';
import { EmptyState } from './components/EmptyState';
import { SessionPicker } from './components/SessionPicker';
import { Toaster } from './components/Toaster';
import { UpdateBanner } from './components/UpdateBanner';
import type { ConnectionStatus } from './connection';
import { statusTone } from './format';
import { LogsPanel } from './panels/LogsPanel';
import { NetworkPanel } from './panels/NetworkPanel';
import { StatePanel } from './panels/StatePanel';
import { StoragePanel } from './panels/StoragePanel';
import { stateBadge } from './state';
import { useStore, type SessionState } from './store';

type Tab = 'logs' | 'network' | 'storage' | 'state';
const TAB_KEY = 'capybara:tab';

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (saved === 'logs' || saved === 'network' || saved === 'storage' || saved === 'state') return saved;
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
  const stateSlice = session?.state;
  const errorCount = useMemo(() => logs?.filter((entry) => entry.level === 'error').length ?? 0, [logs]);
  const failedCount = useMemo(() => network?.filter((entry) => statusTone(entry) === 'error').length ?? 0, [network]);
  const stateCount = useMemo(() => (stateSlice ? stateBadge(stateSlice) : { stores: 0, errors: 0 }), [stateSlice]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          Capybara
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
            <TabButton active={tab === 'state'} onClick={() => setTab('state')}>
              State <Count total={stateCount.stores} alerts={stateCount.errors} />
            </TabButton>
          </nav>
        )}
        <ConnectionBadge status={status} session={session} />
        <AppearanceMenu />
      </header>
      <main className="main">
        <UpdateBanner server={server} session={session?.meta.info} />
        {!session ? (
          <EmptyState status={status} server={server} />
        ) : !session.loaded ? (
          <div className="empty">Loading…</div>
        ) : tab === 'logs' ? (
          <LogsPanel session={session} />
        ) : tab === 'network' ? (
          <NetworkPanel session={session} />
        ) : tab === 'storage' ? (
          <StoragePanel session={session} />
        ) : (
          <StatePanel session={session} />
        )}
      </main>
      <Toaster />
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

/** The app icon (assets/icon.svg), cropped to its rounded square. */
function Logo() {
  return (
    <svg width="20" height="20" viewBox="100 100 824 824" aria-hidden>
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#F4A13A" />
      <g fill="none" stroke="#3A2417" strokeWidth="40" strokeLinecap="round" strokeLinejoin="round">
        <path d="M196 646C236 540 380 454 524 434L752 466Q796 472 796 516V646" />
        <path d="M470 446A30 32 0 0 1 528 432" />
        <path d="M150 646H874M272 724H520M612 724H752" />
        <path d="M566 500Q600 526 634 500" strokeWidth="32" />
      </g>
      <circle cx="776" cy="498" r="11" fill="#3A2417" />
      <circle cx="660" cy="390" r="46" fill="#FFD45E" stroke="#3A2417" strokeWidth="26" />
      <path d="M662 344C670 314 700 304 728 314C720 342 690 352 662 344Z" fill="#5E8C31" />
    </svg>
  );
}
