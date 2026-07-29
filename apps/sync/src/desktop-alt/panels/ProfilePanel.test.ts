// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, unmount } from 'svelte';
import ProfilePanel from './ProfilePanel.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

describe('ProfilePanel CSP-safe avatar fallback', () => {
  it('shows initials and an explicit unavailable state for presigned remote avatars', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'get_my_creator') {
        return {
          handle: 'corey',
          displayName: 'Corey',
          bio: '',
          socialLinks: [],
          tipUrl: null,
          avatarUrl: 'https://cdn.example.com/corey.png',
        };
      }
      if (command === 'get_creator_profile') {
        return {
          creator: {
            handle: 'corey',
            displayName: 'Corey',
            bio: '',
            socialLinks: [],
            tipUrl: null,
            avatarUrl: 'https://cdn.example.com/corey.png',
          },
          listings: [],
        };
      }
      throw new Error(`Unexpected invoke: ${command}`);
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(ProfilePanel, { target: host });

    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-edit"]')).not.toBeNull();
    });

    expect(host.querySelector('[data-testid="profile-avatar-img"]')).toBeNull();
    expect(host.querySelector('[data-testid="profile-avatar-fallback"]')?.textContent).toBe('C');
    expect(
      host.querySelector('[data-testid="profile-avatar-preview-unavailable"]')?.textContent,
    ).toContain('preview unavailable');
    expect(host.querySelector('img[src^="http"]')).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-testid="profile-preview-refresh"]')?.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-preview-name"]')?.textContent).toBe(
        'Corey',
      );
    });

    expect(host.querySelector('[data-testid="profile-preview-avatar-img"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="profile-preview-avatar-fallback"]')?.textContent,
    ).toBe('C');
    expect(
      host.querySelector('[data-testid="profile-preview-avatar-unavailable"]')?.textContent,
    ).toContain('Avatar preview unavailable');
    expect(host.querySelector('img[src^="http"]')).toBeNull();
  });
});
