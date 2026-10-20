import * as mobx from 'mobx';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, createActor, createMachine } from 'xstate';
import { CLIENT_GLOBAL, serialize, statePlugin, watchMobX, watchXState, type PluginContext } from '../src/index.js';
import { REGISTRY_GLOBAL } from '../src/plugins/state/registry.js';

type Recorded = { kind: string; payload: any };

const scope = globalThis as Record<string, any>;
const teardowns: Array<() => void> = [];

function harness() {
  const events: Recorded[] = [];
  const ctx: PluginContext = { emit: (kind, payload) => events.push({ kind, payload }), serialize, console };
  const teardown = statePlugin().setup!(ctx) as () => void;
  teardowns.push(teardown);
  return (kind: string) => events.filter((e) => e.kind === kind).map((e) => e.payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal(CLIENT_GLOBAL, { connected: true });
});

afterEach(() => {
  for (const teardown of teardowns.splice(0)) teardown();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete scope[REGISTRY_GLOBAL];
});

const toggle = createMachine({
  id: 'toggle',
  initial: 'off',
  context: { flips: 0 },
  states: {
    off: { on: { FLIP: { target: 'on', actions: assign({ flips: ({ context }) => context.flips + 1 }) } } },
    on: { on: { FLIP: 'off' } },
  },
});

describe('watchXState', () => {
  it('shows each transition with the event behind it, and the state value and context', () => {
    const of = harness();
    const actor = createActor(toggle).start();
    const undo = watchXState(actor);
    actor.send({ type: 'FLIP', by: 'user' });
    vi.advanceTimersByTime(100);
    actor.send({ type: 'FLIP' });
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'xstate:1', library: 'xstate', label: 'toggle', via: 'subscribe', actions: true } }]);
    expect(of('state.change')).toEqual([
      {
        store: 'xstate:1',
        rev: 1,
        cause: 'action',
        action: { type: 'FLIP', payload: { by: 'user' } },
        ops: [
          { op: 'set', path: ['value'], value: 'on', prev: 'off' },
          { op: 'set', path: ['context', 'flips'], value: 1, prev: 0 },
        ],
      },
      { store: 'xstate:1', rev: 2, cause: 'action', action: { type: 'FLIP' }, ops: [{ op: 'set', path: ['value'], value: 'off', prev: 'on' }] },
    ]);
    undo();
    expect(of('state.store').at(-1).store.disposed).toBe(true);
    // Watching once more after undoing registers it again.
    watchXState(actor, { name: 'again' });
    expect(of('state.store').at(-1).store).toMatchObject({ label: 'again', library: 'xstate' });
  });

  it('ignores what is not an actor', () => {
    const of = harness();
    watchXState({ getSnapshot: () => ({}) } as never);
    expect(of('state.store')).toEqual([]);
  });
});

class Cart {
  items: Array<{ id: number; price: number }> = [];
  total = 0;
  constructor() {
    mobx.makeAutoObservable(this);
  }
  add(item: { id: number; price: number }) {
    this.items.push(item);
    this.total += item.price;
  }
}

describe('watchMobX', () => {
  it('shows each change as a diff, named after the action that made it', () => {
    const of = harness();
    const cart = new Cart();
    watchMobX(cart, mobx, { name: 'cart' });
    cart.add({ id: 1, price: 2 });
    vi.advanceTimersByTime(100);
    mobx.runInAction(() => {
      cart.total = 10;
    });
    vi.advanceTimersByTime(100);

    expect(of('state.store')).toEqual([{ store: { id: 'mobx:1', library: 'mobx', label: 'cart', via: 'subscribe', actions: true } }]);
    expect(of('state.change')).toEqual([
      {
        store: 'mobx:1',
        rev: 1,
        cause: 'action',
        action: { type: 'add' },
        ops: [
          { op: 'add', path: ['items', 0], value: { id: 1, price: 2 } },
          { op: 'set', path: ['total'], value: 2, prev: 0 },
        ],
      },
      { store: 'mobx:1', rev: 2, cause: 'set', ops: [{ op: 'set', path: ['total'], value: 10, prev: 2 }] },
    ]);
  });

  it('works without spy, without action names', () => {
    const of = harness();
    const counter = mobx.observable({ n: 0 });
    watchMobX(counter, { reaction: mobx.reaction, toJS: mobx.toJS });
    mobx.runInAction(() => {
      counter.n = 1;
    });
    vi.advanceTimersByTime(100);
    expect(of('state.store')[0].store).toMatchObject({ library: 'mobx', label: expect.stringMatching(/^MobX store #\d+$/), actions: false });
    expect(of('state.change')).toEqual([{ store: 'mobx:1', rev: 1, cause: 'set', ops: [{ op: 'set', path: ['n'], value: 1, prev: 0 }] }]);
  });
});
