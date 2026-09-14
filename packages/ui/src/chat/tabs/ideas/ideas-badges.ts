/**
 * Small presentational derivations for the Ideas board that are worth testing
 * without mounting: the "local only" posture badge and the citation label.
 */

import type { IdeaBoardSettings } from "@hq/platform";

export interface LocalOnlyBadge {
  label: string;
  title: string;
}

/**
 * Board-header badge descriptor for the "sync off" posture (US-012 AC3).
 *
 * FAILS CLOSED. The gate is `syncEnabled === false`, not `!syncEnabled`: a
 * truthy-but-malformed payload (an error envelope, an older host that never
 * sent the field) leaves `syncEnabled` undefined, and `!undefined` would claim
 * "not synced to your team" over captures that are, in fact, in the vault.
 * Showing no badge when the posture is unknown understates, never overstates.
 *
 * The wording only claims what the code delivers: the capture write path
 * resolves its root from this preference, so NEW captures are unsynced.
 * Captures taken while sync was on are still in the vault, and the title says so.
 */
export function localOnlyBadge(
  state: IdeaBoardSettings | null | undefined,
): LocalOnlyBadge | null {
  if (!state || typeof state !== "object") return null;
  if (state.syncEnabled !== false) return null;
  const where = state.capturesRoot
    ? ` ${state.capturesRoot}`
    : " a folder on this machine";
  return {
    label: "local only",
    title:
      `New captures are saved to${where}, outside the company vault, and are not synced to your team.` +
      " Captures taken before you turned sync off are still in the vault and still sync.",
  };
}

/**
 * Label for a capture's citation count (US-011).
 *
 * Returns `null` — not an empty string — when there is nothing to show, so the
 * board can branch on presence rather than rendering a blank chip. A count of
 * 0 is "no label": the badge exists to mark captures agents actually reached
 * for. `×` is U+00D7, matching the sidecar's own line.
 */
export function citedLabel(count: number): string | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.trunc(count);
  if (n <= 0) return null;
  return `Cited ${n}× by agents`;
}

/**
 * Open a capture's source URL in the user's browser.
 *
 * Provenance URLs are captured from whatever window was on screen, so they are
 * untrusted input: anything that is not a credential-free http(s) URL is
 * ignored rather than handed to the host as a launcher.
 */
export function safeSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return parsed.toString();
}
