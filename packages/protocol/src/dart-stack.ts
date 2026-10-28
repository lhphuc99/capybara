import type { DartPackages } from './index.js';

// Reading Dart stack traces, for the UI and the MCP server. Debug builds already point at source files, so
// nothing is mapped: frames are only sorted into the app's own and the rest, which are folded away.

/** `sdk`: dart: libraries. `framework`: packages of the Flutter SDK. `internal`: Capybara's own package. */
export type DartFrameKind = 'sdk' | 'framework' | 'internal' | 'library' | 'app';

export interface DartStackLine {
  /** The line without surrounding whitespace. */
  text: string;
  /** `gap` is an async gap; `elided` a run of frames Flutter left out; `aot` an unsymbolized release frame. */
  kind: DartFrameKind | 'gap' | 'elided' | 'aot' | 'other';
  name?: string;
  /** DDC's `packages/<name>/…` URLs are given as `package:<name>/…`. */
  uri?: string;
  line?: number;
  column?: number;
}

// `#3      _HomeState.build (package:app/main.dart:72:16)`, as the VM prints a StackTrace.
const VM_FRAME = /^#(\d+)\s+(\S.*) \((.+?)(?::(\d+))?(?::(\d+))?\)$/;
// package:stack_trace's terse form, which flutter_test and DDC print: `package:app/main.dart 72:16  build`.
// The location must look like a URI or a .dart path: stack_trace's own pattern also matches "Error: boom".
const TERSE_FRAME =
  /^((?:dart:|package:|packages\/|file:\/\/|org-dartlang-[a-z]+:|https?:\/\/)\S*|\S+\.dart)(?: (\d+)(?::(\d+))?)?\s+([^\s\d].*)$/;
const ASYNC_GAP = /^(?:<asynchronous suspension>|===== asynchronous gap =+)$/;
const ELIDED = /^\(elided (?:one|\d+) frames? from .+\)$|^\.\.\.$/;
// Release builds with --split-debug-info: `#00 abs 000000723d6346d7 virt 00000000001ed6d7 _kDartIsolateSnapshot…`.
const AOT_FRAME = /^#\d+ abs [\da-f]+(?: unit \d+)?(?: virt [\da-f]+)? .*$/;
const AOT_HEADER = /^\*\*\* \*\*\* \*\*\*|^build_id(?:=|: )'[\da-f]+'/;

/** Packages of the Flutter SDK. A name prefix would also take in flutter_bloc, flutter_riverpod and the like. */
const FLUTTER_SDK_PACKAGES = new Set([
  'flutter',
  'flutter_driver',
  'flutter_goldens',
  'flutter_localizations',
  'flutter_test',
  'flutter_web_plugins',
  'fuchsia_remote_debug_protocol',
  'integration_test',
  'sky_engine',
]);

/**
 * The lines of a Dart stack trace. Undefined when it has no Dart frame, so a JS stack keeps being read as one.
 * Without `packages`, frames of `package:` URIs count as libraries, since nothing says which package is the app.
 */
export function parseDartStack(stack: string, packages?: DartPackages): DartStackLine[] | undefined {
  let dart = false;
  const lines: DartStackLine[] = [];
  for (const raw of stack.split('\n')) {
    const text = raw.trim();
    if (!text) continue;
    const { line, certain } = parseLine(text, packages);
    dart ||= certain;
    lines.push(line);
  }
  return dart ? lines : undefined;
}

function parseLine(text: string, packages: DartPackages | undefined): { line: DartStackLine; certain: boolean } {
  const vm = VM_FRAME.exec(text);
  if (vm) {
    const uri = normalizeUri(vm[3]!);
    return { line: { text, kind: frameKind(uri, packages), name: vm[2], uri, ...position(vm[4], vm[5]) }, certain: true };
  }
  if (AOT_FRAME.test(text) || AOT_HEADER.test(text)) return { line: { text, kind: 'aot' }, certain: true };
  if (ASYNC_GAP.test(text)) return { line: { text, kind: 'gap' }, certain: false };
  if (ELIDED.test(text)) return { line: { text, kind: 'elided' }, certain: false };
  const terse = TERSE_FRAME.exec(text);
  // A terse line without a line number reads like prose ("package:x failed to load"), so it never makes a
  // stack Dart on its own; nor does a web URL, which messages often hold.
  if (terse) {
    const uri = normalizeUri(terse[1]!);
    return {
      line: { text, kind: frameKind(uri, packages), name: terse[4], uri, ...position(terse[2], terse[3]) },
      certain: terse[2] !== undefined && !/^https?:/.test(uri),
    };
  }
  return { line: { text, kind: 'other' }, certain: false };
}

function position(line: string | undefined, column: string | undefined): Pick<DartStackLine, 'line' | 'column'> {
  return {
    ...(line === undefined ? {} : { line: Number(line) }),
    ...(column === undefined ? {} : { column: Number(column) }),
  };
}

function normalizeUri(uri: string): string {
  return uri.startsWith('packages/') ? `package:${uri.slice('packages/'.length)}` : uri;
}

function frameKind(uri: string, packages: DartPackages | undefined): DartFrameKind {
  if (/^(?:dart:|package:dart-sdk\/|org-dartlang-sdk:)/.test(uri)) return 'sdk';
  const name = /^package:([^/]+)\//.exec(uri)?.[1];
  if (name === undefined) return 'app';
  if (name === 'capybara_devtools' || name.startsWith('capybara_devtools_')) return 'internal';
  if (FLUTTER_SDK_PACKAGES.has(name)) return 'framework';
  return packages?.app.includes(name) ? 'app' : 'library';
}

/** Whether a line is a frame of code the app runs, as opposed to an async gap, a note or a header. */
export function isDartFrame(line: DartStackLine): boolean {
  return line.uri !== undefined;
}

/** Whether the UI and the MCP server fold the frame away: the Dart SDK, the Flutter SDK and Capybara itself. */
export function isFoldedDartFrame(line: DartStackLine): boolean {
  return line.kind === 'sdk' || line.kind === 'framework' || line.kind === 'internal';
}

/** `name (uri:line:column)`, without the frame number and padding the VM adds. */
export function formatDartFrame(line: DartStackLine): string {
  if (!isDartFrame(line)) return line.text;
  const location = [line.uri, line.line, line.column].filter((part) => part !== undefined).join(':');
  return line.name ? `${line.name} (${location})` : location;
}

/**
 * The top frames that are not folded away, for a list of errors: Flutter's own frames often fill the first
 * several lines. When every frame is folded, the top ones anyway. Empty when the stack is not Dart.
 */
export function dartStackTop(stack: string, packages?: DartPackages, count = 3): string[] {
  const frames = (parseDartStack(stack, packages) ?? []).filter(isDartFrame);
  const own = frames.filter((frame) => !isFoldedDartFrame(frame));
  return (own.length > 0 ? own : frames).slice(0, count).map(formatDartFrame);
}

/** The file a frame's URI points at on this computer, when known: `file:` URIs, and packages listed in `dirs`. */
export function dartSourcePath(uri: string, packages?: DartPackages): string | undefined {
  if (uri.startsWith('file://')) {
    try {
      // file:///C:/app/main.dart is C:/app/main.dart on Windows.
      return decodeURIComponent(uri.slice('file://'.length).replace(/^\/([A-Za-z]:\/)/, '$1'));
    } catch {
      return undefined;
    }
  }
  const match = /^package:([^/]+)\/(.+)$/.exec(uri);
  const dir = match ? packages?.dirs?.[match[1]!] : undefined;
  return match && dir ? `${dir.replace(/\/+$/, '')}/${match[2]}` : undefined;
}
