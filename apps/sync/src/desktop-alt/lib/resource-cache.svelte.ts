export interface ResourceCacheEntry<T> {
  data: T | null;
  error: unknown | null;
  updatedAt: number | null;
  inFlight: Promise<T> | null;
}

export interface ResourceCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

export function createResourceCache(options: ResourceCacheOptions = {}) {
  const ttlMs = options.ttlMs ?? 30_000;
  const now = options.now ?? Date.now;
  const entries = new Map<string, ResourceCacheEntry<unknown>>();
  // Svelte rune so mounted consumers can `$effect` on cache writes/invalidations
  // instead of only painting their own initial Promise result.
  let revision = $state(0);

  function bump(): void {
    revision += 1;
  }

  function entry<T>(key: string): ResourceCacheEntry<T> {
    let value = entries.get(key);
    if (!value) {
      value = { data: null, error: null, updatedAt: null, inFlight: null };
      entries.set(key, value);
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
      if (value.inFlight) return value.inFlight;
      if (!force && value.data !== null && isFresh(value)) return Promise.resolve(value.data);

      const request = loader()
        .then((data) => {
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
    clear(): void {
      entries.clear();
      bump();
    },
  };
}
