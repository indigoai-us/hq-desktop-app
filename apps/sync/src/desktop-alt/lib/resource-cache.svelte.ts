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
      for (const [key, value] of entries) {
        if (predicate(key)) value.updatedAt = null;
      }
    },
    clear(): void {
      entries.clear();
    },
  };
}
