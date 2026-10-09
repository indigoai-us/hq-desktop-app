export interface ResourceCacheEntry<T> {
  data: T | null;
  error: unknown | null;
  updatedAt: number | null;
  inFlight: Promise<T> | null;
}

export interface ResourceCacheOptions {
  ttlMs?: number;
  now?: () => number;
  /**
   * Most keys kept. The least recently used entry is evicted past this, so a
   * long session that visits many companies does not grow without bound.
   */
  maxEntries?: number;
  /**
   * When a stale entry exists, `load` resolves with it at once and refreshes
   * in the background, so a screen paints cached data instead of a loader.
   */
  staleWhileRevalidate?: boolean;
}

/** Default bound on keys per cache. */
export const RESOURCE_CACHE_MAX_ENTRIES = 64;

export function createResourceCache(options: ResourceCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, options.maxEntries ?? RESOURCE_CACHE_MAX_ENTRIES);
  const swr = options.staleWhileRevalidate ?? false;
  // Map iteration order is insertion order: re-inserting on use keeps the
  // least recently used key first.
  const entries = new Map<string, ResourceCacheEntry<unknown>>();
  // Svelte rune so mounted consumers can `$effect` on cache writes/invalidations
  // instead of only painting their own initial Promise result.
  let revision = $state(0);
  let clears = 0;

  function bump(): void {
    revision += 1;
  }

  function entry<T>(key: string): ResourceCacheEntry<T> {
    let value = entries.get(key);
    if (value) {
      entries.delete(key);
    } else {
      value = { data: null, error: null, updatedAt: null, inFlight: null };
    }
    entries.set(key, value);
    while (entries.size > maxEntries) {
      const [oldest, evicted] = entries.entries().next().value as [string, ResourceCacheEntry<unknown>];
      // Never drop a request that is still running; it is about to be read.
      if (evicted.inFlight) break;
      entries.delete(oldest);
    }
    return value as ResourceCacheEntry<T>;
  }

  function isFresh(value: ResourceCacheEntry<unknown>): boolean {
    return value.updatedAt !== null && now() - value.updatedAt < ttlMs;
  }

  return {
    get revision() {
      return revision;
    },
    read<T>(key: string): T | null {
      return entry<T>(key).data;
    },
    inspect<T>(key: string): Readonly<ResourceCacheEntry<T>> {
      return entry<T>(key);
    },
    load<T>(key: string, loader: () => Promise<T>, force = false): Promise<T> {
      const value = entry<T>(key);
      if (value.inFlight) {
        if (swr && !force && value.data !== null) return Promise.resolve(value.data);
        return value.inFlight;
      }
      if (!force && value.data !== null && isFresh(value))
        return Promise.resolve(value.data);

      // A cleared cache must not be refilled by a request started before it.
      const generation = clears;
      const request = loader()
        .then((data) => {
          if (generation !== clears) return data;
          value.data = data;
          value.error = null;
          value.updatedAt = now();
          bump();
          return data;
        })
        .catch((error) => {
          value.error = error;
          throw error;
        })
        .finally(() => {
          value.inFlight = null;
        });
      value.inFlight = request;
      if (swr && !force && value.data !== null) {
        // The caller paints the stale copy; a failed refresh stays on the entry.
        request.catch(() => {});
        return Promise.resolve(value.data);
      }
      return request;
    },
    invalidate(predicate: (key: string) => boolean): void {
      let changed = false;
      for (const [key, value] of entries) {
        if (predicate(key)) {
          value.updatedAt = null;
          changed = true;
        }
      }
      if (changed) bump();
    },
    get size(): number {
      return entries.size;
    },
    clear(): void {
      clears += 1;
      entries.clear();
      bump();
    },
  };
}
