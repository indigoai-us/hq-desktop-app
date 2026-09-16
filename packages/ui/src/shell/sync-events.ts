/**
 * The slice of an app-level event bus the desktop shell needs to observe sync
 * outcomes.
 *
 * `start_sync` returns as soon as the runner registers, and returns Ok even
 * when the session needs reauth (it emits `sync:auth-error` instead, so the
 * manual path matches the runner's exit-0 auth contract). A caller that reads
 * only the command result therefore cannot tell "pulled" from "did nothing".
 * Both real outcomes arrive as events, and this is the seam the host injects
 * so `packages/ui` stays platform-agnostic.
 *
 * Mirrors the `LibraryRefreshHost` convention in ../library/library-refresh.ts.
 */

/** An unlisten handle. */
export type SyncUnlistenFn = () => void;

export interface SyncEventHost {
  listen(
    event: string,
    handler: (event: { payload?: unknown }) => void,
  ): Promise<SyncUnlistenFn>;
}
