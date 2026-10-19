import type { SerializedValue, StatePath } from '@capybara-devtools/protocol';
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { formatKey, isSpecial, preview, valueText } from '../format';
import { ancestorKeys, pathKey } from '../state';
import { CopyButton } from './CopyButton';

interface Props {
  value: SerializedValue;
  /** Plain JSON (e.g. a response body): `$t` keys are ordinary keys, not type tags. */
  raw?: boolean;
  /** Levels expanded initially. */
  expandDepth?: number;
  /** Where `value` sits, e.g. `[]` for a store's whole state. Rows need their path for `onLoad` and `highlight`. */
  path?: StatePath;
  /** Reads a node the SDK cut to fit (`$t: 'limit'`) when it is opened; the caller then passes the value in. */
  onLoad?: (path: StatePath) => void | Promise<unknown>;
  /** `pathKey`s of the rows to mark as changed. The branches above them start open. */
  highlight?: ReadonlySet<string>;
}

/** Settings shared by every node of one tree. */
interface Tree {
  raw: boolean;
  expandDepth: number;
  onLoad?: (path: StatePath) => void | Promise<unknown>;
  highlight?: ReadonlySet<string>;
  above?: ReadonlySet<string>;
}

export function JsonTree({ value, raw = false, expandDepth = 1, path, onLoad, highlight }: Props) {
  const above = useMemo(() => highlight && ancestorKeys(highlight), [highlight]);
  return (
    <div className="tree">
      <TreeNode value={value} depth={0} path={path} tree={{ raw, expandDepth, onLoad, highlight, above }} />
    </div>
  );
}

interface NodeProps {
  name?: string;
  value: SerializedValue;
  depth: number;
  /** Missing when the tree has no path, or no path reaches the node (e.g. an error's stack). */
  path?: StatePath;
  tree: Tree;
}

function TreeNode({ name, value, depth, path, tree }: NodeProps) {
  const id = tree.highlight && path ? pathKey(path) : undefined;
  const [open, setOpen] = useState(() => depth < tree.expandDepth || (id !== undefined && tree.above!.has(id)));
  const children = childrenOf(value, tree.raw);
  const indent = { paddingLeft: depth * 14 };
  const changed = id !== undefined && tree.highlight!.has(id) ? ' changed' : '';
  const label =
    name === undefined ? null : (
      <>
        <span className="t-key">{name}</span>
        <span className="t-punct">: </span>
      </>
    );

  if (!children) {
    const { onLoad } = tree;
    if (onLoad && path && !tree.raw && isSpecial(value) && value.$t === 'limit') {
      return (
        <LimitRow
          label={label}
          value={value}
          indent={indent}
          changed={changed}
          onLoad={() => {
            setOpen(true);
            return onLoad(path);
          }}
        />
      );
    }
    return (
      <div className={`tree-row${changed}`} style={indent}>
        <span className="caret-space" />
        <span>
          {label}
          <Leaf value={value} raw={tree.raw} />
        </span>
        <CopyButton
          label={name === undefined ? 'Copy this value' : `Copy the value of ${name}`}
          text={() => valueText(value, tree.raw)}
          toast={(copied) => leafToast(copied, name)}
        />
      </div>
    );
  }

  return (
    <>
      <div className={`tree-row tree-branch${changed}`} style={indent} onClick={() => setOpen(!open)}>
        <span className={`caret${open ? ' open' : ''}`} />
        <span>
          {label}
          <span className="t-preview">{preview(value, tree.raw)}</span>
        </span>
        <CopyButton
          label={name === undefined ? 'Copy as JSON' : `Copy ${name} as JSON`}
          text={() => valueText(value, tree.raw)}
          toast={name === undefined ? 'Copied as JSON' : `Copied ${name} as JSON`}
        />
      </div>
      {open &&
        children.entries.map(([key, child, segment], index) => (
          <TreeNode
            key={`${index}:${key}`}
            name={key}
            value={child}
            depth={depth + 1}
            path={path && segment !== undefined ? [...path, segment] : undefined}
            tree={tree}
          />
        ))}
      {open && children.more > 0 && (
        <div className="tree-row t-muted" style={{ paddingLeft: (depth + 1) * 14 }}>
          <span className="caret-space" />… {children.more} more
        </div>
      )}
    </>
  );
}

/** A node cut from what the SDK sent; it opens once the value read for it comes back. */
function LimitRow({
  label,
  value,
  indent,
  changed,
  onLoad,
}: {
  label: ReactNode;
  value: SerializedValue;
  indent: CSSProperties;
  changed: string;
  onLoad: () => void | Promise<unknown>;
}) {
  const [loading, setLoading] = useState(false);
  const done = () => setLoading(false);
  return (
    <div
      className={`tree-row tree-branch${changed}`}
      style={indent}
      title="Not read yet. Click to load it from the app."
      onClick={() => {
        if (loading) return;
        setLoading(true);
        Promise.resolve(onLoad()).then(done, done);
      }}
    >
      <span className="caret" />
      <span>
        {label}
        <span className="t-muted">{loading ? 'Loading…' : preview(value)}</span>
      </span>
    </div>
  );
}

/** Short values are shown, so it is clear that only the value was copied, without its key or quotes. */
function leafToast(copied: string, name: string | undefined): string {
  if (copied === '') return 'Copied an empty string';
  if (copied.length <= 40 && !copied.includes('\n')) return `Copied: ${copied}`;
  return name === undefined ? 'Copied the value' : `Copied the value of ${name}`;
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

/** Each child's label, value, and the key that reaches it in a path (none for what a path cannot name). */
type Child = [string, SerializedValue, (string | number)?];

interface Children {
  entries: Child[];
  more: number;
}

function childrenOf(value: SerializedValue, raw: boolean): Children | null {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    return value.length > 0 ? { entries: value.map((v, i) => [String(i), v, i]), more: 0 } : null;
  }
  if (!raw && isSpecial(value)) {
    switch (value.$t) {
      case 'array':
        return { entries: value.items.map((v, i) => [String(i), v, i]), more: value.length - value.items.length };
      case 'object': {
        const entries = Object.entries(value.props).map(([k, v]): Child => [formatKey(k), v, k]);
        return entries.length > 0 || value.more ? { entries, more: value.more ?? 0 } : null;
      }
      case 'map':
        return {
          entries: value.entries.map(([k, v]): Child => [
            `${preview(k, false, true)} →`,
            v,
            typeof k === 'string' || typeof k === 'number' ? k : undefined,
          ]),
          more: value.size - value.entries.length,
        };
      case 'set':
        return { entries: value.values.map((v, i) => [String(i), v, i]), more: value.size - value.values.length };
      case 'error': {
        const entries: Child[] = [['message', value.message]];
        if (value.stack) entries.push(['stack', value.stack]);
        for (const [k, v] of Object.entries(value.props ?? {})) entries.push([formatKey(k), v]);
        return { entries, more: 0 };
      }
      default:
        return null;
    }
  }
  const entries = Object.entries(value as Record<string, SerializedValue>).map(([k, v]): Child => [formatKey(k), v, k]);
  return entries.length > 0 ? { entries, more: 0 } : null;
}
