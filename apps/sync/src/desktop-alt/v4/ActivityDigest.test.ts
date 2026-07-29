// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import ActivityDigest from './ActivityDigest.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('ActivityDigest log handoff recovery', () => {
  it('shows a rejected handoff and clears it after retry', async () => {
    const onopenlog = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('window unavailable'))
      .mockResolvedValueOnce();
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(ActivityDigest, {
      target: host,
      props: { groups: [], onopenlog },
    });

    host.querySelector<HTMLButtonElement>('.v4-digest-log')?.click();
    await vi.waitFor(() => {
      expect(host.querySelector('[role="alert"]')?.textContent).toContain(
        'Couldn’t open the event log.',
      );
    });

    host.querySelector<HTMLButtonElement>('.v4-digest-error button')?.click();
    await vi.waitFor(() => {
      expect(onopenlog).toHaveBeenCalledTimes(2);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    });
  });
});
