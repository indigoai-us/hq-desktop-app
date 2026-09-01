import { describe, expect, it } from 'vitest';
import { EMOJI_CATEGORIES, EMOJI_DATA } from './emoji-data';
import {
  buildSections,
  FREQUENT_LIMIT,
  FREQUENT_SECTION_TITLE,
  FREQUENT_STORAGE_KEY,
  frequentEmoji,
  type KeyValueStorage,
  readFrequentCounts,
  recordEmojiUse,
  searchEmoji,
} from './emojiSearch';
import { CURATED_EMOJI } from './reactions';

function fakeStorage(initial: Record<string, string> = {}): KeyValueStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe('EMOJI_DATA', () => {
  it('is a reasonably full set with unique emoji and valid categories', () => {
    expect(EMOJI_DATA.length).toBeGreaterThanOrEqual(500);
    expect(new Set(EMOJI_DATA.map((e) => e.emoji)).size).toBe(EMOJI_DATA.length);
    const categories = new Set<string>(EMOJI_CATEGORIES);
    for (const e of EMOJI_DATA) {
      expect(categories.has(e.category)).toBe(true);
      expect(e.name.length).toBeGreaterThan(0);
    }
  });

  it('contains the common reaction staples', () => {
    const emoji = new Set(EMOJI_DATA.map((e) => e.emoji));
    for (const staple of ['👍', '❤️', '😂', '🎉', '🔥', '🚀', '✅', '👀']) {
      expect(emoji.has(staple)).toBe(true);
    }
  });
});

describe('searchEmoji', () => {
  it('matches by name', () => {
    const results = searchEmoji('rocket');
    expect(results.map((e) => e.emoji)).toContain('🚀');
  });

  it('matches by keyword', () => {
    // "tada" is only a keyword of 🎉, not its name.
    const results = searchEmoji('tada');
    expect(results.map((e) => e.emoji)).toContain('🎉');
  });

  it('is case-insensitive and ignores surrounding whitespace', () => {
    const lower = searchEmoji('fire');
    const shouty = searchEmoji('  FIRE ');
    expect(shouty).toEqual(lower);
    expect(shouty.map((e) => e.emoji)).toContain('🔥');
  });

  it('returns empty for a query with no matches', () => {
    expect(searchEmoji('zzzznotanemoji')).toEqual([]);
  });

  it('returns the whole dataset for an empty query', () => {
    expect(searchEmoji('')).toHaveLength(EMOJI_DATA.length);
  });
});

describe('frequent usage', () => {
  it('reads empty from missing or corrupt storage', () => {
    expect(readFrequentCounts(null)).toEqual({});
    expect(readFrequentCounts(fakeStorage())).toEqual({});
    expect(readFrequentCounts(fakeStorage({ [FREQUENT_STORAGE_KEY]: 'not json' }))).toEqual({});
    expect(readFrequentCounts(fakeStorage({ [FREQUENT_STORAGE_KEY]: '[1,2]' }))).toEqual({});
  });

  it('records picks and orders frequents by count', () => {
    const storage = fakeStorage();
    recordEmojiUse(storage, '🚀');
    recordEmojiUse(storage, '🚀');
    recordEmojiUse(storage, '🎉');
    const counts = readFrequentCounts(storage);
    expect(counts).toEqual({ '🚀': 2, '🎉': 1 });
    const frequent = frequentEmoji(counts);
    expect(frequent[0]).toBe('🚀');
    expect(frequent[1]).toBe('🎉');
    expect(frequent).toHaveLength(FREQUENT_LIMIT);
  });

  it('falls back to the curated set when nothing was used, without duplicates', () => {
    const frequent = frequentEmoji({});
    expect(frequent).toEqual([...CURATED_EMOJI].slice(0, FREQUENT_LIMIT));
    expect(new Set(frequent).size).toBe(frequent.length);
  });
});

describe('buildSections', () => {
  it('puts Frequently used first for an empty query, then categories in order', () => {
    const sections = buildSections('', { '🚀': 3 });
    expect(sections[0].title).toBe(FREQUENT_SECTION_TITLE);
    expect(sections[0].entries[0].emoji).toBe('🚀');
    expect(sections.slice(1).map((s) => s.title)).toEqual([...EMOJI_CATEGORIES]);
  });

  it('returns one flat result section for a query', () => {
    const sections = buildSections('heart', {});
    expect(sections).toHaveLength(1);
    expect(sections[0].entries.map((e) => e.emoji)).toContain('❤️');
  });

  it('returns no sections when nothing matches', () => {
    expect(buildSections('zzzznotanemoji', {})).toEqual([]);
  });
});
