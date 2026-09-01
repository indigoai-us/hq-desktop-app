// Pure search + frequently-used logic for the searchable emoji picker
// (EmojiPicker.svelte). No DOM: unit-tested in emojiSearch.test.ts, mirroring
// the lib/reactions.ts split. The dataset lives in lib/emoji-data.ts; the
// compact CURATED_EMOJI quick set (lib/reactions.ts) seeds "Frequently used"
// until the user has picked enough emoji of their own.

import { EMOJI_CATEGORIES, EMOJI_DATA, type EmojiEntry } from './emoji-data';
import { CURATED_EMOJI } from './reactions';

/** One rendered section of the picker: a header + its emoji entries. */
export interface EmojiSection {
  title: string;
  entries: EmojiEntry[];
}

export const FREQUENT_SECTION_TITLE = 'Frequently used';

/** localStorage key for the picker's per-user usage counts. */
export const FREQUENT_STORAGE_KEY = 'hq-sync.frequent-emoji';

/** How many emoji the "Frequently used" section shows. */
export const FREQUENT_LIMIT = 18;

/** Minimal storage surface so tests can inject a plain-object fake and the
 * picker can pass window.localStorage. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const byEmoji = new Map<string, EmojiEntry>(EMOJI_DATA.map((e) => [e.emoji, e]));

function entryFor(emoji: string): EmojiEntry | null {
  return (
    byEmoji.get(emoji) ??
    // Curated entries not present in the dataset still render (name-less).
    (emoji ? { emoji, name: '', keywords: [], category: '' } : null)
  );
}

/** Case-insensitive substring match against an entry's name + keywords. */
export function matchesQuery(entry: EmojiEntry, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true;
  if (entry.name.toLowerCase().includes(normalizedQuery)) return true;
  return entry.keywords.some((k) => k.toLowerCase().includes(normalizedQuery));
}

/** Flat filtered list for a non-empty query, dataset order preserved. */
export function searchEmoji(query: string, data: readonly EmojiEntry[] = EMOJI_DATA): EmojiEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) return [...data];
  return data.filter((e) => matchesQuery(e, normalized));
}

/** Read the usage-count map ({emoji: count}) from storage. Corrupt or missing
 * payloads read as empty — the picker must never throw at open. */
export function readFrequentCounts(storage: KeyValueStorage | null | undefined): Record<string, number> {
  try {
    const raw = storage?.getItem(FREQUENT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [emoji, count] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count) && count > 0) {
        out[emoji] = count;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Bump one emoji's usage count (best-effort persist). */
export function recordEmojiUse(storage: KeyValueStorage | null | undefined, emoji: string): void {
  if (!storage) return;
  const counts = readFrequentCounts(storage);
  counts[emoji] = (counts[emoji] ?? 0) + 1;
  try {
    storage.setItem(FREQUENT_STORAGE_KEY, JSON.stringify(counts));
  } catch {
    // Quota/private-mode failures are non-fatal — frequency just won't persist.
  }
}

/** The "Frequently used" emoji list: user picks ordered by count (ties broken
 * by curated order, then stable), padded with CURATED_EMOJI up to the limit so
 * a fresh install still opens on a useful quick set. */
export function frequentEmoji(
  counts: Record<string, number>,
  limit: number = FREQUENT_LIMIT,
): string[] {
  const curatedRank = new Map(CURATED_EMOJI.map((e, i) => [e, i]));
  const used = Object.entries(counts)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      const ra = curatedRank.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const rb = curatedRank.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb;
    })
    .map(([emoji]) => emoji);
  const out: string[] = [];
  for (const e of [...used, ...CURATED_EMOJI]) {
    if (out.length >= limit) break;
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

/** Build the picker's sections. Empty query → Frequently used first, then every
 * dataset category in display order. Non-empty query → a single flat result
 * section (Slack-style), empty array when nothing matches. */
export function buildSections(
  query: string,
  counts: Record<string, number>,
  data: readonly EmojiEntry[] = EMOJI_DATA,
): EmojiSection[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length > 0) {
    const entries = data.filter((e) => matchesQuery(e, normalized));
    return entries.length > 0 ? [{ title: 'Search results', entries }] : [];
  }

  const sections: EmojiSection[] = [];
  const frequent = frequentEmoji(counts)
    .map(entryFor)
    .filter((e): e is EmojiEntry => e !== null);
  if (frequent.length > 0) {
    sections.push({ title: FREQUENT_SECTION_TITLE, entries: frequent });
  }
  for (const category of EMOJI_CATEGORIES) {
    const entries = data.filter((e) => e.category === category);
    if (entries.length > 0) sections.push({ title: category, entries });
  }
  return sections;
}
