/**
 * Label for an Idea Board capture's citation count (US-011).
 *
 * Returns `null` — not an empty string — when there is nothing to show, so the
 * board can branch on presence rather than rendering a blank chip. A count of
 * 0 is "no label", not "Cited 0× by agents": the badge exists to mark captures
 * agents actually reached for.
 *
 * `×` is U+00D7 (multiplication sign), matching the sidecar's own line.
 */
export function citedLabel(count: number): string | null {
  if (!Number.isFinite(count)) return null;
  const n = Math.trunc(count);
  if (n <= 0) return null;
  return `Cited ${n}× by agents`;
}
