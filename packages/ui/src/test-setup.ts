/**
 * Node 22+ exposes a global `localStorage` getter that returns undefined
 * unless `--localstorage-file` is set. That shadows happy-dom's Storage and
 * breaks tenant-scoped pin/draft/cache tests. Install a memory Storage that
 * also enumerates keys so `Object.keys(localStorage)` works.
 */
function installMemoryLocalStorage(): void {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      for (const key of [...data.keys()]) {
        data.delete(key);
        delete (storage as unknown as Record<string, unknown>)[key];
      }
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return [...data.keys()][index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
      delete (storage as unknown as Record<string, unknown>)[key];
    },
    setItem(key: string, value: string) {
      const text = String(value);
      data.set(key, text);
      (storage as unknown as Record<string, unknown>)[key] = text;
    },
  };
  const define = (target: object) => {
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      enumerable: true,
      value: storage,
    });
  };
  define(globalThis);
  if (typeof window !== "undefined") define(window);
}

installMemoryLocalStorage();
