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
});
