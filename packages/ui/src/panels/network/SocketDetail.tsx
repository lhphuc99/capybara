import { useVirtualizer } from '@tanstack/react-virtual';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { SearchInput } from '../../components/SearchInput';
import { useFollow } from '../../follow';
import { decodeSocketIo, formatBytes, formatDuration, formatTime, makeMatcher } from '../../format';
import type { NetworkEntry, SocketInfo, SocketMessage } from '../../store';
import { BodyView, KeyValues } from './DetailSections';

export type SocketEntry = NetworkEntry & { socket: SocketInfo };

const MESSAGE_ROW_HEIGHT = 24;

export function SocketDetail({ entry, onClose, resize }: { entry: SocketEntry; onClose: () => void; resize: ReactNode }) {
  const [tab, setTab] = useState<'messages' | 'general'>('messages');
  return (
    <aside className="detail">
      {resize}
      <div className="detail-head">
        <div className="subtabs" role="tablist">
          {(['messages', 'general'] as const).map((id) => (
            <button key={id} type="button" role="tab" className="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
              {id === 'messages' ? 'Messages' : 'General'}
            </button>
          ))}
        </div>
        <div className="pane-actions">
          <button type="button" className="btn small icon" onClick={onClose} aria-label="Close details">
            ✕
          </button>
        </div>
      </div>
      {tab === 'messages' ? (
        <SocketMessages entry={entry} />
      ) : (
        <div className="detail-body">
          <SocketGeneral entry={entry} />
        </div>
      )}
    </aside>
  );
}

function SocketMessages({ entry }: { entry: SocketEntry }) {
  const { socket } = entry;
  const [direction, setDirection] = useState<'all' | 'sent' | 'received'>('all');
  const [query, setQuery] = useState('');
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const socketIo = entry.url.includes('/socket.io/');
  const matcher = useMemo(() => makeMatcher(query), [query]);
  const visible = useMemo(
    () =>
      socket.messages.filter(
        (message) =>
          (direction === 'all' || message.direction === direction) &&
          (!matcher || matcher.test(message.data.text ?? message.data.summary ?? '')),
      ),
    [socket.messages, direction, matcher],
  );
  const selected = selectedSeq === null ? undefined : socket.messages.find((message) => message.seq === selectedSeq);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => MESSAGE_ROW_HEIGHT,
    overscan: 20,
    getItemKey: (index) => visible[index]!.seq,
    useFlushSync: false,
  });

  const { onScroll, onWheel } = useFollow(listRef, virtualizer.getTotalSize(), MESSAGE_ROW_HEIGHT);

  return (
    <div className="ws-pane">
      <div className="ws-toolbar">
        <SearchInput value={query} onChange={setQuery} placeholder="Filter messages" invalid={matcher?.invalid} />
        <div className="chips">
          {(['all', 'sent', 'received'] as const).map((id) => (
            <button key={id} type="button" className="chip" aria-pressed={direction === id} onClick={() => setDirection(id)}>
              {id === 'all' ? 'All' : id === 'sent' ? '↑ Sent' : '↓ Received'}
            </button>
          ))}
        </div>
      </div>
      <div className="ws-summary note">
        {socket.sent} sent · {socket.received} received · {formatBytes(socket.bytes)}
        {socket.dropped > 0 && ` · ${socket.dropped} oldest not kept`}
      </div>
      {entry.state === 'failed' && (
        <div className="callout error inline">
          <strong>Connection failed</strong>
          <p>{entry.error}</p>
        </div>
      )}
      {socket.existing && <p className="callout inline">Already open when Capybara attached, so earlier messages are missing.</p>}
      {visible.length === 0 ? (
        <div className="empty small">
          <strong>{socket.messages.length === 0 ? 'No messages yet' : 'No matching messages'}</strong>
        </div>
      ) : (
        <div className="ws-list" ref={listRef} onScroll={onScroll} onWheel={onWheel}>
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const message = visible[item.index]!;
              return (
                <MessageRow
                  key={item.key}
                  message={message}
                  top={item.start}
                  socketIo={socketIo}
                  selected={message.seq === selectedSeq}
                  onSelect={() => setSelectedSeq(message.seq === selectedSeq ? null : message.seq)}
                />
              );
            })}
          </div>
        </div>
      )}
      {selected && <MessageView key={selected.seq} message={selected} socketIo={socketIo} />}
    </div>
  );
}

function MessageRow({
  message,
  top,
  socketIo,
  selected,
  onSelect,
}: {
  message: SocketMessage;
  top: number;
  socketIo: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const { data } = message;
  const decoded = socketIo && data.text !== undefined ? decodeSocketIo(data.text) : undefined;
  const preview =
    data.text === undefined
      ? `${data.summary ?? data.kind} message`
      : decoded
        ? `${decoded.label}${decoded.payload ? ` ${decoded.payload}` : ''}`
        : data.text;
  return (
    <div
      className={`ws-row ${message.direction}${selected ? ' selected' : ''}`}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: MESSAGE_ROW_HEIGHT, transform: `translateY(${top}px)` }}
      onClick={onSelect}
    >
      <span className="ws-dir" aria-label={message.direction}>
        {message.direction === 'sent' ? '↑' : '↓'}
      </span>
      <span className="ws-preview">{preview.slice(0, 300)}</span>
      <span className="num muted">{formatBytes(data.size)}</span>
      <span className="num muted">{formatTime(message.ts)}</span>
    </div>
  );
}

function MessageView({ message, socketIo }: { message: SocketMessage; socketIo: boolean }) {
  const { data } = message;
  const decoded = socketIo && data.text !== undefined ? decodeSocketIo(data.text) : undefined;
  const body = decoded ? { ...data, text: decoded.payload ?? '', contentType: `socket.io ${decoded.label}` } : data;
  return (
    <div className="ws-message">
      <p className="note">
        {message.direction === 'sent' ? 'Sent' : 'Received'} at {formatTime(message.ts)}
      </p>
      <BodyView body={body} empty="Empty message" copyable />
    </div>
  );
}

function SocketGeneral({ entry }: { entry: SocketEntry }) {
  const { socket } = entry;
  const closed = `${socket.closeCode !== undefined ? ` with code ${socket.closeCode}` : ''}${socket.closeReason ? `: ${socket.closeReason}` : ''}`;
  const status =
    entry.state === 'pending'
      ? 'Connecting'
      : entry.state === 'open'
        ? 'Open (101 Switching Protocols)'
        : entry.state === 'done'
          ? `Closed${closed}`
          : `Failed: ${entry.error ?? ''}${socket.closeCode !== undefined ? ` (code ${socket.closeCode})` : ''}`;
  const rows: Array<[string, string]> = [
    ['URL', entry.url],
    ['Status', status],
    ['Requested subprotocols', socket.protocols?.join(', ') || 'None'],
    ['Subprotocol', socket.protocol || 'None'],
    ['Extensions', socket.extensions || 'None'],
    ['Started', formatTime(entry.ts)],
    ['Handshake', formatDuration(socket.handshake)],
    ['Duration', entry.state === 'open' || entry.state === 'pending' ? 'Still open' : formatDuration(entry.duration)],
    ['Messages', `${socket.sent} sent, ${socket.received} received, ${formatBytes(socket.bytes)}`],
  ];
  return (
    <>
      <KeyValues title="General" rows={rows} />
      {socket.existing && <p className="note">Already open when Capybara attached; its start time is when Capybara first saw it.</p>}
    </>
  );
}
