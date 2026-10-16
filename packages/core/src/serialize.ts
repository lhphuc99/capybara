import type { SerializedValue, SpecialValue } from '@capybara/protocol';

export interface SerializeOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxItems?: number;
  maxString?: number;
  /** Objects visited per call. Stops runaway graphs such as React fibers reachable from a logged element. */
  maxNodes?: number;
}

/**
 * Self-contained, with no references to module scope: the Metro bridge runs `serialize.toString()`
 * inside React Native apps that don't have the SDK.
 */
export function serialize(value: unknown, options?: SerializeOptions): SerializedValue {
  const DEFAULTS: Required<SerializeOptions> = {
    maxDepth: 6,
    maxKeys: 100,
    maxItems: 100,
    maxString: 10_000,
    maxNodes: 2_000,
  };
  const REACT_ELEMENT_TYPES = new Set([Symbol.for('react.element'), Symbol.for('react.transitional.element')]);
  const o = options ? { ...DEFAULTS, ...options } : DEFAULTS;
  // Ancestors only, so shared references are repeated and only true cycles are marked.
  const ancestors = new Set<object>();
  let nodes = 0;

  const walk = (v: unknown, depth: number): SerializedValue => {
    switch (typeof v) {
      case 'string':
        return v.length > o.maxString ? { $t: 'string', v: v.slice(0, o.maxString), length: v.length } : v;
      case 'number':
        if (Number.isNaN(v)) return { $t: 'number', v: 'NaN' };
        if (v === Infinity) return { $t: 'number', v: 'Infinity' };
        if (v === -Infinity) return { $t: 'number', v: '-Infinity' };
        if (Object.is(v, -0)) return { $t: 'number', v: '-0' };
        return v;
      case 'boolean':
        return v;
      case 'undefined':
        return { $t: 'undefined' };
      case 'bigint':
        return { $t: 'bigint', v: v.toString() };
      case 'symbol':
        return { $t: 'symbol', v: v.toString() };
      case 'function':
        return { $t: 'function', name: functionName(v) };
    }
    if (v === null) return null;
    const obj = v as object;
    if (ancestors.has(obj)) return { $t: 'circular' };
    if (depth >= o.maxDepth || ++nodes > o.maxNodes) return { $t: 'limit', name: describe(obj) };
    ancestors.add(obj);
    try {
      return walkObject(obj, depth);
    } finally {
      ancestors.delete(obj);
    }
  };

  const walkProps = (obj: object, keys: string[], depth: number) => {
    const props: Record<string, SerializedValue> = {};
    const n = Math.min(keys.length, o.maxKeys);
    for (let i = 0; i < n; i++) {
      const key = keys[i]!;
      let child: unknown;
      try {
        child = (obj as Record<string, unknown>)[key];
      } catch (error) {
        props[key] = { $t: 'error', name: 'Error', message: `Getter threw: ${safeString(error)}` };
        continue;
      }
      props[key] = walk(child, depth + 1);
    }
    return { props, more: keys.length - n };
  };

  const walkObject = (obj: object, depth: number): SerializedValue => {
    if (Array.isArray(obj)) {
      const n = Math.min(obj.length, o.maxItems);
      const items: SerializedValue[] = [];
      for (let i = 0; i < n; i++) items.push(walk(obj[i], depth + 1));
      return obj.length > n ? { $t: 'array', items, length: obj.length } : items;
    }
    if (obj instanceof Error) {
      const { props } = walkProps(obj, ownKeys(obj).filter((k) => k !== 'stack' && k !== 'message'), depth);
      // `cause` passed to the Error constructor is non-enumerable.
      const cause = readProp(obj, 'cause');
      if (cause !== undefined && !('cause' in props)) props.cause = walk(cause, depth + 1);
      const out: Extract<SpecialValue, { $t: 'error' }> = {
        $t: 'error',
        name: safeString(readProp(obj, 'name')) || 'Error',
        message: safeString(readProp(obj, 'message')),
      };
      const stack = readProp(obj, 'stack');
      if (typeof stack === 'string') out.stack = stack.length > o.maxString ? stack.slice(0, o.maxString) : stack;
      if (Object.keys(props).length > 0) out.props = props;
      return out;
    }
    if (obj instanceof Date) {
      return { $t: 'date', v: Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
    }
    if (obj instanceof RegExp) return { $t: 'regexp', v: String(obj) };
    if (obj instanceof Map) {
      const entries: [SerializedValue, SerializedValue][] = [];
      for (const [key, val] of obj) {
        if (entries.length >= o.maxItems) break;
        entries.push([walk(key, depth + 1), walk(val, depth + 1)]);
      }
      return { $t: 'map', entries, size: obj.size };
    }
    if (obj instanceof Set) {
      const values: SerializedValue[] = [];
      for (const val of obj) {
        if (values.length >= o.maxItems) break;
        values.push(walk(val, depth + 1));
      }
      return { $t: 'set', values, size: obj.size };
    }
    if (obj instanceof ArrayBuffer) return { $t: 'binary', name: 'ArrayBuffer', size: obj.byteLength };
    if (ArrayBuffer.isView(obj)) return { $t: 'binary', name: constructorName(obj) || 'TypedArray', size: obj.byteLength };
    if (typeof Blob !== 'undefined' && obj instanceof Blob) return { $t: 'binary', name: 'Blob', size: obj.size };
    if (typeof Promise !== 'undefined' && obj instanceof Promise) return { $t: 'object', name: 'Promise', props: {} };
    if (typeof Node !== 'undefined' && obj instanceof Node) return { $t: 'node', v: describeNode(obj) };
    if (typeof window !== 'undefined' && obj === window) return { $t: 'object', name: 'Window', props: {} };
    if (REACT_ELEMENT_TYPES.has(readProp(obj, '$$typeof') as symbol)) return reactElement(obj, depth);

    const name = constructorName(obj);
    const { props, more } = walkProps(obj, ownKeys(obj), depth);
    const plain = name === 'Object' || name === '';
    if (plain && more === 0 && !('$t' in props)) return props;
    const out: Extract<SpecialValue, { $t: 'object' }> = { $t: 'object', props };
    if (!plain) out.name = name;
    if (more > 0) out.more = more;
    return out;
  };

  // Walking `_owner` would pull in the whole fiber tree.
  const reactElement = (element: object, depth: number): SerializedValue => {
    const type = readProp(element, 'type') as { displayName?: string; name?: string } | string | undefined;
    const typeName =
      typeof type === 'string' ? type : (type && (type.displayName || type.name)) || 'Anonymous';
    return {
      $t: 'object',
      name: `<${typeName}>`,
      props: {
        key: walk(readProp(element, 'key'), depth + 1),
        props: walk(readProp(element, 'props'), depth + 1),
      },
    };
  };

  function ownKeys(obj: object): string[] {
    try {
      return Object.keys(obj);
    } catch {
      return [];
    }
  }

  function readProp(obj: object, key: string): unknown {
    try {
      return (obj as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  }

  function safeString(value: unknown): string {
    try {
      return value instanceof Error ? value.message : String(value ?? '');
    } catch {
      return '';
    }
  }

  function functionName(fn: Function): string {
    try {
      return fn.name || 'anonymous';
    } catch {
      return 'anonymous';
    }
  }

  /** '' for null-prototype objects, 'Object' for plain objects and anything unreadable. */
  function constructorName(obj: object): string {
    try {
      const proto = Object.getPrototypeOf(obj);
      if (proto === null) return '';
      const ctor = proto.constructor;
      return typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name ? ctor.name : 'Object';
    } catch {
      return 'Object';
    }
  }

  function describe(obj: object): string {
    if (Array.isArray(obj)) return `Array(${obj.length})`;
    if (obj instanceof Map) return `Map(${obj.size})`;
    if (obj instanceof Set) return `Set(${obj.size})`;
    return constructorName(obj) || 'Object';
  }

  function describeNode(node: Node): string {
    if (node.nodeType === 1) {
      const el = node as Element;
      let out = `<${el.tagName.toLowerCase()}`;
      if (el.id) out += `#${el.id}`;
      const className = typeof el.className === 'string' ? el.className.trim() : '';
      if (className) out += `.${className.split(/\s+/).join('.')}`;
      return `${out}>`;
    }
    if (node.nodeType === 3) return `#text "${(node.textContent ?? '').slice(0, 50)}"`;
    return node.nodeName;
  }

  return walk(value, 0);
}
