import {
  dartSourcePath,
  isDartFrame,
  isFoldedDartFrame,
  type DartPackages,
  type DartStackLine,
} from '@capybara-devtools/protocol';
import { createContext, useContext, useState, type KeyboardEvent } from 'react';

/** Which packages are the app's own, for the session whose values are shown. */
export const DartPackagesContext = createContext<DartPackages | undefined>(undefined);

export function useDartPackages(): DartPackages | undefined {
  return useContext(DartPackagesContext);
}

type Item = { kind: 'line'; line: DartStackLine } | { kind: 'fold'; source: string; lines: DartStackLine[] };

/** `flutter`, `dart:ui`, `capybara_devtools`: what a frame of Flutter, the Dart SDK or Capybara comes from. */
function sourceOf(uri: string): string {
  const pkg = /^package:([^/]+)\//.exec(uri)?.[1];
  if (pkg) return pkg === 'dart-sdk' ? 'dart' : pkg;
  return /^(dart:[^/]+)/.exec(uri)?.[1] ?? 'dart';
}

/** Runs of folded frames from the same source become one row each; the app's own frames stay open. */
function group(lines: DartStackLine[]): Item[] {
  const items: Item[] = [];
  for (const line of lines) {
    if (isDartFrame(line) && isFoldedDartFrame(line)) {
      const source = sourceOf(line.uri!);
      const last = items.at(-1);
      if (last?.kind === 'fold' && last.source === source) last.lines.push(line);
      else items.push({ kind: 'fold', source, lines: [line] });
    } else {
      items.push({ kind: 'line', line });
    }
  }
  return items;
}

/** The rows of a Dart stack inside a value tree, at `depth`. */
export function DartStackRows({ lines, depth }: { lines: DartStackLine[]; depth: number }) {
  const packages = useDartPackages();
  const items = group(lines);
  const symbolize = lines.some((line) => line.kind === 'aot');
  return (
    <>
      {symbolize && (
        <div className="tree-row t-muted" style={{ paddingLeft: depth * 14 }}>
          <span className="caret-space" />
          This stack comes from a release build: run <code>flutter symbolize</code> with the app's debug symbols to read it.
        </div>
      )}
      {items.map((item, index) =>
        item.kind === 'fold' ? (
          <Fold key={index} source={item.source} lines={item.lines} depth={depth} packages={packages} />
        ) : (
          <Line key={index} line={item.line} depth={depth} packages={packages} />
        ),
      )}
    </>
  );
}

function Fold({ source, lines, depth, packages }: { source: string; lines: DartStackLine[]; depth: number; packages?: DartPackages }) {
  const [open, setOpen] = useState(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') setOpen(!open);
    else if (event.key === 'ArrowRight' && !open) setOpen(true);
    else if (event.key === 'ArrowLeft' && open) setOpen(false);
    else return;
    event.preventDefault();
  };
  return (
    <>
      <div
        className="tree-row tree-branch fold"
        style={{ paddingLeft: depth * 14 }}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={open}
        tabIndex={-1}
        onClick={() => setOpen(!open)}
        onKeyDown={onKeyDown}
      >
        <span className={`caret${open ? ' open' : ''}`} />
        <span className="fold-text">
          <b>
            {lines.length} {lines.length === 1 ? 'frame' : 'frames'}
          </b>{' '}
          from {source}
        </span>
      </div>
      {open && lines.map((line, index) => <Line key={index} line={line} depth={depth + 1} packages={packages} dim />)}
    </>
  );
}

function Line({ line, depth, packages, dim = false }: { line: DartStackLine; depth: number; packages?: DartPackages; dim?: boolean }) {
  const indent = { paddingLeft: depth * 14 };
  if (!isDartFrame(line)) {
    const text = line.kind === 'gap' ? 'asynchronous suspension' : line.text;
    return (
      <div className="tree-row t-muted" style={indent} role="treeitem" aria-level={depth + 1} tabIndex={-1}>
        <span className="caret-space" />
        {text}
      </div>
    );
  }
  const number = /^#\d+/.exec(line.text)?.[0];
  const location = [line.uri, line.line, line.column].filter((part) => part !== undefined).join(':');
  const kind = line.kind === 'app' ? ' app' : dim ? ' dim' : '';
  return (
    <div
      className={`tree-row frame${kind}`}
      style={indent}
      role="treeitem"
      aria-level={depth + 1}
      tabIndex={-1}
      title={dartSourcePath(line.uri!, packages)}
    >
      <span className="caret-space" />
      {number && <span className="f-num">{number}</span>}
      <span className="f-body">
        {line.name && <span className="f-name">{line.name}</span>}{' '}
        <span className="f-loc">
          {/* Long package paths break after a slash on narrow screens, not inside a name. */}
          {location.split('/').map((part, index) => (
            <span key={index}>
              {index > 0 && (
                <>
                  /<wbr />
                </>
              )}
              {part}
            </span>
          ))}
        </span>
      </span>
    </div>
  );
}
