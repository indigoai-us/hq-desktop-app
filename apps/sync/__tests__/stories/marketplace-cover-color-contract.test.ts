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
import type { MarketplaceListing } from '../../src/desktop-alt/lib/marketplace';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const listings: MarketplaceListing[] = [
  {
    id: 'real-art',
    type: 'skill',
    name: 'Full Color Art',
    slug: 'full-color-art',
    version: '1.0.0',
    author: 'maya',
    summary: 'A creator cover whose original colors must remain intact.',
    createdAt: '2026-07-28T12:00:00Z',
    coverImageUrl: 'https://cdn.example.com/full-color.jpg',
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
  it('preserves real artwork colors and limits generated tinting to fallbacks', async () => {
    component = mount(MarketplacePanel, { target: host });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="marketplace-card"]')).toHaveLength(2);
    });

    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="marketplace-card"]')];
    const real = cards.find((card) => card.textContent?.includes('Full Color Art'));
    const fallback = cards.find((card) => card.textContent?.includes('Fallback Art'));
    expect(real).toBeTruthy();
    expect(fallback).toBeTruthy();

    expect(real!.querySelector('.cover-img')).toBeTruthy();
    expect(real!.querySelector('.cover-color')).toBeNull();
    expect(fallback!.querySelector('.cover-fallback')).toBeTruthy();
    expect(fallback!.querySelector('.cover-color')).toBeTruthy();

    real!.click();
    flushSync();
    const detail = host.querySelector('[data-testid="marketplace-detail-cover"]');
    expect(detail?.querySelector('.detail-cover-img')).toBeTruthy();
    expect(detail?.querySelector('.cover-color')).toBeNull();
  });
});
