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

import { presentPanelError, type PanelErrorPresentation } from './panel-error';

export type BoardErrorPresentation = PanelErrorPresentation;

/**
 * Map a raw `get_company_board` rejection (any shape — Tauri rejections are
 * stringified) to its calm presentation. Thin delegation to the shared
 * `presentPanelError` (panel-error.ts) with the board's established fallback
 * line. Unknown errors fall back to that generic retry message with the raw
 * text preserved in `detail`.
 */
export function presentBoardError(raw: unknown): BoardErrorPresentation {
  return presentPanelError(raw, {
    surface: 'the board',
    fallback: 'The board could not refresh — try again after a sync',
  });
}
