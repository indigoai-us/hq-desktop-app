/**
 * Settings › Storage loading: one status read and one big-file read at a time
 * per host, and the age line for last-known figures.
 *
 * The full `hq storage status` takes minutes on a cold cache (it runs
 * `hq-storage.sh report` and `large`). The pane reads the summary
 * (`status --no-large`) and the big-file list (`storage large`) separately,
 * so the summary shows as soon as `report` returns. Re-opening the screen or a
 * re-render must join the read already running instead of asking the host for
 * another; the desktop host also runs only one scan of each at a time, so this
 * is the first of two guards.
 */
import type { AdapterResult, StorageApi, StorageLarge, StorageStatus } from "@hq/platform";

const statusInFlightMap = new WeakMap<StorageApi, Promise<AdapterResult<StorageStatus>>>();
const largeInFlightMap = new WeakMap<StorageApi, Promise<AdapterResult<StorageLarge>>>();

/** Error message a host without the big-file read answers with. */
const UPDATE_HQ = "update-hq";

/**
 * `api.status()`, joined with a read already running for the same host.
 * `afterWrite` (after a delete or move): a running read started before the
 * change, so wait for it and then read again, still one at a time.
 */
export function joinStatus(
  api: StorageApi,
  opts: { afterWrite?: boolean } = {},
): Promise<AdapterResult<StorageStatus>> {
  return join(statusInFlightMap, api, () => api.status(), opts);
}

/**
 * `api.large()`: the big-file scan the summary skips, joined the same way.
 * A host without it answers `update-hq`.
 */
export function joinLarge(
  api: StorageApi,
  opts: { afterWrite?: boolean } = {},
): Promise<AdapterResult<StorageLarge>> {
  const large = api.large;
  if (!large) return Promise.resolve({ ok: false, reason: "error", message: UPDATE_HQ });
  return join(largeInFlightMap, api, () => large.call(api), opts);
}

function join<T>(
  inFlight: WeakMap<StorageApi, Promise<AdapterResult<T>>>,
  api: StorageApi,
  read: () => Promise<AdapterResult<T>>,
  opts: { afterWrite?: boolean },
): Promise<AdapterResult<T>> {
  const running = inFlight.get(api);
  if (running && !opts.afterWrite) return running;
  const next = (running ?? Promise.resolve())
    .catch(() => undefined)
    .then(read)
    .catch((err: unknown) => ({
      ok: false as const,
      reason: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }))
    .finally(() => {
      if (inFlight.get(api) === next) inFlight.delete(api);
    }) as Promise<AdapterResult<T>>;
  inFlight.set(api, next);
  return next;
}

/** True while a status read is running for this host. */
export function statusInFlight(api: StorageApi): boolean {
  return statusInFlightMap.has(api);
}

/** True while a big-file read is running for this host. */
export function largeInFlight(api: StorageApi): boolean {
  return largeInFlightMap.has(api);
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
