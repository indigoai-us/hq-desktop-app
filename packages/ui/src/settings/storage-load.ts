/**
 * Settings › Storage loading: one status read at a time per host, and the
 * age line for last-known figures.
 *
 * `hq storage status` takes minutes on a cold cache (it runs
 * `hq-storage.sh report` and `large`). Re-opening the screen or a re-render
 * must join the read already running instead of asking the host for another;
 * the desktop host also runs only one scan at a time, so this is the first of
 * two guards.
 */
import type { AdapterResult, StorageApi, StorageStatus } from "@hq/platform";

const inFlight = new WeakMap<StorageApi, Promise<AdapterResult<StorageStatus>>>();

/**
 * `api.status()`, joined with a read already running for the same host.
 * `afterWrite` (after a delete or move): a running read started before the
 * change, so wait for it and then read again, still one at a time.
 */
export function joinStatus(
  api: StorageApi,
  opts: { afterWrite?: boolean } = {},
): Promise<AdapterResult<StorageStatus>> {
  const running = inFlight.get(api);
  if (running && !opts.afterWrite) return running;
  const next = (running ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => api.status())
    .catch((err: unknown) => ({
      ok: false as const,
      reason: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      if (inFlight.get(api) === next) inFlight.delete(api);
    }) as Promise<AdapterResult<StorageStatus>>;
  inFlight.set(api, next);
  return next;
}

/** True while a status read is running for this host. */
export function statusInFlight(api: StorageApi): boolean {
  return inFlight.has(api);
}

/** "Figures from 20 min ago." for a cached status; null when unknown. */
export function cachedAgeCopy(fetchedAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!fetchedAt) return null;
  const at = Date.parse(fetchedAt);
  if (Number.isNaN(at)) return null;
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return "Figures from just now.";
  if (mins < 60) return `Figures from ${mins} min ago.`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Figures from ${hours} h ago.`;
  const days = Math.floor(hours / 24);
  return `Figures from ${days} day${days === 1 ? "" : "s"} ago.`;
}
