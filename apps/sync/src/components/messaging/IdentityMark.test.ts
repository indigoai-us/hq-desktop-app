// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import IdentityMark from './IdentityMark.svelte';

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('IdentityMark', () => {
  it('uses a compact circular monogram for a person', () => {
    component = mount(IdentityMark, {
      target: host,
      props: { kind: 'person', label: 'Maya Chen' },
    });

    expect(host.querySelector('[data-kind="person"] .monogram')?.textContent).toBe('MC');
  });

  it('distinguishes group DMs and private channels without photo tiles', async () => {
    component = mount(IdentityMark, {
      target: host,
      props: { kind: 'group', members: ['Jacob Patel', 'Alan Turing'] },
    });
    expect(host.querySelectorAll('[data-kind="group"] .stack > span')).toHaveLength(2);

    await unmount(component);
    component = mount(IdentityMark, {
      target: host,
      props: { kind: 'channel', privateChannel: true },
    });
    expect(host.querySelector('[data-kind="channel"] .channel-lock')).not.toBeNull();
  });
});
