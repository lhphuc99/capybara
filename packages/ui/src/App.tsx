import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppearanceMenu } from './components/AppearanceMenu';
import { EmptyState } from './components/EmptyState';
import { HintBanner } from './components/HintBanner';
import { RemoteAccess } from './components/RemoteAccess';
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
import { readPref, writePref } from './prefs';
import { useStore, type SessionState } from './store';

type Tab = 'logs' | 'network' | 'storage' | 'state';
const TAB_KEY = 'capybara:tab';
/** Pressed outside a text field, 1 to 4 open the tabs in this order. */
const TABS: Tab[] = ['logs', 'network', 'storage', 'state'];

/** Whether a key press belongs to the field it was typed in. */
function typing(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return element !== null && (element.isContentEditable || /^(?:INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}

function initialTab(): Tab {
  const saved = readPref(TAB_KEY);
  return saved === 'network' || saved === 'storage' || saved === 'state' ? saved : 'logs';
}

export function App() {
  const status = useStore((s) => s.status);
  const server = useStore((s) => s.server);
  const sessions = useStore((s) => s.sessions);
  const selectedId = useStore((s) => s.selectedId);
  const [tab, setTab] = useState<Tab>(initialTab);
  const session = selectedId ? sessions[selectedId] : undefined;

  useEffect(() => writePref(TAB_KEY, tab), [tab]);

  // `/` and Cmd/Ctrl+F go to the filter of the tab shown; 1 to 4 switch tabs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const find = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f';
      if (!find && (typing(event.target) || event.metaKey || event.ctrlKey)) return;
      if (find || event.key === '/') {
        const search = document.querySelector<HTMLInputElement>('.main .toolbar input.search');
        if (!search) return;
        event.preventDefault();
        search.focus();
        search.select();
        return;
      }
      const next = TABS[Number(event.key) - 1];
      if (next && /^[1-4]$/.test(event.key) && session) {
        event.preventDefault();
        setTab(next);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session]);

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
          <span className="brand-name">Capybara</span>
        </div>
        <SessionPicker sessions={sessions} selectedId={selectedId} />
        {session && (
          <div className="tabs" role="tablist" aria-label="Panels">
            <TabButton active={tab === 'logs'} shortcut="1" onClick={() => setTab('logs')}>
              Logs <Count total={session.logs.length} alerts={errorCount} />
            </TabButton>
            <TabButton active={tab === 'network'} shortcut="2" onClick={() => setTab('network')}>
              Network <Count total={session.network.length} alerts={failedCount} />
            </TabButton>
            <TabButton active={tab === 'storage'} shortcut="3" onClick={() => setTab('storage')}>
              Storage
            </TabButton>
            <TabButton active={tab === 'state'} shortcut="4" onClick={() => setTab('state')}>
              State <Count total={stateCount.stores} alerts={stateCount.errors} />
            </TabButton>
          </div>
        )}
        <ConnectionBadge status={status} session={session} />
        <RemoteAccess />
        <AppearanceMenu />
      </header>
      <main className="main">
        <UpdateBanner server={server} session={session?.meta.info} />
        <HintBanner server={server} />
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

function TabButton({ active, shortcut, onClick, children }: { active: boolean; shortcut: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" className="tab" aria-selected={active} aria-keyshortcuts={shortcut} title={`Press ${shortcut}`} onClick={onClick}>
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
    <div className="connection" title={label}>
      <span className={`dot ${tone}`} />
      <span className="connection-label">{label}</span>
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
