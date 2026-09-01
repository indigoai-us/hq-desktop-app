/**
 * Display names — turn package ids (`hq-pack-impeccable`) into friendly titles
 * ("Impeccable Design") without losing the real slug.
 *
 * Pure + DOM-free so it's unit-testable. Shared by the Core popover PACKS list
 * and the marketplace listing cards (re-exported from apps/sync marketplace).
 */

/**
 * Curated, brand-respecting display names keyed by pack slug. A pack not listed
 * here falls back to the generic `prettifyPackName` of its package name, so new
 * packs still read cleanly without a code change.
 */
export const PACK_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  engineering: "Engineering",
  gstack: "gStack",
  "pocock-skills": "Matt Pocock Skills",
  impeccable: "Impeccable Design",
  "magicpath-agent-skills": "MagicPath",
  // Acronym — the generic prettifier would title-case this to "Crm".
  crm: "CRM",
};

/** Words we keep lowercased when title-casing a derived name (unless leading). */
const NAME_MINOR_WORDS = new Set(["and", "for", "the", "of", "to", "a", "an"]);

/** Strip a leading `hq-pack-` (or `hq-`) prefix from a package id / slug. */
function stripPackPrefix(name: string): string {
  return (name ?? "")
    .trim()
    .replace(/^hq-pack[-_]/i, "")
    .replace(/^hq[-_]/i, "");
}

/**
 * Generic prettifier: strip a leading `hq-pack-` (or `hq-`) prefix, split on
 * `-`/`_`/space, and Title-Case the words (minor words stay lowercase unless
 * leading). Pure + DOM-free so it's unit-testable. Returns '' for empty input.
 */
export function prettifyPackName(name: string): string {
  const words = stripPackPrefix(name)
    .split(/[-_\s]+/)
    .filter(Boolean);
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && NAME_MINOR_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

/**
 * Friendly name for an installed pack row. Precedence: a (future) server-
 * provided `displayName` → the curated `PACK_DISPLAY_NAMES` map keyed by the
 * slug with the leading `hq-pack-`/`hq-` prefix stripped → a generic prettify
 * of the package name → the raw package name as a last resort.
 *
 * Never returns '' for a non-empty `name`.
 */
export function packDisplayName(pack: {
  name: string;
  displayName?: string | null;
}): string {
  const hosted = pack.displayName?.trim();
  if (hosted) return hosted;
  const slug = stripPackPrefix(pack.name).toLowerCase();
  const curated = slug ? PACK_DISPLAY_NAMES[slug] : undefined;
  if (curated) return curated;
  return prettifyPackName(pack.name) || pack.name;
}
