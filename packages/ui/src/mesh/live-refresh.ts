/**
 * Host-bound seam for requesting one coalesced GET /v1/work-mesh/live without
 * owning MeshClient. Mesh hosts call `bindLiveRefresh`.
 *
 * Moved out of the removed Atlas page: the live-refresh seam is mesh
 * plumbing, and mesh-runtime is its real consumer.
 */

type LiveRefreshFn = (companyUid: string) => void;

let refresher: LiveRefreshFn | null = null;

export function bindLiveRefresh(fn: LiveRefreshFn): () => void {
  refresher = fn;
  return () => {
    if (refresher === fn) refresher = null;
  };
}

/** Request a single coalesced live-read refresh (no-op when unbound). */
export function requestLiveRefresh(companyUid: string): void {
  const uid = companyUid.trim();
  if (!uid || !refresher) return;
  refresher(uid);
}
