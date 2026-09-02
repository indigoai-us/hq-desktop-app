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
import { MARKETPLACE_COVER_HOST } from '../../src/desktop-alt/lib/pack-covers';
import type { MarketplaceListing } from '../../src/desktop-alt/lib/marketplace';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

const AUTHOR_AVATAR =
  `https://${MARKETPLACE_COVER_HOST}/members/prs_maya/h.png?X-Amz-Signature=mock`;

const listings: MarketplaceListing[] = [
  {
    id: 'with-avatar',
    type: 'skill',
    name: 'hq-pack-client-service',
    slug: 'client-service',
    version: '1.0.0',
    author: {
      handle: 'maya',
      displayName: 'Maya Chen',
      avatarUrl: AUTHOR_AVATAR,
    },
    summary: 'A listing whose creator has an HQ profile photo.',
    createdAt: '2026-07-28T12:00:00Z',
  },
  {
    id: 'without-avatar',
    type: 'skill',
    name: 'Fallback Author',
    slug: 'no-avatar-yet',
    version: '1.0.0',
    author: { handle: 'jacob', displayName: 'Jacob' },
    summary: 'A listing whose creator has no photo falls back to initials.',
    createdAt: '2026-07-28T12:00:00Z',
  },
  {
    id: 'blocked-avatar',
    type: 'skill',
    name: 'Blocked Avatar Host',
    slug: 'blocked-avatar-host',
    version: '2.0.0',
    author: {
      handle: 'mallory',
      displayName: 'Mallory',
      avatarUrl: 'https://cdn.example.com/face.jpg',
    },
    summary: 'An arbitrary https avatar must not bypass the packaged image policy.',
    createdAt: '2026-07-28T12:00:00Z',
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

describe('marketplace creator avatar contract', () => {
  it('renders the creator photo when present, initials when absent, and blocks off-host avatars', async () => {
    component = mount(MarketplacePanel, { target: host });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelectorAll('[data-testid="marketplace-card"]')).toHaveLength(3);
    });

    const cards = [...host.querySelectorAll<HTMLElement>('[data-testid="marketplace-card"]')];
    const withPhoto = cards.find((card) => card.textContent?.includes('Client Service'));
    const initialsOnly = cards.find((card) => card.textContent?.includes('Fallback Author'));
    const blocked = cards.find((card) => card.textContent?.includes('Blocked Avatar Host'));
    expect(withPhoto).toBeTruthy();
    expect(initialsOnly).toBeTruthy();
    expect(blocked).toBeTruthy();

    const photo = withPhoto!.querySelector<HTMLImageElement>(
      '[data-testid="marketplace-author-avatar"]',
    );
    expect(photo).toBeTruthy();
    expect(photo!.src).toBe(AUTHOR_AVATAR);
    expect(withPhoto!.querySelector('[data-testid="marketplace-author-initials"]')).toBeNull();
    expect(withPhoto!.querySelector('[data-testid="marketplace-author"]')?.getAttribute('title')).toBe(
      'Maya Chen',
    );
    expect(withPhoto!.textContent).toContain('@maya');

    expect(initialsOnly!.querySelector('[data-testid="marketplace-author-avatar"]')).toBeNull();
    expect(initialsOnly!.querySelector('[data-testid="marketplace-author-initials"]')?.textContent).toBe(
      'JA',
    );
    expect(initialsOnly!.querySelector('[data-testid="marketplace-author"]')?.getAttribute('title')).toBe(
      'Jacob',
    );
    expect(initialsOnly!.textContent).toContain('@jacob');

    expect(blocked!.querySelector('[data-testid="marketplace-author-avatar"]')).toBeNull();
    expect(blocked!.querySelector('img[src^="https://cdn.example.com"]')).toBeNull();
    expect(blocked!.querySelector('[data-testid="marketplace-author-initials"]')?.textContent).toBe(
      'MA',
    );

    withPhoto!.click();
    flushSync();
    const detailPhoto = host.querySelector<HTMLImageElement>(
      '[data-testid="marketplace-detail-author-avatar"]',
    );
    expect(detailPhoto).toBeTruthy();
    expect(detailPhoto!.src).toBe(AUTHOR_AVATAR);
    expect(host.querySelector('[data-testid="marketplace-detail-author"]')?.getAttribute('title')).toBe(
      'Maya Chen',
    );
  });
});
