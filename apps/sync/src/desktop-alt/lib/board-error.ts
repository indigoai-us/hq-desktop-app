/**
 * board-error — calm presentation for company Board load failures.
 *
 * `get_company_board` can reject before the vault is even reached: company-UID
 * resolution errors ("company 'x' is not synced: manifest cloud_uid … not
 * found in your cloud memberships") used to leak verbatim into the Needs-you
 * card. The backend now prefixes those rejections with a machine-readable code
 * (`COMPANY_NOT_FOUND` / `COMPANY_NOT_SYNCED` / `COMPANY_NOT_CONNECTED` — see
 * `prefix_company_resolution_error` in hq-desktop-core), and auth failures
 * arrive as `AUTH_REQUIRED: …`. This module maps every rejection to a calm,
 * user-facing message; the raw diagnostic stays available in `detail` for
 * console logging only — it must never be the primary card line.
 */

export interface BoardErrorPresentation {
  /** Calm, user-facing message for the primary card line. */
  message: string;
  /** Raw diagnostic for console logging / a details affordance — never the card line. */
  detail: string;
  /** True when the failure is an expired/invalid session (route to sign-in). */
  authRequired: boolean;
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

const FALLBACK_MESSAGE = 'The board could not refresh — try again after a sync';

/**
 * Map a raw `get_company_board` rejection (any shape — Tauri rejections are
 * stringified) to its calm presentation. Unknown errors fall back to a generic
 * retry message with the raw text preserved in `detail`.
 */
export function presentBoardError(raw: unknown): BoardErrorPresentation {
  const detail = String(raw ?? '').trim();
  for (const [prefix, message] of CODE_MESSAGES) {
    if (detail.startsWith(prefix)) {
      return { message, detail, authRequired: prefix === 'AUTH_REQUIRED:' };
    }
  }
  return { message: FALLBACK_MESSAGE, detail, authRequired: false };
}
