import { describe, expect, it } from 'vitest';
import { serialize, storagePlugin, type PluginContext, type StorageAdapter } from '../src/index.js';

function memoryAdapter(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  const listeners = new Set<(op: any, key?: string) => void>();
  const adapter: StorageAdapter = {
    id: 'memory',
    label: 'Memory',
    keys: () => [...data.keys()],
    get: (key) => data.get(key) ?? null,
    set: (key, value) => {
      data.set(key, value);
      for (const l of listeners) l('set', key);
    },
    remove: (key) => data.delete(key),
    clear: () => data.clear(),
    watch: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
  return { adapter, data };
}

function harness(adapters: StorageAdapter[]) {
  const events: Array<{ kind: string; payload: any }> = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const plugin = storagePlugin(adapters);
  const teardown = plugin.setup!(ctx) as () => void;
  return { commands: plugin.commands!, events, teardown };
}

describe('storagePlugin', () => {
  it('lists adapters with their capabilities', () => {
    const readOnly: StorageAdapter = { id: 'ro', label: 'Read only', keys: () => [], get: () => null };
    const { commands } = harness([memoryAdapter({}).adapter, readOnly]);
    expect(commands.list!(undefined)).toEqual([
      { id: 'memory', label: 'Memory', readOnly: false, canClear: true, note: undefined },
      { id: 'ro', label: 'Read only', readOnly: true, canClear: false, note: undefined },
    ]);
  });

  it('returns sorted entries with sizes and truncates long previews', async () => {
    const { adapter } = memoryAdapter({ b: '2', a: 'é', long: 'x'.repeat(2_500) });
    const { commands } = harness([adapter]);
    const result = (await commands.entries!({ adapter: 'memory' })) as any;
    expect(result.total).toBe(3);
    expect(result.entries.map((e: any) => e.key)).toEqual(['a', 'b', 'long']);
    expect(result.entries[0]).toEqual({ key: 'a', value: 'é', size: 2, truncated: false });
    expect(result.entries[2]).toMatchObject({ size: 2_500, truncated: true });
    expect(result.entries[2].value).toHaveLength(2_000);

    const full = (await commands.get!({ adapter: 'memory', key: 'long' })) as any;
    expect(full).toMatchObject({ truncated: false, size: 2_500 });
  });

  it('writes through to the adapter and reports app writes', async () => {
    const { adapter, data } = memoryAdapter({});
    const { commands, events, teardown } = harness([adapter]);
    await commands.set!({ adapter: 'memory', key: 'token', value: 'abc' });
    expect(data.get('token')).toBe('abc');
    expect(events).toEqual([{ kind: 'storage.change', payload: { adapter: 'memory', op: 'set', key: 'token' } }]);
    await commands.remove!({ adapter: 'memory', key: 'token' });
    expect(data.has('token')).toBe(false);
    teardown();
    adapter.set!('after', '1');
    expect(events).toHaveLength(1);
  });

  it('rejects unknown adapters and writes to read-only ones', async () => {
    const readOnly: StorageAdapter = { id: 'ro', label: 'Read only', keys: () => [], get: () => null };
    const { commands } = harness([readOnly]);
    await expect(commands.entries!({ adapter: 'nope' })).rejects.toThrow('Unknown storage "nope"');
    await expect(commands.set!({ adapter: 'ro', key: 'k', value: 'v' })).rejects.toThrow('Read only is read-only');
  });
});
