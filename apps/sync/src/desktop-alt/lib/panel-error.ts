/**
 * panel-error — calm presentation for desktop-alt surface load failures.
 *
 * Every desktop-alt company command can reject before its endpoint is even
 * reached: company-UID resolution errors ("company 'x' is not synced: manifest
 * cloud_uid … not found in your cloud memberships") are prefixed by the backend
 * with a machine-readable code (`COMPANY_NOT_FOUND` / `COMPANY_NOT_SYNCED` /
 * `COMPANY_NOT_CONNECTED` — see `prefix_company_resolution_error` in
 * hq-desktop-core, applied to every `resolve_company_uid` caller), and auth
 * failures arrive as `AUTH_REQUIRED: …`. This module maps any rejection to a
 * calm, user-facing message; the raw diagnostic stays available in `detail`
 * for console logging only — it must never be the primary error line.
 *
 * The Board panel's `presentBoardError` (board-error.ts) delegates here with
 * its board-specific fallback line.
 */

export interface PanelErrorPresentation {
  /** Calm, user-facing message for the primary error line. */
  message: string;
  /** Raw diagnostic for console logging / a details affordance — never the primary line. */
  detail: string;
  /** True when the failure is an expired/invalid session (route to sign-in). */
  authRequired: boolean;
}

export interface PresentPanelErrorOptions {
  /**
   * Surface noun for the generic fallback line, phrased to follow "Couldn’t
   * load …" (e.g. `'activity'`, `'deployments'`, `'secrets'`, `'settings'`).
   */
  surface: string;
  /**
   * Override the generic fallback line entirely (used when a surface already
   * has established copy, or for non-load actions where "load" is wrong).
   */
  fallback?: string;
}

const CODE_MESSAGES: ReadonlyArray<[prefix: string, message: string]> = [
  ['AUTH_REQUIRED:', 'Session expired — sign in again'],
  ['COMPANY_NOT_CONNECTED:', "This company isn't connected to cloud yet"],
  [
    'COMPANY_NOT_SYNCED:',
    'This company needs to be reconnected — open the menubar and sync',
  ],
  [
    'COMPANY_NOT_FOUND:',
    "This company isn't available on this device yet — run a sync to pull it",
  ],
];

/**
 * Map a raw command rejection (any shape — Tauri rejections are stringified)
 * to its calm presentation. Unknown errors fall back to a generic retry
 * message with the raw text preserved in `detail`.
 */
export function presentPanelError(
  raw: unknown,
  options: PresentPanelErrorOptions,
): PanelErrorPresentation {
  const detail = String(raw ?? '').trim();
  for (const [prefix, message] of CODE_MESSAGES) {
    if (detail.startsWith(prefix)) {
      return { message, detail, authRequired: prefix === 'AUTH_REQUIRED:' };
    }
  }
  const message =
    options.fallback ??
    `Couldn’t load ${options.surface} — try again after a sync`;
  return { message, detail, authRequired: false };
}
