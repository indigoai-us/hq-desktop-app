// @vitest-environment happy-dom
//
// US-001: One-line minimal notification row component
// Real component mounts of NotificationRow (no Tauri deps) + source-contract
// on the chrome-free Popover panel and NotificationFeed adoption.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as onboarding-setup.test.ts).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import NotificationRow from '../../src/components/NotificationRow.svelte';

const popoverSource = readFileSync(
  resolve(process.cwd(), 'src/components/Popover.svelte'),
  'utf8',
);
const feedSource = readFileSync(
  resolve(process.cwd(), 'src/components/NotificationFeed.svelte'),
  'utf8',
);
const rowSource = readFileSync(
  resolve(process.cwd(), 'src/components/NotificationRow.svelte'),
  'utf8',
);

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function mountRow(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(NotificationRow, { target: host, props });
  flushSync();
  return host;
}

/** Set an input's bound value the way Svelte 5's bind:value listens for. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  proto?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
});

describe('US-001: One-line minimal notification row component', () => {
  it('Given a pending notification, when the panel opens, then it renders as a single line with a type icon and right-aligned relative timestamp.', () => {
    const ts = Date.now() - 3600_000; // ~1h ago → "1h"
    mountRow({
      type: 'share',
      actor: 'Yousuf',
      text: 'shared q2-metrics.xlsx',
      ts,
    });

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]');
    expect(row).toBeTruthy();
    expect(row?.getAttribute('data-type')).toBe('share');
    expect(row?.getAttribute('data-expanded')).toBe('false');

    // Type icon (svg) present
    const icon = row?.querySelector('.nr-icon svg');
    expect(icon).toBeTruthy();

    // Actor + body text on the single collapsed line
    const textEl = row?.querySelector('.nr-text');
    expect(textEl?.textContent).toContain('Yousuf');
    expect(textEl?.textContent).toContain('shared q2-metrics.xlsx');

    // Right-aligned relative timestamp
    const tsEl = row?.querySelector('.nr-ts');
    expect(tsEl).toBeTruthy();
    expect(tsEl?.textContent?.trim()).toBe('1h');
    // Trail holds the ts on the right of the flex row
    expect(row?.querySelector('.nr-trail .nr-ts')).toBeTruthy();

    // Collapsed: one-line layout — no expanded body / reply input
    expect(row?.querySelector('.nr-body')).toBeNull();
    expect(row?.querySelector('input.nr-reply')).toBeNull();
    expect(row?.querySelector('.nr-foot')).toBeNull();
  });

  it('Given a non-message row, when hovered, then open and dismiss actions appear.', () => {
    const onopen = vi.fn();
    const ondismiss = vi.fn();
    mountRow({
      type: 'share',
      actor: 'Yousuf',
      text: 'shared q2-metrics.xlsx',
      ts: Date.now() - 3600_000,
      onopen,
      ondismiss,
    });

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    expect(row).toBeTruthy();

    // Actions are always in the DOM for non-message rows with handlers, and
    // revealed via CSS on hover/focus-within (not conditional rendering).
    const openBtn = row.querySelector<HTMLButtonElement>('button.nr-open');
    const dismissBtn = row.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    expect(openBtn).toBeTruthy();
    expect(openBtn?.textContent?.trim()).toBe('Open');
    expect(dismissBtn).toBeTruthy();

    // CSS contract: default hidden, hover/focus reveals
    expect(rowSource).toMatch(/\.nr-actions\s*\{[^}]*display:\s*none/s);
    expect(rowSource).toMatch(
      /\.nr:not\(\.nr-message\):hover \.nr-actions[\s\S]*?display:\s*inline-flex/,
    );
    expect(rowSource).toMatch(
      /\.nr:not\(\.nr-message\):focus-within \.nr-actions[\s\S]*?display:\s*inline-flex/,
    );

    // Hover still sets the hover state on the interaction surface.
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();

    openBtn!.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    dismissBtn!.click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });

  it('Given a message row, when hovered, then it expands to full text with quick-reply and react controls, and collapses on mouse-out.', () => {
    const longText =
      'Hey — can you take a look at the Q2 metrics share when you get a chance? The numbers look off in the funnel tab.';
    const onreply = vi.fn();
    const onreact = vi.fn();
    mountRow({
      type: 'message',
      actor: 'Corey',
      text: longText,
      ts: Date.now() - 120_000,
      onreply,
      onreact,
    });

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    expect(row.getAttribute('data-type')).toBe('message');
    expect(row.getAttribute('data-expanded')).toBe('false');
    // Collapsed: full body not shown
    expect(row.querySelector('.nr-body')).toBeNull();
    expect(row.querySelector('input.nr-reply')).toBeNull();

    // Expand on hover
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();

    expect(row.getAttribute('data-expanded')).toBe('true');
    const body = row.querySelector('.nr-body');
    expect(body).toBeTruthy();
    expect(body?.textContent).toBe(longText);

    const replyInput = row.querySelector<HTMLInputElement>('input.nr-reply');
    expect(replyInput).toBeTruthy();
    expect(replyInput?.placeholder).toBe('Reply…');

    const reactButtons = row.querySelectorAll<HTMLButtonElement>('button.nr-react');
    expect(reactButtons.length).toBe(3);
    expect([...reactButtons].map((b) => b.textContent)).toEqual(['👍', '❤️', '👀']);

    // Type a reply and submit with Enter
    setInputValue(replyInput!, 'On it');
    replyInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onreply).toHaveBeenCalledWith('On it');

    // Emoji react
    reactButtons[0].click();
    flushSync();
    expect(onreact).toHaveBeenCalledWith('👍');

    // Collapse on mouse-out
    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    flushSync();
    expect(row.getAttribute('data-expanded')).toBe('false');
    expect(row.querySelector('.nr-body')).toBeNull();
    expect(row.querySelector('input.nr-reply')).toBeNull();
  });

  it('Given the notification panel, when rendered, then no tab selector, sync button, overflow menu, hq icon, or desktop-view button is present.', () => {
    // Chrome-free panel contract (source, same style as e2e harness / US-004)
    expect(popoverSource).not.toContain('role="tablist"');
    expect(popoverSource).not.toContain('mbp-tabs');
    expect(popoverSource).not.toContain('data-testid="popover-sync-button"');
    expect(popoverSource).not.toContain('data-testid="popover-overflow-button"');
    expect(popoverSource).not.toContain('data-testid="popover-settings-gear"');
    // HQ wordmark path fragment (old header icon)
    expect(popoverSource).not.toContain('M85.7251 3.66162');
    expect(popoverSource).not.toContain('data-testid="desktop-alt-toggle"');

    // Still hosts the notifications feed
    expect(popoverSource).toContain('<NotificationFeed');
    expect(popoverSource).toMatch(
      /import NotificationFeed from ['"]\.\/NotificationFeed\.svelte['"]/,
    );

    // Feed renders rows through the shared one-line NotificationRow
    expect(feedSource).toContain("import NotificationRow from './NotificationRow.svelte'");
    expect(feedSource).toContain('<NotificationRow');
  });
});
