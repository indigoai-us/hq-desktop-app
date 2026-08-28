/**
 * Legacy minimal adapter from the initial scaffold. Kept so existing
 * consumers of `createMemoryAdapter` continue to work; new code should use
 * the full `PlatformAdapter` from ./adapter.js.
 */
export interface LegacyPlatformAdapter {
  /** Which host this adapter targets. */
  readonly kind: "web" | "desktop";
  /** Open a URL in the host's default browser. */
  openExternal(url: string): Promise<void>;
  /** Persist a small key/value setting. */
  setSetting(key: string, value: string): Promise<void>;
  /** Read a previously persisted setting. */
  getSetting(key: string): Promise<string | null>;
}

/** In-memory adapter, useful for tests and SSR where no host APIs exist. */
export function createMemoryAdapter(
  kind: LegacyPlatformAdapter["kind"] = "web",
): LegacyPlatformAdapter {
  const store = new Map<string, string>();
  return {
    kind,
    async openExternal() {
      /* no-op in memory */
    },
    async setSetting(key, value) {
      store.set(key, value);
    },
    async getSetting(key) {
      return store.get(key) ?? null;
    },
  };
}
