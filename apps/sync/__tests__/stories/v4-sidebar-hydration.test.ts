// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import V4Sidebar from '../../src/desktop-alt/v4/V4Sidebar.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_syncable_workspaces') {
      return { workspaces: [], cloudReachable: false };
    }
    return [];
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  vi.clearAllMocks();
});

describe('V4Sidebar hydration ownership', () => {
  it('treats an explicitly empty company list as authoritative instead of self-loading', async () => {
    component = mount(V4Sidebar, {
      target: host,
      props: {
        route: { kind: 'home' },
        companies: [],
        cloudReachable: false,
      },
    });
    flushSync();
    await Promise.resolve();

    expect(tauri.invoke).not.toHaveBeenCalledWith('list_syncable_workspaces');
    expect(host.querySelectorAll('.v4-company-row')).toHaveLength(0);
  });
});
