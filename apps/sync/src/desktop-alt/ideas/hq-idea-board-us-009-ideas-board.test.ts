// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.fn();
const listen = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listen(...args) }));

import { mount, tick, unmount } from 'svelte';
import IdeasBoard from './IdeasBoard.svelte';
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
      window_title: `Window ${over.id}`,
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

const KINDS: IdeaKind[] = ['x_post', 'article', 'image', 'quote', 'product', 'color'];

function mixed(count: number): IdeaCapture[] {
  return Array.from({ length: count }, (_, i) =>
    record({
      id: `id-${String(i).padStart(3, '0')}`,
      kind: KINDS[i % KINDS.length],
      extracted: { title: `Capture ${i}`, source: 'example.com', text: `Capture ${i}` },
      // Ascending creation time so the newest id sorts first.
      created_at: `2026-09-01T10:${String(i).padStart(2, '0')}:00Z`,
    }),
  );
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let listeners: Array<(event: { payload: unknown }) => void> = [];

async function render(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(IdeasBoard, { target: host, props: { slug: 'indigo' } });
  await settle();
  return host;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
  await tick();
}

beforeEach(() => {
  listeners = [];
  invoke.mockReset();
  listen.mockReset();
  listen.mockImplementation(async (_name: string, handler: (e: { payload: unknown }) => void) => {
    listeners.push(handler);
    return () => {};
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('US-009 IdeasBoard', () => {
  it('renders every capture newest first in the masonry grid', async () => {
    const rows = mixed(30);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? rows : { mimeType: 'image/png', dataBase64: 'AAAA' },
    );
    const el = await render();

    const cards = el.querySelectorAll('.ideas-masonry .idea-card');
    expect(cards).toHaveLength(30);
    const titles = [...el.querySelectorAll('.ideas-masonry .idea-card')].map((c) =>
      c.textContent ?? '',
    );
    expect(titles[0]).toContain('Capture 29');
    expect(titles[29]).toContain('Capture 0');
  });

  it('shows the capture chord in the empty state rather than a blank grid', async () => {
    invoke.mockResolvedValue([]);
    const el = await render();
    const empty = el.querySelector('.ideas-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toMatch(/(⌥⇧C|Alt\+Shift\+C)/);
    expect(el.querySelector('.ideas-masonry')).toBeNull();
  });

  it('shows a loading state while the list command is in flight, never the empty state', async () => {
    invoke.mockImplementation(() => new Promise(() => {}));
    const el = await render();
    expect(el.querySelector('.ideas-loading')).not.toBeNull();
    expect(el.querySelector('.ideas-empty')).toBeNull();
    expect(el.querySelector('.ideas-masonry')).toBeNull();
  });

  it('promotes a low-confidence record to its resolved kind, never unknown', async () => {
    const row = record({ id: 'id-low', kind: 'unknown', status: 'low_confidence' });
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? [row] : { mimeType: 'image/png', dataBase64: 'AAAA' },
    );
    const el = await render();

    el.querySelector<HTMLButtonElement>('.idea-lowconf-accept')?.click();
    await settle();

    const call = invoke.mock.calls.find(([cmd]) => cmd === 'ideas_set_kind');
    expect(call).toBeDefined();
    expect(call?.[1]).toMatchObject({ kind: 'image', status: 'extracted' });
  });

  it('shows an error state with a retry that reloads', async () => {
    invoke.mockRejectedValueOnce(new Error('vault unreachable'));
    const el = await render();
    expect(el.querySelector('.ideas-error')?.textContent).toContain('vault unreachable');

    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? mixed(2) : { mimeType: 'image/png', dataBase64: 'AAAA' },
    );
    el.querySelector<HTMLButtonElement>('.ideas-retry')?.click();
    await settle();
    expect(el.querySelector('.ideas-error')).toBeNull();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(2);
  });

  it('narrows the grid as the user types and when a chip is picked', async () => {
    const rows = mixed(12);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? rows : { mimeType: 'image/png', dataBase64: 'AAAA' },
    );
    const el = await render();

    const search = el.querySelector<HTMLInputElement>('.ideas-search');
    expect(search).not.toBeNull();
    search!.value = 'Capture 7';
    search!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(1);

    search!.value = '';
    search!.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    el.querySelector<HTMLButtonElement>('.ideas-chip[data-chip="quotes"]')?.click();
    await settle();
    const quoteCards = el.querySelectorAll('.ideas-masonry .idea-card[data-kind="quote"]');
    expect(quoteCards.length).toBe(2);
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(2);
  });

  it('upserts a record arriving on a capture event', async () => {
    const rows = mixed(2);
    invoke.mockImplementation(async (cmd: string) =>
      cmd === 'ideas_list_captures' ? rows : { mimeType: 'image/png', dataBase64: 'AAAA' },
    );
    const el = await render();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(2);
    expect(listeners.length).toBe(2);

    // A brand-new capture appears.
    listeners[0]({
      payload: record({
        id: 'id-900',
        kind: 'article',
        extracted: { title: 'Fresh capture', source: 'example.com' },
        created_at: '2026-09-02T10:00:00Z',
      }),
    });
    await settle();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(3);
    expect(el.querySelector('.ideas-masonry .idea-card')?.textContent).toContain('Fresh capture');

    // An enrichment revision replaces it in place.
    listeners[1]({
      payload: record({
        id: 'id-900',
        kind: 'article',
        extracted: { title: 'Revised capture', source: 'example.com' },
        created_at: '2026-09-02T10:00:00Z',
      }),
    });
    await settle();
    expect(el.querySelectorAll('.ideas-masonry .idea-card')).toHaveLength(3);
    expect(el.querySelector('.ideas-masonry .idea-card')?.textContent).toContain(
      'Revised capture',
    );
  });
});
