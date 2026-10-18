import type { StateDiffOp } from '@capybara-devtools/protocol';
import { useMemo, useState } from 'react';
import { formatOp, formatPath, groupOps, type OpGroup, type StateRecord } from '../state';

const SYMBOLS: Record<StateDiffOp['op'], string> = { add: '+', set: '~', del: '−' };

/** What one record changed, op by op; long diffs fold by branch. */
export function DiffView({ record }: { record: StateRecord }) {
  const groups = useMemo(() => groupOps(record.ops), [record]);
  const cut = record.opCount - record.ops.length;

  if (record.ops.length === 0) {
    return (
      <p className="note">
        {record.cause === 'init' ? 'The state the store started with. The State tab shows what it holds now.' : 'Nothing changed.'}
      </p>
    );
  }
  return (
    <div className="diff">
      {groups
        ? groups.map((group) => <DiffGroup key={group.key} group={group} initiallyOpen={groups.length === 1} />)
        : record.ops.map((op, index) => <DiffOp key={index} op={op} />)}
      {cut > 0 && (
        <p className="note diff-cut">
          {cut} more {cut === 1 ? 'change was' : 'changes were'} left out. The State tab shows the whole state as it is now.
        </p>
      )}
    </div>
  );
}

function DiffOp({ op }: { op: StateDiffOp }) {
  const text = formatOp(op);
  return (
    <div className={`diff-op ${op.op}`}>
      <span className="diff-sym">{SYMBOLS[op.op]}</span>
      <span>
        <span className="diff-path">{text.path}</span>
        {op.op === 'add' ? (
          <>
            <span className="diff-arrow">=</span>
            <span className="diff-new">{text.value}</span>
          </>
        ) : (
          <span className="diff-old">{text.prev ?? 'undefined'}</span>
        )}
        {op.op === 'set' && (
          <>
            <span className="diff-arrow">→</span>
            <span className="diff-new">{text.value ?? 'undefined'}</span>
          </>
        )}
      </span>
    </div>
  );
}

const COUNT_LABELS: Array<[StateDiffOp['op'], string, string]> = [
  ['add', 'added', 'diff-new'],
  ['set', 'changed', 'diff-set'],
  ['del', 'removed', 'diff-old-count'],
];

function DiffGroup({ group, initiallyOpen }: { group: OpGroup; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const counts = COUNT_LABELS.filter(([op]) => group.counts[op] > 0);
  return (
    <div className="diff-group">
      <button type="button" className="diff-branch" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`caret${open ? ' open' : ''}`} />
        <span className="diff-path">{formatPath(group.path)}</span>
        <span className="diff-counts">
          {counts.map(([op, label, className], index) => (
            <span key={op} className={className}>
              {index > 0 && <span className="diff-arrow">·</span>}
              {group.counts[op]} {label}
            </span>
          ))}
        </span>
      </button>
      {open && group.ops.map((op, index) => <DiffOp key={index} op={op} />)}
    </div>
  );
}
