// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
}));
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => listeners.delete(name));
  }),
}));

import { flushSync, mount, tick, unmount } from 'svelte';

import BannerNotification from './BannerNotification.svelte';

const payload = {
  kind: 'dm',
  title: 'Ada',
  body: 'Hello',
  clickActionId: 'open',
  data: null,
};

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    flushSync();
    await tick();
    await Promise.resolve();
  }
}

describe('BannerNotification best-effort window calls', () => {
  let host: HTMLDivElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    listeners.clear();
    tauri.invoke.mockReset();
    tauri.invoke.mockResolvedValue(undefined);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (component) unmount(component);
    component = null;
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('logs a failed banner resize and still shows the notification', async () => {
    const error = new Error('resize failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'resize_banner') throw error;
      return undefined;
    });
    component = mount(BannerNotification, { target: host });
    await settle();
    listeners.get('banner:event')?.({ payload });
    await settle();

    expect(logged).toHaveBeenCalledWith('banner: resize failed', error);
    expect(host.textContent).toContain('Hello');
  });

  it('logs a failed native dismiss and still clears the banner locally', async () => {
    const error = new Error('dismiss failed');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    tauri.invoke.mockImplementation(async (command: unknown) => {
      if (command === 'dismiss_banner') throw error;
      return undefined;
    });
    component = mount(BannerNotification, { target: host });
    await settle();
    listeners.get('banner:event')?.({ payload });
    await settle();
    logged.mockClear();

    host.querySelector<HTMLButtonElement>('button.close')?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await settle();

    expect(logged).toHaveBeenCalledWith('banner: dismiss failed', error);
    expect(host.querySelector('.banner')?.classList.contains('leaving')).toBe(true);
  });
});
