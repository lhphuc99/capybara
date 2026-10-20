import {
  applySessionEvents,
  emptySessionModel,
  type CapybaraEvent,
  type LogEntry,
  type NetworkEntry,
  type SessionLimits,
  type StateRecord,
  type StateStoreInfo,
} from '@capybara-devtools/protocol';

/** The server keeps a bounded history already; the UI's own limits would hide part of it. */
const EVERYTHING: SessionLimits = { logs: Infinity, requests: Infinity, socketMessages: Infinity, records: Infinity };

/** Rebuilds logs, requests and sockets from a session's events, with the UI's reducer. */
export function readEvents(events: CapybaraEvent[]): { logs: LogEntry[]; requests: NetworkEntry[] } {
  const { logs, network } = applySessionEvents(emptySessionModel(), events, EVERYTHING);
  return { logs, requests: network };
}

/** One `state.change`, tagged with its store. */
export type ChangeEntry = StateRecord;

export interface StoreEntry {
  info: StateStoreInfo;
  /** Its changes in the history. */
  changes: number;
  last?: ChangeEntry;
}

export interface StateHistory {
  /** By id, in the order the history first names them. */
  stores: Map<string, StoreEntry>;
  /** Oldest first, across stores. */
  changes: ChangeEntry[];
}

/** Rebuilds the stores and their changes from a session's events, with the UI's reducer. */
export function readStateEvents(events: CapybaraEvent[]): StateHistory {
  const views = Object.values(applySessionEvents(emptySessionModel(), events, EVERYTHING).state.stores);
  return {
    stores: new Map(views.map((view) => [view.info.id, { info: view.info, changes: view.records.length, last: view.records.at(-1) }])),
    changes: views.flatMap((view) => view.records).sort((a, b) => a.seq - b.seq),
  };
}
