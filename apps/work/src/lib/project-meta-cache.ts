import type { ChatWakeBus, ConversationRow } from "@hq/ui";
import type { LiveProjectMeta, LiveProjectMetaLoad } from "./live-project.js";

/**
 * Mesh wakes normally keep project metadata current. One minute bounds stale
 * Board, Files, membership, and work-session data when a wake is missed,
 * without introducing a background polling loop.
 */
export const PROJECT_META_FRESHNESS_MS = 60_000;

interface ProjectMetaEntry {
  meta: LiveProjectMeta;
  loadedAt: number;
}

interface ProjectMetaMiss {
  loadedAt: number;
}

export interface ProjectMetaCache {
  read(row: ConversationRow): LiveProjectMeta | null;
  invalidateChannel(channelId: string | null | undefined): void;
  invalidateAll(): void;
}

export interface CreateProjectMetaCacheOptions {
  load(row: ConversationRow): Promise<LiveProjectMetaLoad>;
  canLoad?(row: ConversationRow): boolean;
  now?(): number;
  onChanged?(): void;
}

/** Use the same cache key everywhere the Work shell does. */
export function projectMetaKey(row: ConversationRow): string | null {
  const key = row.channelId || row.projectId || row.id;
  return key.trim() || null;
}

class ProjectMetaCacheImpl implements ProjectMetaCache {
  private readonly entries = new Map<string, ProjectMetaEntry>();
  private readonly misses = new Map<string, ProjectMetaMiss>();
  /** Current load generation per key. Invalidations advance this token. */
  private readonly generations = new Map<string, number>();
  /** A key can have a stale and fresh request in flight after invalidation. */
  private readonly pending = new Map<string, number>();

  constructor(private readonly options: CreateProjectMetaCacheOptions) {}

  read(row: ConversationRow): LiveProjectMeta | null {
    const key = projectMetaKey(row);
    if (!key) return null;

    const now = (this.options.now ?? Date.now)();
    const entry = this.entries.get(key);
    if (entry && this.isFresh(entry.loadedAt, now)) return entry.meta;
    if (entry) this.invalidateKey(key, false);

    const miss = this.misses.get(key);
    if (miss && this.isFresh(miss.loadedAt, now)) return null;
    if (miss) this.invalidateKey(key, false);

    if (this.options.canLoad && !this.options.canLoad(row)) {
      this.misses.set(key, { loadedAt: now });
      return null;
    }

    if (this.pending.has(key)) return null;
    const generation = this.generations.get(key) ?? 0;
    this.pending.set(key, generation);
    void Promise.resolve(this.options.load(row)).then(
      (result) => this.finishLoad(key, generation, result),
      () => this.finishLoad(key, generation, null),
    );
    return null;
  }

  invalidateChannel(channelId: string | null | undefined): void {
    const key = channelId?.trim();
    if (!key) {
      this.invalidateAll();
      return;
    }
    this.invalidateKey(key, true);
  }

  invalidateAll(): void {
    const keys = new Set([
      ...this.entries.keys(),
      ...this.misses.keys(),
      ...this.pending.keys(),
    ]);
    if (keys.size === 0) return;
    for (const key of keys) this.invalidateKey(key, false);
    this.options.onChanged?.();
  }

  private isFresh(loadedAt: number, now: number): boolean {
    return now - loadedAt <= PROJECT_META_FRESHNESS_MS;
  }

  private invalidateKey(key: string, notify: boolean): void {
    this.entries.delete(key);
    this.misses.delete(key);
    this.pending.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    if (notify) this.options.onChanged?.();
  }

  private finishLoad(
    key: string,
    generation: number,
    result: LiveProjectMetaLoad | null,
  ): void {
    if (this.pending.get(key) === generation) this.pending.delete(key);
    if ((this.generations.get(key) ?? 0) !== generation) {
      // A wake started a newer generation. Its result, not this one, owns the
      // cache; still notify so a consumer waiting on the newer request reruns.
      this.options.onChanged?.();
      return;
    }
    const now = (this.options.now ?? Date.now)();
    if (result?.meta) this.entries.set(key, { meta: result.meta, loadedAt: now });
    // A fulfilled loader result is authoritative, including an inconclusive
    // no-metadata response. Rejections stay retryable for transient failures.
    else if (result && !result.retryable) {
      this.misses.set(key, { loadedAt: now });
    }
    this.options.onChanged?.();
  }
}

export function createProjectMetaCache(
  options: CreateProjectMetaCacheOptions,
): ProjectMetaCache {
  return new ProjectMetaCacheImpl(options);
}

/**
 * Project metadata changes with a channel's shape, roster, or project binding.
 * `mesh:catchup` has no affected channel id and may reconcile any directory
 * row, so it must invalidate broadly. Message and unread wakes are excluded:
 * neither changes Board, Files, membership, or work-session metadata.
 */
export function subscribeProjectMetaInvalidations(
  wakes: ChatWakeBus,
  cache: ProjectMetaCache,
): () => void {
  const unsubs = [
    wakes.on("channel:updated", (channel) => {
      cache.invalidateChannel(channel.channelId);
    }),
    wakes.on("mesh:catchup", () => {
      cache.invalidateAll();
    }),
  ];
  return () => {
    for (const unsubscribe of unsubs) unsubscribe();
  };
}
