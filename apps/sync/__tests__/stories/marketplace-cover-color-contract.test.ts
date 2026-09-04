// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => () => undefined),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import MarketplacePanel from '../../src/desktop-alt/panels/MarketplacePanel.svelte';
import {
  MARKETPLACE_COVER_HOST,
} from '../../src/desktop-alt/lib/pack-covers';
import type { MarketplaceListing } from '../../src/desktop-alt/lib/marketplace';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const MARKETPLACE_COVER =
  `https://${MARKETPLACE_COVER_HOST}/listings/lst_real/cover.jpg?X-Amz-Signature=mock`;

const listings: MarketplaceListing[] = [
  {
    id: 'real-art',
    type: 'skill',
    name: 'hq-pack-client-service',
    slug: 'client-service',
    version: '1.0.0',
    author: 'maya',
    summary: 'A hosted marketplace cover must render on the card.',
    createdAt: '2026-07-28T12:00:00Z',
    coverImageUrl: MARKETPLACE_COVER,
  },
  {
    id: 'fallback-art',
    type: 'skill',
    name: 'Fallback Art',
    slug: 'no-art-yet',
    version: '1.0.0',
    author: 'maya',
    summary: 'A listing without an image receives a generated color identity.',
    createdAt: '2026-07-28T12:00:00Z',
    coverImageUrl: null,
  },
  {
    id: 'blocked-art',
    type: 'skill',
    name: 'Blocked Host Art',
    slug: 'blocked-host-art',
    version: '2.0.0',
    author: 'maya',
    summary: 'An arbitrary https cover must not bypass the packaged image policy.',
    createdAt: '2026-07-28T12:00:00Z',
    coverImageUrl: 'https://cdn.example.com/full-color.jpg',
  },
];

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_marketplace_listings') return listings;
    if (command === 'list_syncable_workspaces') return { workspaces: [] };
    throw new Error(`Unexpected invoke: ${command}`);
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('marketplace cover color contract', () => {
  it('renders the marketplace cover when present, falls back when absent, and keeps badge/version overlaid', async () => {
    component = mount(MarketplacePanel, { target: host });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="marketplace-card"]')).toHaveLength(3);
    });

    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="marketplace-card"]')];
    const real = cards.find((card) => card.textContent?.includes('Client Service'));
    const fallback = cards.find((card) => card.textContent?.includes('Fallback Art'));
    const blocked = cards.find((card) => card.textContent?.includes('Blocked Host Art'));
    expect(real).toBeTruthy();
    expect(fallback).toBeTruthy();
    expect(blocked).toBeTruthy();

    const realCover = real!.querySelector('[data-testid="marketplace-cover"]');
    const realImg = real!.querySelector<HTMLImageElement>('.cover-img');
    expect(realImg).toBeTruthy();
    expect(realImg!.src).toBe(MARKETPLACE_COVER);
    expect(real!.querySelector('.cover-fallback')).toBeNull();
    expect(realCover!.querySelector('.kind-chip')?.textContent).toMatch(/skill/);
    expect(realCover!.querySelector('[data-testid="marketplace-version"]')?.textContent).toBe(
      'v1.0.0',
    );

    expect(fallback!.querySelector('.cover-img')).toBeNull();
    expect(fallback!.querySelector('.cover-fallback')).toBeTruthy();
    expect(fallback!.querySelector('.cover-monogram')?.textContent).toBe('F');
    expect(fallback!.querySelector('[data-testid="marketplace-cover"] .kind-chip')?.textContent).toMatch(
      /skill/,
    );
    expect(
      fallback!.querySelector('[data-testid="marketplace-cover"] [data-testid="marketplace-version"]')
        ?.textContent,
    ).toBe('v1.0.0');

    expect(blocked!.querySelector('.cover-img')).toBeNull();
    expect(blocked!.querySelector('.cover-fallback')).toBeTruthy();
    expect(blocked!.querySelector('img[src^="https://cdn.example.com"]')).toBeNull();
    expect(
      blocked!.querySelector('[data-testid="marketplace-cover"] [data-testid="marketplace-version"]')
        ?.textContent,
    ).toBe('v2.0.0');

    real!.click();
    flushSync();
    const detail = host.querySelector('[data-testid="marketplace-detail-cover"]');
    const detailImg = detail?.querySelector<HTMLImageElement>('.detail-cover-img');
    expect(detailImg).toBeTruthy();
    expect(detailImg!.src).toBe(MARKETPLACE_COVER);
    expect(detail?.querySelector('.detail-cover-fallback')).toBeNull();
  });
});
