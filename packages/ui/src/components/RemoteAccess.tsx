import { useEffect, useRef, useState, type RefObject } from 'react';
import { encode } from 'uqr';
import { useStore } from '../store';
import { CopyButton } from './CopyButton';

const COMMAND = 'npx capybara-devtools --remote-ui';

/** How to open this UI on a phone, tablet or another computer: a QR code once `--remote-ui` is on, the flag before. */
export function RemoteAccess() {
  const server = useStore((s) => s.server);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  // Listening on loopback only, or offline: no other device can reach this computer.
  if (!server || server.addresses.length === 0) return null;
  const urls = server.addresses.map((address) => `http://${address}:${server.port}`);

  return (
    <div className="remote" ref={ref}>
      <button
        type="button"
        className="btn small icon"
        aria-label="Open on another device"
        title="Open on another device"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <DevicesIcon />
      </button>
      {open && (
        <div className="remote-panel" role="dialog" aria-label="Open on another device">
          <div className="remote-title">Open on another device</div>
          {server.remoteUi ? <Addresses urls={urls} /> : <HowToAllow />}
        </div>
      )}
    </div>
  );
}

function Addresses({ urls }: { urls: string[] }) {
  return (
    <>
      <div className="remote-qr">
        <QrCode text={urls[0]!} />
      </div>
      <p className="remote-note centered">Scan it with a phone or tablet on the same network.</p>
      <ul className="remote-urls">
        {urls.map((url) => (
          <li key={url}>
            <code>{url}</code>
            <CopyButton text={() => url} label={`Copy ${url}`} className="btn small" toast={`Copied ${url}`}>
              Copy
            </CopyButton>
          </li>
        ))}
      </ul>
      <p className="remote-note">Whoever opens it sees everything apps send, tokens included.</p>
    </>
  );
}

function HowToAllow() {
  return (
    <>
      <p>Only this computer can open Capybara now. To open it on a phone, tablet or another computer, restart Capybara with:</p>
      <div className="remote-command">
        <code>{COMMAND}</code>
        <CopyButton text={() => COMMAND} label="Copy the command" className="btn small" toast="Command copied">
          Copy
        </CopyButton>
      </div>
      <p className="remote-note">
        For the desktop app, set <code>CAPYBARA_REMOTE_UI=1</code>. Other devices then see everything apps send, tokens
        included.
      </p>
    </>
  );
}

/** Dark modules on white whatever the theme: phone cameras read that best. */
function QrCode({ text }: { text: string }) {
  const { size, data } = encode(text, { ecc: 'M', border: 2 });
  let path = '';
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg width="148" height="148" viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" role="img" aria-label={text}>
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  );
}

function useDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLElement | null>) {
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
  }, [open, setOpen, ref]);
}

function DevicesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="2.5" width="10" height="7.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 13h4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <rect x="10" y="6" width="4.5" height="8" rx="1" fill="var(--bg)" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
