import { describe, expect, it } from 'vitest';

import {
  buildSearchIndex,
  cardKind,
  cardMeta,
  cardTitle,
  FILTER_CHIPS,
  kindLabel,
  readTimeMinutes,
  searchCaptures,
} from './ideaSearch';
import type { IdeaCapture, IdeaKind, IdeaStatus } from '../../stores/ideaCaptures';

function record(over: Partial<IdeaCapture> & { id: string }): IdeaCapture {
  return {
    company_slug: 'indigo',
    kind: 'image' as IdeaKind,
    status: 'extracted' as IdeaStatus,
    confidence: 0.9,
    image_path: ['companies', 'indigo', 'ideas', over.id, 'image.png'].join('/'),
    ocr_text: null,
    extracted: null,
    tags: [],
    provenance: {
      app: 'Safari',
      window_title: 'Window',
      url: null,
      captured_at: '2026-09-01T10:00:00Z',
      display_id: 1,
    },
    note: null,
    cited_count: 0,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
    ...over,
  } as IdeaCapture;
}

const CORPUS: IdeaCapture[] = [
  record({
    id: 'a',
    kind: 'x_post',
    extracted: { author: 'Ada', handle: '@ada', body: 'shipping pricing experiments' },
  }),
  record({
    id: 'b',
    kind: 'article',
    extracted: { title: 'Latency budgets', source: 'example.com' },
    ocr_text: 'a long article about pricing pages and budgets',
  }),
  record({ id: 'c', kind: 'color', extracted: { palette: ['#ff0000', '#00ff00'] } }),
  record({ id: 'd', kind: 'quote', extracted: { text: 'Make it simple', attribution: 'Dieter' } }),
  record({ id: 'e', kind: 'product', extracted: { name: 'Desk lamp', price: '$120' } }),
  record({ id: 'f', kind: 'unknown', status: 'pending', tags: ['inspo'] }),
  record({
    id: 'g',
    kind: 'image',
    provenance: {
      app: 'Figma',
      window_title: 'Pricing board',
      url: 'https://www.figma.com/file/1',
      captured_at: '2026-09-01T10:00:00Z',
      display_id: 1,
    },
  }),
];

describe('US-009 idea search', () => {
  it('declares the seven filter chips', () => {
    expect(FILTER_CHIPS.map((c) => c.id)).toEqual([
      'all',
      'posts',
      'articles',
      'images',
      'colors',
      'quotes',
      'products',
    ]);
  });

  it('maps unknown kinds and plain status to the image card', () => {
    expect(cardKind(record({ id: 'x', kind: 'unknown' }))).toBe('image');
    expect(cardKind(record({ id: 'y', kind: 'x_post', status: 'plain' }))).toBe('image');
    expect(cardKind(record({ id: 'z', kind: 'quote' }))).toBe('quote');
    expect(kindLabel('x_post')).toBe('X post');
  });

  it('filters by chip, folding unknown into Images', () => {
    const index = buildSearchIndex(CORPUS);
    expect(searchCaptures(index, '', 'posts').map((r) => r.id)).toEqual(['a']);
    expect(searchCaptures(index, '', 'articles').map((r) => r.id)).toEqual(['b']);
    expect(searchCaptures(index, '', 'colors').map((r) => r.id)).toEqual(['c']);
    expect(searchCaptures(index, '', 'quotes').map((r) => r.id)).toEqual(['d']);
    expect(searchCaptures(index, '', 'products').map((r) => r.id)).toEqual(['e']);
    expect(searchCaptures(index, '', 'images').map((r) => r.id)).toEqual(['f', 'g']);
    expect(searchCaptures(index, '', 'all')).toHaveLength(CORPUS.length);
  });

  it('searches title, extracted fields, ocr text, tags and provenance', () => {
    const index = buildSearchIndex(CORPUS);
    expect(searchCaptures(index, 'latency').map((r) => r.id)).toEqual(['b']);
    expect(searchCaptures(index, '@ada').map((r) => r.id)).toEqual(['a']);
    expect(searchCaptures(index, '#00ff00').map((r) => r.id)).toEqual(['c']);
    expect(searchCaptures(index, 'inspo').map((r) => r.id)).toEqual(['f']);
    expect(searchCaptures(index, 'figma.com').map((r) => r.id)).toEqual(['g']);
    expect(searchCaptures(index, 'pricing budgets').map((r) => r.id)).toEqual(['b']);
    expect(searchCaptures(index, 'pricing').map((r) => r.id)).toEqual(['a', 'b', 'g']);
  });

  it('searches 1,000 records within the 50ms budget', () => {
    const many: IdeaCapture[] = [];
    for (let i = 0; i < 1000; i += 1) {
      many.push(
        record({
          id: `r${i}`,
          kind: i % 3 === 0 ? 'article' : 'image',
          extracted: { title: `Record ${i}`, source: 'example.com' },
          ocr_text: i % 7 === 0 ? 'pricing page teardown' : `filler text number ${i}`,
          tags: [`tag${i % 11}`],
        }),
      );
    }
    const index = buildSearchIndex(many);
    const started = performance.now();
    const hits = searchCaptures(index, 'pricing', 'all');
    const elapsed = performance.now() - started;
    expect(hits.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(50);
  });

  it('derives read time from word count at 200wpm, never below one minute', () => {
    expect(readTimeMinutes('')).toBe(1);
    expect(readTimeMinutes('one two three')).toBe(1);
    expect(readTimeMinutes(new Array(600).fill('word').join(' '))).toBe(3);
  });

  it('falls back through extracted title, window title, then app', () => {
    expect(cardTitle(CORPUS[1])).toBe('Latency budgets');
    expect(cardTitle(record({ id: 'q' }))).toBe('Window');
    expect(
      cardTitle(
        record({
          id: 'r',
          provenance: {
            app: 'Preview',
            window_title: '',
            url: null,
            captured_at: '2026-09-01T10:00:00Z',
            display_id: 1,
          },
        }),
      ),
    ).toBe('Preview');
    expect(cardMeta(CORPUS[6])).toContain('figma.com');
  });
});
