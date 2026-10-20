// What the UI remembers in this browser. Blocked site data makes reading and writing throw; the UI then forgets.

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` forgets it. */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

/** The saved JSON value, or undefined when there is none or it is not JSON. */
export function readJsonPref(key: string): unknown {
  const text = readPref(key);
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A saved list of strings, empty when there is none. */
export function readStringsPref(key: string): string[] {
  const saved = readJsonPref(key);
  return Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : [];
}
