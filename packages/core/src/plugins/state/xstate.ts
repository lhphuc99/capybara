import type { StoreDriver } from './index.js';
import { defaultLabel } from './redux.js';
import { register, unregister } from './registry.js';

/** What Capybara reads of an XState actor, the one `createActor(machine)` returns. XState 5. */
export interface XStateActorLike {
  getSnapshot(): unknown;
  send(event: any): void;
  subscribe(listener: (snapshot: any) => void): { unsubscribe(): void };
  system?: { inspect?(observer: (event: any) => void): { unsubscribe(): void } | undefined };
  logic?: { id?: unknown };
}

export interface WatchXStateOptions {
  /** Shown in the State tab. Defaults to the machine's id, then "XState actor #n". */
  name?: string;
}

const watched = new WeakMap<object, { driver: StoreDriver; id: string | undefined }>();

function isActorLike(value: unknown): value is XStateActorLike {
  const actor = value as Partial<XStateActorLike> | null;
  return (
    actor !== null &&
    typeof actor === 'object' &&
    typeof actor.getSnapshot === 'function' &&
    typeof actor.send === 'function' &&
    typeof actor.subscribe === 'function'
  );
}

/** What a snapshot says about the machine: the state it is in, its context, and how it ended. */
function stateOf(snapshot: unknown): unknown {
  const s = snapshot as { value?: unknown; context?: unknown; status?: unknown; output?: unknown; error?: unknown } | null;
  if (s === null || typeof s !== 'object') return s;
  const state: Record<string, unknown> = { value: s.value, context: s.context, status: s.status };
  if (s.output !== undefined) state.output = s.output;
  if (s.error !== undefined) state.error = s.error;
  return state;
}

/**
 * Shows an XState actor in the State tab: each transition with the event that caused it, and its state value,
 * context and status. Returns a function that undoes this call.
 */
export function watchXState(actor: XStateActorLike, options: WatchXStateOptions = {}): () => void {
  if (typeof window === 'undefined' || !isActorLike(actor)) return () => {};
  try {
    const known = watched.get(actor);
    if (known) {
      known.id = register(known.driver, actor) ?? known.id;
      return () => {};
    }
    // The inspection API names the event behind each snapshot; subscribe() only gives the snapshot.
    const inspect = typeof actor.system?.inspect === 'function';
    const driver: StoreDriver = {
      info: { library: 'xstate', label: labelOf(actor, options), via: 'subscribe', actions: inspect },
      getState: () => stateOf(actor.getSnapshot()),
      start(sink, id) {
        if (inspect) {
          const subscription = actor.system!.inspect!((event) => {
            if (event?.type !== '@xstate.snapshot' || event.actorRef !== actor) return;
            const cause = event.event as { type?: unknown } | undefined;
            if (typeof cause?.type === 'string' && cause.type !== 'xstate.init') sink.record(id, stateOf(event.snapshot), cause, 'action');
            else sink.record(id, stateOf(event.snapshot), undefined, 'set');
          });
          return () => subscription?.unsubscribe();
        }
        const subscription = actor.subscribe((snapshot) => sink.record(id, stateOf(snapshot), undefined, 'set'));
        return () => subscription.unsubscribe();
      },
    };
    const entry = { driver, id: undefined as string | undefined };
    watched.set(actor, entry);
    entry.id = register(driver, actor);
    let undone = false;
    return () => {
      if (undone) return;
      undone = true;
      watched.delete(actor);
      if (entry.id !== undefined) unregister(entry.id);
    };
  } catch {
    return () => {};
  }
}

function labelOf(actor: XStateActorLike, options: WatchXStateOptions): string {
  if (typeof options.name === 'string' && options.name !== '') return options.name;
  const id = actor.logic?.id;
  // XState names machines without an id "(machine)".
  if (typeof id === 'string' && id !== '' && id !== '(machine)') return id;
  return defaultLabel('xstate', (stateOf(actor.getSnapshot()) as { context?: unknown } | null)?.context);
}
