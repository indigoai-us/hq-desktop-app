// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import IdeaCard from './IdeaCard.svelte';
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

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

interface CardProps {
  record: IdeaCapture;
  thumbnail?: string | null;
  onaccept?: (record: IdeaCapture) => void;
  ondismiss?: (record: IdeaCapture) => void;
}

function render(props: CardProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(IdeaCard, { target: host, props });
  return host;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('US-009 IdeaCard', () => {
  it('renders an x_post with avatar, name, handle and body', () => {
    const el = render({
      record: record({
        id: 'a',
        kind: 'x_post',
        extracted: { author: 'Ada', handle: '@ada', body: 'ship it' },
      }),
    });
    const card = el.querySelector('.idea-card');
    expect(card?.getAttribute('data-kind')).toBe('x_post');
    expect(el.querySelector('.idea-card .xhead')).not.toBeNull();
    expect(el.textContent).toContain('Ada');
    expect(el.textContent).toContain('@ada');
    expect(el.textContent).toContain('ship it');
  });

  it('renders an article with title, source and derived read time', () => {
    const el = render({
      record: record({
        id: 'b',
        kind: 'article',
        extracted: { title: 'Latency budgets', source: 'example.com' },
        ocr_text: new Array(600).fill('word').join(' '),
      }),
    });
    expect(el.querySelector('.idea-card')?.getAttribute('data-kind')).toBe('article');
    expect(el.textContent).toContain('Latency budgets');
    expect(el.textContent).toContain('example.com');
    expect(el.textContent).toContain('3 min read');
  });

  it('renders an image card with the thumbnail, and folds unknown into it', () => {
    const el = render({
      record: record({ id: 'c', kind: 'unknown', extracted: { caption: 'a wall' } }),
      thumbnail: 'data:image/png;base64,AAAA',
    });
    expect(el.querySelector('.idea-card')?.getAttribute('data-kind')).toBe('image');
    expect(el.querySelector('.shot img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(el.textContent).toContain('a wall');
  });

  it('renders a quote as a blockquote and a color card as a swatch strip', () => {
    const quote = render({
      record: record({ id: 'd', kind: 'quote', extracted: { text: 'Less but better' } }),
    });
    expect(quote.querySelector('blockquote')?.textContent).toContain('Less but better');
    unmountSync();

    const color = render({
      record: record({ id: 'e', kind: 'color', extracted: { palette: ['#ff0000', '#00ff00'] } }),
    });
    expect(color.querySelectorAll('.swatches .swatch')).toHaveLength(2);
  });

  it('renders a product with thumbnail, name and price', () => {
    const el = render({
      record: record({
        id: 'f',
        kind: 'product',
        extracted: { name: 'Desk lamp', price: '$120', source: 'shop.example' },
      }),
      thumbnail: 'data:image/png;base64,BBBB',
    });
    expect(el.querySelector('.shot img')).not.toBeNull();
    expect(el.textContent).toContain('Desk lamp');
    expect(el.textContent).toContain('$120');
  });

  it('renders the four statuses distinctly', () => {
    const pending = render({ record: record({ id: 'g', status: 'pending', kind: 'unknown' }) });
    expect(pending.querySelector('.idea-card')?.getAttribute('data-status')).toBe('pending');
    expect(pending.querySelector('.shot .shimmer')).not.toBeNull();
    expect(pending.textContent).toContain('Reading');
    unmountSync();

    const extracted = render({
      record: record({ id: 'h', kind: 'article', extracted: { title: 'T', source: 'S' } }),
    });
    expect(extracted.querySelector('.idea-card')?.getAttribute('data-status')).toBe('extracted');
    expect(extracted.querySelector('.shimmer')).toBeNull();
    expect(extracted.querySelector('.idea-lowconf-strip')).toBeNull();
    unmountSync();

    const low = render({
      record: record({
        id: 'i',
        kind: 'x_post',
        status: 'low_confidence',
        extracted: { author: 'Ada' },
      }),
    });
    expect(low.querySelector('.idea-card')?.getAttribute('data-kind')).toBe('x_post');
    expect(low.querySelector('.idea-lowconf-strip')?.textContent).toContain('Looks like an X post?');
    expect(low.querySelector('.idea-lowconf-accept')?.textContent?.trim()).toBe('Yes');
    expect(low.querySelector('.idea-lowconf-dismiss')?.textContent?.trim()).toBe('Just an image');
    unmountSync();

    const plain = render({ record: record({ id: 'j', kind: 'x_post', status: 'plain' }) });
    expect(plain.querySelector('.idea-card')?.getAttribute('data-kind')).toBe('image');
    expect(plain.querySelector('.idea-lowconf-strip')).toBeNull();
  });

  it('shows the cited marker only when cited_count is above zero', () => {
    const none = render({ record: record({ id: 'k' }) });
    expect(none.querySelector('.idea-card-cited')).toBeNull();
    unmountSync();

    const cited = render({ record: record({ id: 'l', cited_count: 3 }) });
    expect(cited.querySelector('.idea-card-cited')?.textContent).toContain('Cited 3');
    expect(cited.querySelector('.idea-card-cited')?.textContent).toContain('by agents');
  });

  it('mounts a record with duplicate palette hexes and duplicate tags', () => {
    // Regression: keying #each by value threw Svelte's each_key_duplicate and
    // took the whole board down.
    expect(() =>
      render({
        record: record({
          id: 'dupe',
          kind: 'color',
          tags: ['a', 'a'],
          extracted: { palette: ['#ffffff', '#111111', '#ffffff'] },
        }),
      }),
    ).not.toThrow();
    expect(host.querySelectorAll('.swatches .swatch')).toHaveLength(3);
    expect(host.querySelectorAll('.ctags .ctag')).toHaveLength(1);
    expect(host.querySelector('.idea-card')?.getAttribute('data-id')).toBe('dupe');
  });

  it('reports the user verdict from the low-confidence strip', () => {
    const onaccept = vi.fn();
    const ondismiss = vi.fn();
    const target = record({ id: 'm', kind: 'x_post', status: 'low_confidence' });
    const el = render({ record: target, onaccept, ondismiss });

    el.querySelector<HTMLButtonElement>('.idea-lowconf-dismiss')?.click();
    expect(ondismiss).toHaveBeenCalledWith(target);
    el.querySelector<HTMLButtonElement>('.idea-lowconf-accept')?.click();
    expect(onaccept).toHaveBeenCalledWith(target);
  });
});

/** Tear down the current mount mid-test so another card can be rendered. */
function unmountSync(): void {
  if (component) void unmount(component);
  component = null;
  host?.remove();
}
