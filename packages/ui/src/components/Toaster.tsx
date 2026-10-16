import { useToast } from '../toast';
import { CheckIcon } from './CopyButton';

/** Renders the current toast; the region stays mounted so screen readers announce each one. */
export function Toaster() {
  const toast = useToast();
  return (
    <div className="toast-region" role="status" aria-live="polite">
      {toast && (
        <div key={toast.id} className={`toast ${toast.tone}`}>
          {toast.tone === 'ok' && <CheckIcon />}
          {toast.text}
        </div>
      )}
    </div>
  );
}
