import type { SerializedValue } from '@capybara/protocol';
import { useState, type ReactNode } from 'react';
import { formatKey, isSpecial, preview } from '../format';

interface Props {
  value: SerializedValue;
  /** Plain JSON (e.g. a response body): `$t` keys are ordinary keys, not type tags. */
  raw?: boolean;
  /** Levels expanded initially. */
  expandDepth?: number;
}

export function JsonTree({ value, raw = false, expandDepth = 1 }: Props) {
  return (
    <div className="tree">
      <TreeNode value={value} depth={0} raw={raw} expandDepth={expandDepth} />
    </div>
  );
}

interface NodeProps {
  name?: string;
  value: SerializedValue;
  depth: number;
  raw: boolean;
  expandDepth: number;
}

function TreeNode({ name, value, depth, raw, expandDepth }: NodeProps) {
  const [open, setOpen] = useState(depth < expandDepth);
  const children = childrenOf(value, raw);
  const indent = { paddingLeft: depth * 14 };
  const label =
    name === undefined ? null : (
      <>
        <span className="t-key">{name}</span>
        <span className="t-punct">: </span>
      </>
    );

  if (!children) {
    return (
      <div className="tree-row" style={indent}>
        <span className="caret-space" />
        <span>
          {label}
          <Leaf value={value} raw={raw} />
        </span>
      </div>
    );
  }

  return (
    <>
      <div className="tree-row tree-branch" style={indent} onClick={() => setOpen(!open)}>
        <span className={`caret${open ? ' open' : ''}`} />
        <span>
          {label}
          <span className="t-preview">{preview(value, raw)}</span>
        </span>
      </div>
      {open &&
        children.entries.map(([key, child], index) => (
          <TreeNode key={`${index}:${key}`} name={key} value={child} depth={depth + 1} raw={raw} expandDepth={expandDepth} />
        ))}
      {open && children.more > 0 && (
        <div className="tree-row t-muted" style={{ paddingLeft: (depth + 1) * 14 }}>
          <span className="caret-space" />… {children.more} more
        </div>
      )}
    </>
  );
}

function Leaf({ value, raw }: { value: SerializedValue; raw: boolean }): ReactNode {
  if (value === null) return <span className="t-literal">null</span>;
  if (typeof value === 'string') return <span className="t-string">"{value}"</span>;
  if (typeof value === 'number') return <span className="t-number">{value}</span>;
  if (typeof value === 'boolean') return <span className="t-literal">{String(value)}</span>;
  if (!raw && isSpecial(value)) {
    if (value.$t === 'string') {
      return (
        <span className="t-string">
          "{value.v}…" <span className="t-muted">({value.length.toLocaleString()} chars, truncated)</span>
        </span>
      );
    }
    if (value.$t === 'number' || value.$t === 'bigint') return <span className="t-number">{preview(value)}</span>;
    if (value.$t === 'undefined') return <span className="t-literal">undefined</span>;
    return <span className="t-muted">{preview(value)}</span>;
  }
  // Empty object or array.
  return <span className="t-preview">{preview(value, raw)}</span>;
}

interface Children {
  entries: Array<[string, SerializedValue]>;
  more: number;
}

function childrenOf(value: SerializedValue, raw: boolean): Children | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? { entries: value.map((v, i) => [String(i), v]), more: 0 } : null;
  }
  if (!raw && isSpecial(value)) {
    switch (value.$t) {
      case 'array':
        return { entries: value.items.map((v, i) => [String(i), v]), more: value.length - value.items.length };
      case 'object': {
        const entries = Object.entries(value.props).map(([k, v]): [string, SerializedValue] => [formatKey(k), v]);
        return entries.length > 0 || value.more ? { entries, more: value.more ?? 0 } : null;
      }
      case 'map':
        return {
          entries: value.entries.map(([k, v]): [string, SerializedValue] => [`${preview(k, false, true)} →`, v]),
          more: value.size - value.entries.length,
        };
      case 'set':
        return { entries: value.values.map((v, i) => [String(i), v]), more: value.size - value.values.length };
      case 'error': {
        const entries: Array<[string, SerializedValue]> = [['message', value.message]];
        if (value.stack) entries.push(['stack', value.stack]);
        for (const [k, v] of Object.entries(value.props ?? {})) entries.push([formatKey(k), v]);
        return { entries, more: 0 };
      }
      default:
        return null;
    }
  }
  const entries = Object.entries(value as Record<string, SerializedValue>).map(
    ([k, v]): [string, SerializedValue] => [formatKey(k), v],
  );
  return entries.length > 0 ? { entries, more: 0 } : null;
}
