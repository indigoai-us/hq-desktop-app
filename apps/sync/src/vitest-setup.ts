import { vi } from 'vitest';

// Node 22+ can expose a stub `localStorage` without Storage methods
// (`--localstorage-file` unset). Happy-dom tests then fail in afterEach
// (`clear is not a function`) and remember() silently no-ops.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => store.clear(),
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

// Tests must never POST into the live hq-install-events table.
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
    text: async () => '',
  })),
}));
