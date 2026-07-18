/**
 * Human-facing titles for shared paths in the "Shared with Me" notification.
 *
 * When a teammate shares a whole directory, the path arrives as a wildcard like
 * `projects/client-stats-redesign/*` (or `/**` for a recursive share). Naively
 * taking the last path segment (`split('/').pop()`) surfaces the literal `*` as
 * the card title — meaningless to the recipient. `shareTitle` strips the
 * wildcard suffix and shows the directory name with a trailing slash
 * (`client-stats-redesign/`) so a folder share reads as a folder, while plain
 * file shares keep their filename unchanged.
 */

/** Matches a trailing `/*`, `/**`, or a bare `*`/`**` (optionally slash-led). */
const WILDCARD_SUFFIX = /\/?\*\*?$/;

/**
 * Title to show for a single shared path.
 *
 * - `projects/foo/*`  → `foo/`   (directory share — trailing slash signals folder)
 * - `projects/foo/**` → `foo/`   (recursive directory share)
 * - `docs/a.md`       → `a.md`   (file share — unchanged)
 * - `*` / `**`        → `All files` (whole-vault share — no segment to name)
 */
export function shareTitle(path: string): string {
  const isWildcardDir = WILDCARD_SUFFIX.test(path);
  const cleaned = path.replace(WILDCARD_SUFFIX, '');
  const last = cleaned.split('/').filter(Boolean).pop();
  if (!last) return 'All files';
  return isWildcardDir ? `${last}/` : last;
}

/**
 * Tenant-scoped path/prefix shown under the basename — the full share path as
 * received (including company/prefix segments). Empty paths fall back to a
 * quiet whole-vault label so the payload UI never shows a blank row.
 */
export function sharePathPrefix(path: string): string {
  const cleaned = path.replace(WILDCARD_SUFFIX, '').trim();
  if (!cleaned || cleaned === '*' || cleaned === '**') return 'All files (vault root)';
  return path;
}

/**
 * ACL truth line for a share payload. Surfaces the server permission string
 * verbatim when present (e.g. "read", "write") so the UI never invents access
 * the backend did not grant. Empty → null so callers can omit the slot.
 */
export function shareAclLabel(permission: string | null | undefined): string | null {
  const value = permission?.trim();
  if (!value) return null;
  // Keep raw permission tokens as the source of truth; only normalize casing
  // for display so "read" / "Read" / "READ" collapse to one human line.
  const lower = value.toLowerCase();
  if (lower === 'read' || lower === 'view') return 'ACL: read';
  if (lower === 'write' || lower === 'edit') return 'ACL: write';
  if (lower === 'admin' || lower === 'owner') return `ACL: ${lower}`;
  return `ACL: ${value}`;
}
