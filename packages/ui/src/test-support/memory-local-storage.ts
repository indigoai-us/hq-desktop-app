/**
 * Test-only in-memory `window.localStorage`.
 *
 * happy-dom (the version pinned here) does not implement `window.localStorage`,
 * and Node 26's built-in `globalThis.localStorage` is undefined unless the
 * runtime was started with `--localstorage-file` — while still shadowing the
 * DOM global. Suites that exercise stored preferences therefore have no store
 * to read or write, which surfaces as `Cannot read properties of undefined
 * (reading 'clear' / 'setItem')` rather than a real product failure.
 *
 * Install this once per suite to give those tests a real Storage.
 */
export function installMemoryLocalStorage(): Storage {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, String(value)),
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: storage,
    });
  }
  return storage;
}
