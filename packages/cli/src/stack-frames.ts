/** One line of a logged error's stack that points into a script at a URL. */
export interface Frame {
  lines: string[];
  index: number;
  /** `at` for Hermes and V8 (`    at fn (url:1:2)`), `@` for JSC, Safari and Firefox (`fn@url:1:2`). */
  style: 'at' | '@';
  indent: string;
  name: string | undefined;
  url: string;
  line: number;
  /** 1-based, as stacks print it. */
  column: number;
}

const AT_FRAME = /^(\s*)at (?:(.+?) \()?(https?:\/\/\S+?):(\d+):(\d+)\)?$/;
const JSC_FRAME = /^(\s*)(.*?)@(https?:\/\/\S+?):(\d+):(\d+)$/;

export function parseFrame(text: string, lines: string[], index: number): Frame | undefined {
  const at = AT_FRAME.exec(text);
  const match = at ?? JSC_FRAME.exec(text);
  if (!match) return undefined;
  return {
    lines,
    index,
    style: at ? 'at' : '@',
    indent: match[1]!,
    name: match[2] || undefined,
    url: match[3]!,
    line: Number(match[4]),
    column: Number(match[5]),
  };
}

/** The frame pointing at `file` instead, in the style it came in. `column` is 1-based. */
export function formatFrame(frame: Frame, file: string, line: number, column: number, name = frame.name): string {
  const location = `${file}:${line}:${column}`;
  if (frame.style === '@') return `${frame.indent}${name ?? ''}@${location}`;
  return `${frame.indent}at ${name ? `${name} (${location})` : location}`;
}
