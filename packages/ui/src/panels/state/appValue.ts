import type { SerializedValue, StatePath } from '@capybara-devtools/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { graftValue, pathKey } from '../../state';

export const ROOT: StatePath = [];

export type StateRead = { value: SerializedValue; truncated: boolean; rev: number; pending: boolean };
export type EntryRead = { value: SerializedValue; truncated: boolean };

interface Part {
  path: StatePath;
  value: SerializedValue;
}

export interface AppValue<T> {
  /** Undefined until the first read; null when the app no longer has the value. */
  root: T | null | undefined;
  /** `root.value` with the parts opened since grafted in. */
  value: SerializedValue | undefined;
  error: string | null;
  load: (path: StatePath) => Promise<void>;
}

/**
 * A value read from the app while `enabled`: again within 250 ms of `version` changing, and at once when `urgent`
 * does, since a reader cannot rebuild what it missed. Parts opened with `load` are read again with it.
 */
export function useAppValue<T extends { value: SerializedValue }>(
  read: (path?: StatePath) => Promise<T | null>,
  enabled: boolean,
  version: unknown,
  urgent: unknown,
): AppValue<T> {
  const [reading, setReading] = useState<{ root?: T | null; parts: Part[] }>({ parts: [] });
  const [error, setError] = useState<string | null>(null);
  const partsRef = useRef<Part[]>([]);
  const requestRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const seenRef = useRef({ enabled: false, urgent });

  useEffect(() => {
    partsRef.current = reading.parts;
  }, [reading.parts]);

  const refresh = useCallback(() => {
    const id = ++requestRef.current;
    const opened = partsRef.current;
    const reads = opened.map((part) =>
      read(part.path).then(
        (result): Part | null => result && { path: part.path, value: result.value },
        () => null,
      ),
    );
    Promise.all([read(), ...reads]).then(
      ([root, ...found]) => {
        if (id !== requestRef.current) return;
        const asked = new Set(opened.map((part) => pathKey(part.path)));
        setReading((current) => ({
          root: root as T | null,
          parts: [
            ...(found as Array<Part | null>).filter((part): part is Part => part !== null),
            // Opened while this read was on its way.
            ...current.parts.filter((part) => !asked.has(pathKey(part.path))),
          ],
        }));
        setError(null);
      },
      (reason: Error) => {
        if (id === requestRef.current) setError(reason.message);
      },
    );
  }, [read]);

  useEffect(() => {
    const seen = seenRef.current;
    seenRef.current = { enabled, urgent };
    if (!enabled) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      return;
    }
    if (!seen.enabled || seen.urgent !== urgent) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
      refresh();
    } else if (timerRef.current === undefined) {
      // Not reset by later changes, so a store that changes all the time is still read every 250 ms.
      timerRef.current = window.setTimeout(() => {
        timerRef.current = undefined;
        refresh();
      }, 250);
    }
  }, [enabled, version, urgent, refresh]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const load = useCallback(
    (path: StatePath) =>
      read(path).then(
        (result) => {
          if (!result) return;
          const key = pathKey(path);
          setReading((current) => ({
            ...current,
            parts: [...current.parts.filter((part) => pathKey(part.path) !== key), { path, value: result.value }],
          }));
        },
        (reason: Error) => setError(reason.message),
      ),
    [read],
  );

  const value = useMemo(() => {
    if (!reading.root) return undefined;
    // Outer parts first, so a part opened inside another lands in it.
    const parts = [...reading.parts].sort((a, b) => a.path.length - b.path.length);
    return parts.reduce((tree, part) => graftValue(tree, part.path, part.value), reading.root.value);
  }, [reading]);

  return { root: reading.root, value, error, load };
}
