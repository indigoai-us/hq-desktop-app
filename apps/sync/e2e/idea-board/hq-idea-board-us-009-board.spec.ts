// @vitest-environment happy-dom
//
// hq-idea-board US-009 acceptance specs for the Ideas board.
//
// One file, four acceptance criteria, driven against the real components:
//   AC1  30 mixed records render in the masonry grid with the right card
//        layout per kind, newest first, under the 4/3/2 column rule.
//   AC2  a low_confidence record offers accept / dismiss, and "Just an image"
//        writes kind=image status=plain through ideas_set_kind.
//   AC3  1,000 records filter to the 'pricing' matches inside 50ms, and the
//        rendered board narrows to exactly those cards.
//   AC4  no records shows the capture chord, not a blank grid.
//
// Plus a source contract over the Rust command layer, so the board's two
// backing commands cannot be renamed or unregistered without this failing.
//
// The Tauri boundary is mocked completely (`invoke`, `listen`); everything on
// the app side of that boundary — store, search, components — is the real code.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { mount, tick, unmount } from 'svelte';
import IdeasBoard from '../../src/desktop-alt/ideas/IdeasBoard.svelte';
import { buildSearchIndex, searchCaptures } from '../../src/desktop-alt/ideas/ideaSearch';
import type { IdeaCapture, IdeaKind, IdeaStatus } from '../../src/stores/ideaCaptures';

const APP_ROOT = resolve(__dirname, '../..');

/** A 1x1 PNG header is enough: the store only needs mime + base64 to build a src. */
const PREVIEW = { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' };

function record(over: Partial<IdeaCapture> & { id: string }): IdeaCapture {
  return {
    company_slug: 'indigo',
    kind: 'image' as IdeaKind,
    status: 'extracted' as IdeaStatus,
    confidence: 0.92,
    image_path: ['companies', 'indigo', 'ideas', over.id, 'image.png'].join('/'),
    ocr_text: null,
    extracted: null,
    tags: [],
    provenance: {
      app: 'Safari',
      window_title: `Window ${over.id}`,
      url: 'https://example.com/post',
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

/** All six laid-out kinds plus `unknown`, which must fall back to the image card. */
const KIND_CYCLE: IdeaKind[] = ['x_post', 'article', 'image', 'quote', 'product', 'color', 'unknown'];

function extractedFor(kind: IdeaKind, i: number): Record<string, unknown> {
  switch (kind) {
    case 'x_post':
      return { author: `Author ${i}`, handle: `@author${i}`, body: `Post body ${i}` };
    case 'article':
      return {
        title: `Article ${i}`,
        source: 'example.com',
        body: Array.from({ length: 420 }, (_, w) => `word${w}`).join(' '),
      };
    case 'quote':
      return { text: `Quoted line ${i}`, attribution: `Someone ${i}` };
    case 'color':
      return { palette: ['#112233', '#445566', '#778899'] };
    case 'product':
      return { name: `Product ${i}`, price: '$49', source: 'shop.example.com' };
    default:
      return { caption: `Capture ${i}` };
  }
}

/** Deterministic mixed records, ascending created_at so the last index sorts first. */
function mixed(count: number): IdeaCapture[] {
  return Array.from({ length: count }, (_, i) => {
    const kind = KIND_CYCLE[i % KIND_CYCLE.length];
    const minute = String(i % 60).padStart(2, '0');
    const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
    return record({
      id: `id-${String(i).padStart(4, '0')}`,
      kind,
      extracted: extractedFor(kind, i),
      created_at: `2026-09-01T${hour}:${minute}:00Z`,
      updated_at: `2026-09-01T${hour}:${minute}:00Z`,
    });
  });
}

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
  await tick();
}

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
  await settle();
  return host;
}

function listCommand(rows: IdeaCapture[]): void {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'ideas_list_captures') return rows;
    if (cmd === 'get_authorized_file_preview') return PREVIEW;
    return null;
  });
}

function type(el: HTMLElement, value: string): void {
  const search = el.querySelector<HTMLInputElement>('.ideas-search');
  expect(search).not.toBeNull();
  search!.value = value;
  search!.dispatchEvent(new Event('input', { bubbles: true }));
}

function byNewest(a: IdeaCapture, b: IdeaCapture): number {
  if (a.created_at === b.created_at) return b.id.localeCompare(a.id);
  return a.created_at < b.created_at ? 1 : -1;
}

beforeEach(() => {
  invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(async () => () => {});
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

describe('US-009 AC1 — 30 mixed records in the masonry grid', () => {
  it('renders all 30 cards newest first', async () => {
    const rows = mixed(30);
    listCommand(rows);
    const el = await render();

    const cards = el.querySelectorAll('.ideas-masonry .idea-card');
    expect(cards).toHaveLength(30);

    const expectedOrder = [...rows].sort(byNewest).map((r) => r.id);
    expect(expectedOrder[0]).toBe('id-0029');
    expect(expectedOrder[29]).toBe('id-0000');

    // Cards carry no id attribute, so order is asserted through each record's
    // unique derived title.
    const titles = [...cards].map((c) => c.textContent ?? '');
    // Record 29 is an article, record 0 an X post (7-kind cycle).
    expect(titles[0]).toContain('Article 29');
    expect(titles[29]).toContain('Post body 0');
  });

  it('gives every kind its own card layout', async () => {
    listCommand(mixed(30));
    const el = await render();

    const byKind = (kind: string) =>
      [...el.querySelectorAll<HTMLElement>(`.ideas-masonry .idea-card[data-kind="${kind}"]`)];

    // 30 records over a 7-kind cycle: 5 each of the first two kinds, 4 of the
    // rest; `unknown` renders as an image card, so images absorb its share.
    expect(byKind('x_post')).toHaveLength(5);
    expect(byKind('article')).toHaveLength(5);
    expect(byKind('quote')).toHaveLength(4);
    expect(byKind('color')).toHaveLength(4);
    expect(byKind('product')).toHaveLength(4);
    expect(byKind('image')).toHaveLength(8);
    expect(byKind('unknown')).toHaveLength(0);

    const post = byKind('x_post')[0];
    expect(post.querySelector('.xhead')).not.toBeNull();
    expect(post.querySelector('.avatar')).not.toBeNull();
    expect(post.querySelector('.xhandle')?.textContent?.trim()).toMatch(/^@author\d+$/);

    const quote = byKind('quote')[0];
    expect(quote.querySelector('blockquote')).not.toBeNull();
    expect(quote.querySelector('blockquote')?.textContent).toContain('Quoted line');

    const color = byKind('color')[0];
    expect(color.querySelectorAll('.swatches .swatch')).toHaveLength(3);

    const article = byKind('article')[0];
    // 420 words at 200 wpm rounds up to 3 minutes.
    expect(article.textContent).toContain('3 min read');

    const product = byKind('product')[0];
    expect(product.querySelector('.shot')).not.toBeNull();
    expect(product.textContent).toContain('$49');

    const image = byKind('image')[0];
    expect(image.querySelector('.shot')).not.toBeNull();

    // Thumbnails come back through the authorized preview command as a data
    // URL — a packaged build refuses file:// sources.
    const img = image.querySelector<HTMLImageElement>('.shot img');
    expect(img?.getAttribute('src')).toBe(`data:${PREVIEW.mimeType};base64,${PREVIEW.dataBase64}`);
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'get_authorized_file_preview')).toBe(true);
  });

  it('declares the 4 / 3 / 2 masonry column rule', () => {
    const source = readFileSync(
      resolve(APP_ROOT, 'src/desktop-alt/ideas/IdeasBoard.svelte'),
      'utf8',
    );
    expect(source).toMatch(/\.ideas-masonry\s*\{[^}]*column-count:\s*2/);
    expect(source).toMatch(/min-width:\s*800px\)\s*\{\s*\.ideas-masonry\s*\{\s*column-count:\s*3/);
    expect(source).toMatch(/min-width:\s*1100px\)\s*\{\s*\.ideas-masonry\s*\{\s*column-count:\s*4/);
  });
});

describe('US-009 AC2 — low-confidence accept / dismiss strip', () => {
  const lowConf = record({
    id: 'id-low',
    kind: 'x_post',
    status: 'low_confidence',
    confidence: 0.41,
    extracted: { author: 'Author L', handle: '@authorL', body: 'Maybe a post' },
  });

  it('offers the verdict, and "Just an image" demotes the card to a plain image', async () => {
    const demoted = { ...lowConf, kind: 'image' as IdeaKind, status: 'plain' as IdeaStatus };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'ideas_list_captures') return [lowConf];
      if (cmd === 'ideas_set_kind') return demoted;
      if (cmd === 'get_authorized_file_preview') return PREVIEW;
      return null;
    });
    const el = await render();

    const strip = el.querySelector<HTMLElement>('.idea-lowconf-strip');
    expect(strip).not.toBeNull();
    expect(strip!.textContent).toContain('Looks like an X post?');
    expect(strip!.querySelector('.idea-lowconf-accept')?.textContent?.trim()).toBe('Yes');
    const dismiss = strip!.querySelector<HTMLButtonElement>('.idea-lowconf-dismiss');
    expect(dismiss?.textContent?.trim()).toBe('Just an image');

    dismiss!.click();
    await settle();

    expect(invoke).toHaveBeenCalledWith('ideas_set_kind', {
      id: 'id-low',
      kind: 'image',
      status: 'plain',
    });
    const card = el.querySelector('.ideas-masonry .idea-card');
    expect(card?.getAttribute('data-kind')).toBe('image');
    expect(card?.getAttribute('data-status')).toBe('plain');
    expect(el.querySelector('.idea-lowconf-strip')).toBeNull();
  });

  it('"Yes" keeps the guessed kind and promotes the status', async () => {
    const accepted = { ...lowConf, status: 'extracted' as IdeaStatus };
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'ideas_list_captures') return [lowConf];
      if (cmd === 'ideas_set_kind') return accepted;
      if (cmd === 'get_authorized_file_preview') return PREVIEW;
      return null;
    });
    const el = await render();

    el.querySelector<HTMLButtonElement>('.idea-lowconf-accept')!.click();
    await settle();

    expect(invoke).toHaveBeenCalledWith('ideas_set_kind', {
      id: 'id-low',
      kind: 'x_post',
      status: 'extracted',
    });
    const card = el.querySelector('.ideas-masonry .idea-card');
    expect(card?.getAttribute('data-kind')).toBe('x_post');
    expect(card?.getAttribute('data-status')).toBe('extracted');
    expect(el.querySelector('.idea-lowconf-strip')).toBeNull();
  });
});

describe('US-009 AC3 — search over 1,000 records', () => {
  // 40 of the 1,000 records mention "pricing", spread across every searchable
  // field so the index has to cover extracted text, OCR, tags, note and
  // provenance — not just the title.
  const FIELDS = ['title', 'extracted', 'ocr', 'tags', 'note', 'provenance', 'url', 'body'] as const;

  function thousand(): { rows: IdeaCapture[]; matchIds: string[] } {
    const rows: IdeaCapture[] = [];
    const matchIds: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const kind = KIND_CYCLE[i % KIND_CYCLE.length];
      const row = record({
        id: `id-${String(i).padStart(4, '0')}`,
        kind,
        extracted: extractedFor(kind, i),
      });
      if (i % 25 === 0) {
        const field = FIELDS[(i / 25) % FIELDS.length];
        switch (field) {
          case 'title':
            row.extracted = { ...(row.extracted ?? {}), title: `Pricing page ${i}` };
            break;
          case 'extracted':
            row.extracted = { ...(row.extracted ?? {}), summary: `notes about pricing ${i}` };
            break;
          case 'body':
            row.extracted = { ...(row.extracted ?? {}), body: `deep dive on pricing ${i}` };
            break;
          case 'ocr':
            row.ocr_text = `screenshot text mentioning PRICING ${i}`;
            break;
          case 'tags':
            row.tags = ['pricing', 'research'];
            break;
          case 'note':
            row.note = `manual note: pricing ${i}`;
            break;
          case 'provenance':
            row.provenance = { ...row.provenance, window_title: `Pricing — Window ${i}` };
            break;
          case 'url':
            row.provenance = { ...row.provenance, url: `https://example.com/pricing/${i}` };
            break;
        }
        matchIds.push(row.id);
      }
      rows.push(row);
    }
    return { rows, matchIds };
  }

  it('filters 1,000 records to exactly the pricing matches within 50ms', () => {
    const { rows, matchIds } = thousand();
    expect(rows).toHaveLength(1000);
    expect(matchIds).toHaveLength(40);

    const index = buildSearchIndex(rows);
    // Warm up so the measured pass is a steady-state keystroke, not first-call JIT.
    for (let i = 0; i < 5; i += 1) searchCaptures(index, 'pricing');

    const started = performance.now();
    const hits = searchCaptures(index, 'pricing');
    const elapsed = performance.now() - started;

    expect(hits.map((r) => r.id).sort()).toEqual([...matchIds].sort());
    expect(elapsed).toBeLessThan(50);
  });

  it('narrows the rendered board to the matching cards as the query is typed', async () => {
    const { rows, matchIds } = thousand();
    listCommand(rows);
    const el = await render();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(1000);

    type(el, 'pricing');
    await settle();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(matchIds.length);

    type(el, 'nothingmatchesthisstring');
    await settle();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(0);
    expect(el.querySelector('.ideas-noresults')).not.toBeNull();
  }, 120_000);
});

describe('US-009 AC4 — empty board', () => {
  it('shows the capture chord instead of an empty grid', async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? [] : PREVIEW,
    );
    const el = await render();

    const empty = el.querySelector<HTMLElement>('.ideas-empty');
    expect(empty).not.toBeNull();
    const chord = empty!.querySelector('.ideas-empty-chord')?.textContent?.trim();
    expect(['⌥⇧C', 'Alt+Shift+C']).toContain(chord);
    expect(empty!.textContent).toContain(`Press ${chord} anywhere to capture`);
    expect(el.querySelector('.ideas-masonry')).toBeNull();
    expect(el.querySelectorAll('.idea-card')).toHaveLength(0);
  });
});

describe('US-009 — the Rust command surface the board depends on', () => {
  const captureRs = readFileSync(resolve(APP_ROOT, 'src-tauri/src/commands/capture.rs'), 'utf8');
  const mainRs = readFileSync(resolve(APP_ROOT, 'src-tauri/src/main.rs'), 'utf8');

  it('defines ideas_list_captures and ideas_set_kind as tauri commands', () => {
    expect(captureRs).toMatch(/#\[tauri::command\][\s\S]{0,400}?fn ideas_list_captures\b/);
    expect(captureRs).toMatch(/#\[tauri::command\][\s\S]{0,400}?fn ideas_set_kind\b/);
  });

  it('registers both in the invoke handler', () => {
    expect(mainRs).toContain('commands::capture::ideas_list_captures');
    expect(mainRs).toContain('commands::capture::ideas_set_kind');
  });
});
