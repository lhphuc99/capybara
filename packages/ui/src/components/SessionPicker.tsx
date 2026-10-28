import { useEffect, useMemo, useRef, useState } from 'react';
import { describeSession, formatClock, platformLabel } from '../format';
import { useListKeys } from '../listKeys';
import { removeSession, selectSession, type SessionState } from '../store';
import { AttachFlutterMenuItem } from './AttachFlutter';

interface Props {
  sessions: Record<string, SessionState>;
  selectedId?: string;
}

export function SessionPicker({ sessions, selectedId }: Props) {
  const [open, setOpen] = useState(false);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const list = useMemo(
    () =>
      Object.values(sessions).sort(
        (a, b) => Number(b.meta.connected) - Number(a.meta.connected) || b.meta.info.startedAt - a.meta.info.startedAt,
      ),
    [sessions],
  );
  const current = selectedId ? sessions[selectedId] : undefined;
  const ids = useMemo(() => list.map((session) => session.meta.info.id), [list]);
  const choose = (id: string) => {
    selectSession(id);
    setOpen(false);
    buttonRef.current?.focus();
  };
  const onItemKey = useListKeys({ listRef: menuRef, keys: ids, onMove: setFocusedId, onActivate: choose });
  const tabbable = focusedId !== null && ids.includes(focusedId) ? focusedId : selectedId && ids.includes(selectedId) ? selectedId : ids[0];

  // The keyboard lands on the open menu, on the chosen app.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [open]);

  if (list.length === 0) return null;

  return (
    <div className="picker" ref={ref}>
      <button
        ref={buttonRef}
        type="button"
        className="picker-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {current ? (
          <>
            <span className={`dot ${current.meta.connected ? 'on' : 'off'}`} />
            <span className="picker-name">{current.meta.info.appName}</span>
            <span className="picker-meta">{platformLabel(current.meta.info.platform)}</span>
          </>
        ) : (
          <span className="picker-meta">Choose an app</span>
        )}
        {list.length > 1 && <span className="picker-count">{list.length}</span>}
        <svg className="chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="picker-menu">
          <div role="listbox" aria-label="Apps" ref={menuRef}>
            {list.map((session, index) => {
              const { info, connected } = session.meta;
              return (
                <div
                  key={info.id}
                  role="option"
                  aria-selected={info.id === selectedId}
                  tabIndex={info.id === tabbable ? 0 : -1}
                  data-row={info.id}
                  className="picker-item"
                  onClick={() => choose(info.id)}
                  onKeyDown={(event) => onItemKey(event, index)}
                >
                  <span className={`dot ${connected ? 'on' : 'off'}`} />
                  <span className="picker-text">
                    <span className="picker-title">
                      {info.appName} <span className="tag">{platformLabel(info.platform)}</span>
                    </span>
                    <small>
                      {describeSession(info) || 'Unknown device'}
                      {session.meta.address && ` · from ${session.meta.address}`} · {connected ? 'started' : 'offline since'}{' '}
                      {formatClock(connected ? info.startedAt : session.meta.lastSeen)}
                    </small>
                  </span>
                  {!connected && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeSession(info.id);
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <AttachFlutterMenuItem onAttached={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
