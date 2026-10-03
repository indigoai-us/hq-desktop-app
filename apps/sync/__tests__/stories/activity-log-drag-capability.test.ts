// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => []),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

import { mount, tick, unmount } from 'svelte';

import ActivityLog from '../../src/components/ActivityLog.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('HQ-SYNC-WEB-3: activity-log drag region', () => {
  it('renders the ActivityLog header as a Tauri drag region', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(ActivityLog, { target: host });
    await tick();

    const header = host.querySelector('header');
    expect(header).not.toBeNull();
    expect(header?.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(header?.textContent).toContain('Recent Changes');
  });
});
