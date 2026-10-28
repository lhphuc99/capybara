import { useEffect, useRef, useState, type FormEvent } from 'react';
import { attachFlutter } from '../connection';
import { useStore } from '../store';
import { showToast } from '../toast';
import { useDismiss } from './RemoteAccess';

// Capybara finds Flutter apps that flutter run or an IDE started; these take the address of one it did not find.
// The server takes it only from this computer, so the form shows only there.

export function useCanAttachFlutter(): boolean {
  return useStore((s) => s.server?.flutter?.attach === true);
}

/** The Dart VM service address field and its button. */
export function AttachFlutterForm({ focus = false, onAttached }: { focus?: boolean; onAttached?: () => void }) {
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = uri.trim();
    if (!address || busy) return;
    setBusy(true);
    setError(undefined);
    attachFlutter(address).then(
      ({ appName }) => {
        setBusy(false);
        // The address lets whoever has it run code in the app, so not even the field keeps it.
        setUri('');
        showToast(`Reading ${appName}`);
        onAttached?.();
      },
      (reason: unknown) => {
        setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <form className="vm-form" onSubmit={submit}>
      <input
        ref={input}
        className="vm-input"
        value={uri}
        onChange={(event) => setUri(event.target.value)}
        placeholder="http://127.0.0.1:…/…=/"
        aria-label="Dart VM service address"
        aria-invalid={error !== undefined}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="btn primary" disabled={busy || uri.trim() === ''}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      {error && (
        <p className="vm-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** In the onboarding, under the Flutter steps. */
export function AttachFlutterBox() {
  if (!useCanAttachFlutter()) return null;
  return (
    <div className="vm-attach">
      <p>
        <strong>Not showing up?</strong> Paste the address <code>flutter run</code> prints after “A Dart VM Service on … is
        available at”.
      </p>
      <AttachFlutterForm />
      <p className="note">Only addresses on this computer. Capybara does not save it.</p>
    </div>
  );
}

/** In the top bar, beside the device button, with the same kind of panel. */
export function AttachFlutterButton() {
  const canAttach = useCanAttachFlutter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  if (!canAttach) return null;
  return (
    <div className="attach" ref={ref}>
      <button
        type="button"
        className="btn small attach-button"
        title="Connect a Flutter app"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <PlugIcon />
        <span className="attach-label">Connect a Flutter app…</span>
      </button>
      {open && (
        <div className="remote-panel attach-panel" role="dialog" aria-label="Connect a Flutter app">
          <div className="remote-title">Connect a Flutter app</div>
          <p>
            Capybara finds apps started with <code>flutter run</code> or an IDE on its own. If yours does not show up, paste
            the address <code>flutter run</code> prints:
          </p>
          <pre className="code vm-line">
            A Dart VM Service on iPhone is available at: <mark>http://127.0.0.1:50300/…=/</mark>
          </pre>
          <AttachFlutterForm focus onAttached={() => setOpen(false)} />
          <p className="remote-note">Only addresses on this computer. Capybara does not save it.</p>
        </div>
      )}
    </div>
  );
}

/** The last part of the app menu, after the apps. */
export function AttachFlutterMenuItem({ onAttached }: { onAttached: () => void }) {
  const [open, setOpen] = useState(false);
  if (!useCanAttachFlutter()) return null;
  return (
    <>
      <hr className="picker-sep" />
      <div className="picker-attach">
        <button type="button" className="picker-attach-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <PlusIcon />
          <span>Connect a Flutter app by address…</span>
        </button>
        {open && (
          <>
            <AttachFlutterForm focus onAttached={onAttached} />
            <p className="picker-attach-note">
              The address <code>flutter run</code> prints after “A Dart VM Service on … is available at”. Only addresses on
              this computer.
            </p>
          </>
        )}
      </div>
    </>
  );
}

function PlugIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M5.75 1.5v3M10.25 1.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M3.75 4.75h8.5v2.5a4.25 4.25 0 0 1-8.5 0Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M8 11.5v3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
