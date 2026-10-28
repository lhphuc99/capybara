import type { LogLevel, LogPayload, SerializedValue } from '@capybara-devtools/protocol';

// What the Dart VM service sends about a Flutter app, turned into the log entries an SDK would send.

export interface VmInstanceRef {
  id?: string;
  kind?: string;
  valueAsString?: string;
  valueAsStringIsTruncated?: boolean;
}

export interface VmLogRecord {
  level?: number;
  loggerName?: VmInstanceRef;
  message?: VmInstanceRef;
  error?: VmInstanceRef;
  stackTrace?: VmInstanceRef;
}

/** A node of the DiagnosticsNode tree that Flutter sends with each `Flutter.Error` event. */
export interface DiagnosticsNodeJson {
  type?: string;
  name?: string;
  description?: string;
  properties?: DiagnosticsNodeJson[];
  children?: DiagnosticsNodeJson[];
}

// Flutter prefixes print output with its logger tag before reporting it on the Stdout stream.
const PRINT_PREFIX = /^flutter: /;
const ERROR_BLOCK_START = /^══╡ EXCEPTION CAUGHT BY .* ╞═+$/;
const ERROR_BLOCK_END = /^═+$/;

/**
 * Joins what the engine writes for each `print` (the text, then its newline on its own) into one entry, so a
 * print of several lines stays one entry. Flutter's error reports, printed line by line when structured errors
 * are off (profile builds), become one error entry. `flush` writes out what is still waiting.
 */
export function createPrintReader(
  emit: (text: string, level: LogLevel, ts: number) => void,
  flushMs = 100,
): { write(text: string, stream: 'Stdout' | 'Stderr', ts: number): void; flush(): void } {
  const pending = { Stdout: '', Stderr: '' };
  const since = { Stdout: 0, Stderr: 0 };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let block: { lines: string[]; ts: number } | undefined;

  const line = (text: string, stream: 'Stdout' | 'Stderr', ts: number) => {
    const message = text.replace(PRINT_PREFIX, '');
    if (block) {
      block.lines.push(message);
      if (ERROR_BLOCK_END.test(message)) {
        emit(block.lines.join('\n'), 'error', block.ts);
        block = undefined;
      }
    } else if (ERROR_BLOCK_START.test(message)) {
      block = { lines: [message], ts };
    } else {
      emit(message, stream === 'Stderr' || message.startsWith('Another exception was thrown: ') ? 'error' : 'log', ts);
    }
  };

  const flushStream = (stream: 'Stdout' | 'Stderr') => {
    if (pending[stream]) line(pending[stream].replace(/\n$/, ''), stream, since[stream]);
    pending[stream] = '';
  };

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    flushStream('Stdout');
    flushStream('Stderr');
    if (block) {
      emit(block.lines.join('\n'), 'error', block.ts);
      block = undefined;
    }
  };

  return {
    write(text, stream, ts) {
      if (text === '\n') {
        flushStream(stream);
        return;
      }
      if (!pending[stream]) since[stream] = ts;
      pending[stream] += text;
      if (text.endsWith('\n')) {
        flushStream(stream);
      } else {
        clearTimeout(timer);
        timer = setTimeout(flush, flushMs);
        timer.unref?.();
      }
    },
    flush,
  };
}

/**
 * `dart:developer`'s levels follow package:logging (FINE 500, INFO 800, WARNING 900, SEVERE 1000);
 * `log()` without one uses 0.
 */
export function logRecordLevel(level: number | undefined): LogLevel {
  if (!level) return 'log';
  if (level < 800) return 'debug';
  if (level < 900) return 'info';
  if (level < 1000) return 'warn';
  return 'error';
}

export function logRecordPayload(record: VmLogRecord, message: string, error?: SerializedValue): LogPayload {
  const name = record.loggerName?.kind === 'String' ? record.loggerName.valueAsString : undefined;
  return {
    level: logRecordLevel(record.level),
    source: 'console',
    args: [name ? `[${name}] ${message}` : message, ...(error === undefined ? [] : [error])],
  };
}

/** A `Flutter.Error` event as an uncaught error with its stack, as the app's own error handler would report it. */
export function flutterErrorPayload(data: DiagnosticsNodeJson): LogPayload {
  const properties = data.properties ?? [];
  const summary = properties.find((node) => node.type === 'ErrorSummary')?.description;
  const description = properties.find((node) => node.type === 'ErrorDescription')?.description;
  const stack = properties.find((node) => node.type === 'DiagnosticsStackTrace');
  const widget = properties.find((node) => node.name === 'The relevant error-causing widget was');
  // "The following StateError was thrown building Cart(…):", "The following assertion was thrown during layout:".
  const thrown = description ? /^The following (.+?)(?: object)? was thrown/.exec(description)?.[1] : undefined;
  const props: Record<string, SerializedValue> = {};
  if (data.description) props.library = data.description;
  if (description) props.context = description.replace(/:$/, '');
  const location = widget?.children?.[0]?.description ?? widget?.properties?.[0]?.description;
  if (location) props.widget = location;
  const error: SerializedValue = {
    $t: 'error',
    name: thrown === 'assertion' ? 'AssertionError' : thrown && !/\s/.test(thrown) ? thrown : 'FlutterError',
    message: summary ?? data.description ?? 'Flutter error',
    ...(stack && {
      stack: [...(stack.children ?? []), ...(stack.properties ?? [])]
        .map((frame) => frame.description ?? '')
        .filter(Boolean)
        .join('\n'),
    }),
    ...(Object.keys(props).length > 0 && { props }),
  };
  return { level: 'error', source: 'uncaught', args: [error] };
}
