// @vitest-environment happy-dom
//
// US-006 / US-008 — NotificationRow message hover-expand (mounted behavioral).
//
// Real component mount: boots NotificationRow.svelte under happy-dom and
// asserts the JS-driven expanded state (hovered || focusWithin) for message
// rows — collapsed one-line → mouseenter expands with .nr-reply + .nr-react →
// mouseleave collapses. Complements inbox-merge.spec.ts source contracts.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import NotificationRow from '../../src/components/NotificationRow.svelte';

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
});

describe('US-006 / US-008: NotificationRow message hover-expand (mounted)', () => {
  it('expands on mouseenter (quick-reply + react) and collapses on mouseleave', () => {
    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Corey',
        text: 'ship it when ready',
        ts: Date.parse('2026-06-15T18:00:00.000Z'),
        unread: true,
      },
    });
    flushSync();

    const row = host.querySelector('[data-testid="notification-row"]') as HTMLElement | null;
    expect(row).not.toBeNull();
    expect(row?.getAttribute('data-type')).toBe('message');

    // Collapsed: one-line layout — no expanded foot controls.
    expect(row?.getAttribute('data-expanded')).toBe('false');
    expect(host.querySelector('.nr-reply')).toBeNull();
    expect(host.querySelectorAll('.nr-react')).toHaveLength(0);

    // NotificationRow sets hovered via onmouseenter / onmouseleave (JS state,
    // not CSS-only). expanded = isMessage && (hovered || focusWithin).
    row!.dispatchEvent(new Event('mouseenter'));
    flushSync();

    expect(row?.getAttribute('data-expanded')).toBe('true');
    expect(host.querySelector('.nr-reply')).not.toBeNull();
    expect(host.querySelectorAll('.nr-react').length).toBeGreaterThan(0);

    row!.dispatchEvent(new Event('mouseleave'));
    flushSync();

    expect(row?.getAttribute('data-expanded')).toBe('false');
    expect(host.querySelector('.nr-reply')).toBeNull();
    expect(host.querySelectorAll('.nr-react')).toHaveLength(0);
  });

  it('preserves a failed quick-reply draft and retries it explicitly', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const firstSend = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    let resolveRetry!: () => void;
    const retrySend = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const onreply = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(firstSend)
      .mockReturnValueOnce(retrySend);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    component = mount(NotificationRow, {
      target: host,
      props: {
        type: 'message',
        actor: 'Corey',
        text: 'ship it when ready',
        ts: Date.parse('2026-06-15T18:00:00.000Z'),
        onreply,
      },
    });
    flushSync();

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    row.dispatchEvent(new Event('mouseenter'));
    flushSync();
    const input = host.querySelector<HTMLInputElement>('.nr-reply')!;
    input.value = 'Keep this draft';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();

    expect(onreply).toHaveBeenCalledWith('Keep this draft');
    expect(input.disabled).toBe(true);
    expect(host.querySelector('[data-testid="notification-reply-pending"]')).toBeTruthy();

    rejectFirst(new Error('offline'));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="notification-reply-error"]')).toBeTruthy();
    });
    expect(input.value).toBe('Keep this draft');
    expect(input.disabled).toBe(false);
    expect(input.getAttribute('aria-invalid')).toBe('true');

    host
      .querySelector<HTMLButtonElement>('[data-testid="notification-reply-retry"]')!
      .click();
    flushSync();
    const retry = host.querySelector<HTMLButtonElement>(
      '[data-testid="notification-reply-retry"]',
    )!;
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.textContent?.trim()).toBe('Sending…');
    expect(host.querySelector('[data-testid="notification-reply-error"]')?.textContent).toContain(
      'Retrying…',
    );
    resolveRetry();
    await vi.waitFor(() => {
      flushSync();
      expect(onreply).toHaveBeenCalledTimes(2);
      expect(input.value).toBe('');
      expect(host.querySelector('[data-testid="notification-reply-error"]')).toBeNull();
    });

    consoleError.mockRestore();
  });
});
