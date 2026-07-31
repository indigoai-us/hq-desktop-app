// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import NotificationActionRecovery from './NotificationActionRecovery.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = null;
});

afterEach(async () => {
  if (component) await unmount(component);
  host.remove();
});

describe('NotificationActionRecovery', () => {
  it('keeps a visible retry control for a failed native recovery surface', () => {
    const retry = vi.fn();
    component = mount(NotificationActionRecovery, {
      target: host,
      props: {
        message: 'Couldn’t finish the message action. Retry it here.',
        pending: false,
        onretry: retry,
      },
    });
    flushSync();

    const alert = host.querySelector<HTMLElement>(
      '[data-testid="notification-action-recovery"]',
    )!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('Couldn’t finish the message action.');

    alert.querySelector<HTMLButtonElement>('button')!.click();
    expect(retry).toHaveBeenCalledOnce();
  });

  it('exposes progress and blocks duplicate retries', () => {
    const retry = vi.fn();
    component = mount(NotificationActionRecovery, {
      target: host,
      props: {
        message: 'Retry the message action.',
        pending: true,
        onretry: retry,
      },
    });
    flushSync();

    const button = host.querySelector<HTMLButtonElement>('button')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.textContent).toContain('Retrying…');
    button.click();
    expect(retry).not.toHaveBeenCalled();
  });
});
