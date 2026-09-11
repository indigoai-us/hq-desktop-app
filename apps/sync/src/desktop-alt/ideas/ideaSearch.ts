/**
 * Pure board logic for the Ideas board (US-009): search index, chip filtering,
 * and the small derivations every card layout needs.
 *
 * Everything here is framework-free so the 50ms/1,000-record search budget and
 * the card-shape rules can be tested without mounting a component.
 */

import type { IdeaCapture, IdeaKind } from '../../stores/ideaCaptures';

/** Chip ids of the board filter row. */
export type IdeaChip =
  | 'all'
  | 'posts'
  | 'articles'
  | 'images'
  | 'colors'
  | 'quotes'
  | 'products';

export const FILTER_CHIPS: ReadonlyArray<{ id: IdeaChip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'posts', label: 'Posts' },
  { id: 'articles', label: 'Articles' },
  { id: 'images', label: 'Images' },
  { id: 'colors', label: 'Colors' },
  { id: 'quotes', label: 'Quotes' },
  { id: 'products', label: 'Products' },
];

/** Words per minute used to derive an article read time. */
export const READ_WPM = 200;

/**
 * Which card layout a record gets.
 *
 * `unknown` has no layout of its own, and a record the user deliberately kept
 * as a plain image must render as one whatever the extractor guessed (AC2, AC3).
 */
export function cardKind(record: IdeaCapture): Exclude<IdeaKind, 'unknown'> {
  if (record.status === 'plain') return 'image';
  if (record.kind === 'unknown') return 'image';
  return record.kind;
}

/** Human label for a kind, used in the type chip and low-confidence copy. */
export function kindLabel(kind: IdeaKind): string {
  switch (kind) {
    case 'x_post':
      return 'X post';
    case 'article':
      return 'Article';
    case 'quote':
      return 'Quote';
    case 'color':
      return 'Color';
    case 'product':
      return 'Product';
    case 'image':
    case 'unknown':
    default:
      return 'Image';
  }
}

/** Minutes to read `text`, rounded up, never below 1. */
export function readTimeMinutes(text: string | null | undefined): number {
  const words = (text ?? '').trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 1;
  return Math.max(1, Math.ceil(words / READ_WPM));
}

function extractedString(record: IdeaCapture, key: string): string | null {
  const value = record.extracted?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Card headline: extracted identity, then window title, then app. */
export function cardTitle(record: IdeaCapture): string {
  return (
    extractedString(record, 'title') ??
    extractedString(record, 'name') ??
    extractedString(record, 'caption') ??
    extractedString(record, 'body') ??
    extractedString(record, 'text') ??
    nonEmpty(record.provenance?.window_title) ??
    nonEmpty(record.provenance?.app) ??
    'Capture'
  );
}

/** Host of a provenance URL, or null when there isn't a usable one. */
export function sourceHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.toLocaleString('en-US', { month: 'short' })} ${date.getDate()}`;
}

/** Meta line: source host (or app), then the short capture date. */
export function cardMeta(record: IdeaCapture): string {
  const left = sourceHost(record.provenance?.url) ?? record.provenance?.app ?? '';
  const right = shortDate(record.created_at);
  return [left, right].filter(Boolean).join(' · ');
}

/** One precomputed lowercase haystack per record. */
export interface IdeaSearchEntry {
  record: IdeaCapture;
  haystack: string;
}

export type IdeaSearchIndex = IdeaSearchEntry[];

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out, depth + 1);
    }
  }
}

/**
 * Precompute the search text for every record once.
 *
 * Search then becomes a linear `includes` scan over flat strings, which is what
 * keeps 1,000 records inside the 50ms budget on every keystroke (AC4).
 */
export function buildSearchIndex(records: readonly IdeaCapture[]): IdeaSearchIndex {
  return records.map((record) => {
    const parts: string[] = [cardTitle(record)];
    collectStrings(record.extracted, parts);
    if (record.ocr_text) parts.push(record.ocr_text);
    if (record.note) parts.push(record.note);
    for (const tag of record.tags ?? []) parts.push(tag);
    const provenance = record.provenance;
    if (provenance) {
      parts.push(provenance.app ?? '', provenance.window_title ?? '', provenance.url ?? '');
    }
    parts.push(kindLabel(record.kind));
    return { record, haystack: parts.join('  ').toLowerCase() };
  });
}

/** True when the record's card layout belongs to `chip`. */
export function chipMatches(chip: IdeaChip, record: IdeaCapture): boolean {
  if (chip === 'all') return true;
  const kind = cardKind(record);
  switch (chip) {
    case 'posts':
      return kind === 'x_post';
    case 'articles':
      return kind === 'article';
    case 'images':
      return kind === 'image';
    case 'colors':
      return kind === 'color';
    case 'quotes':
      return kind === 'quote';
    case 'products':
      return kind === 'product';
    default:
      return true;
  }
}

/** Chip filter plus tokenized AND search over the precomputed haystacks. */
export function searchCaptures(
  index: IdeaSearchIndex,
  query: string,
  chip: IdeaChip = 'all',
): IdeaCapture[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out: IdeaCapture[] = [];
  for (const entry of index) {
    if (!chipMatches(chip, entry.record)) continue;
    let matched = true;
    for (const token of tokens) {
      if (!entry.haystack.includes(token)) {
        matched = false;
        break;
      }
    }
    if (matched) out.push(entry.record);
  }
  return out;
}
