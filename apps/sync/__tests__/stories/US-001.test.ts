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

function styleRule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

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
    expect(row?.querySelector('.nr-actor-pill')).toBeNull();
    expect(row?.querySelector('.nr-comfortable-copy')).toBeNull();
    expect(row?.querySelector('.nr-identity')).toBeNull();
    expect(row?.querySelector('.nr-actor')?.textContent).toBe('Yousuf');
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

    // Keep the controls in the keyboard tab order while visually quiet —
    // hidden via opacity as an absolute overlay (round-2: reveal must not
    // resize the row or shift the trailing timestamp).
    expect(rowSource).toMatch(/\.nr-hoverbar\s*\{[^}]*display:\s*inline-flex/s);
    expect(rowSource).toMatch(/\.nr-hoverbar\s*\{[^}]*opacity:\s*0/s);
    expect(rowSource).toMatch(/\.nr-hoverbar\s*\{[^}]*position:\s*absolute/s);
    expect(rowSource).toMatch(
      /\.nr:not\(\.nr-message\):hover \.nr-actions[\s\S]*?opacity:\s*1/,
    );
    expect(rowSource).toMatch(
      /\.nr:not\(\.nr-message\):focus-within \.nr-actions[\s\S]*?pointer-events:\s*auto/,
    );

    // Hover still sets the hover state on the interaction surface.
    row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    flushSync();

    // The row's content remains the primary pointer target; the small hover
    // action is an alternate affordance, not the only way to open the item.
    row.querySelector<HTMLElement>('.nr-text')!.click();
    expect(onopen).toHaveBeenCalledTimes(1);

    openBtn!.click();
    expect(onopen).toHaveBeenCalledTimes(2);

    dismissBtn!.click();
    expect(ondismiss).toHaveBeenCalledTimes(1);
  });

  it('Given a message row, when hovered, then quick-reply and react controls overlay the fixed one-line row, and hide on mouse-out.', () => {
    const longText =
      'Hey — can you take a look at the Q2 metrics share when you get a chance? The numbers look off in the funnel tab.';
    const onopen = vi.fn();
    const onreply = vi.fn();
    const onreact = vi.fn();
    mountRow({
      type: 'message',
      actor: 'Corey',
      text: longText,
      ts: Date.now() - 120_000,
      onopen,
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
    // Round-2 lock: hover must NOT resize the row or reflow the list — the
    // one-line layout persists (no expanded body block) and the reply/react
    // controls arrive as overlays out of normal flow.
    expect(row.querySelector('.nr-body')).toBeNull();
    const oneLine = row.querySelector<HTMLElement>('.nr-text');
    expect(oneLine?.textContent).toContain(longText);
    const hoverbar = row.querySelector<HTMLElement>(
      '[data-testid="notification-hoverbar"]',
    );
    expect(hoverbar).toBeTruthy();
    const replyOverlay = row.querySelector<HTMLElement>('.nr-foot');
    expect(replyOverlay).toBeTruthy();

    // The text stays inside the native primary button, while reply/react
    // controls remain siblings. This preserves full-row pointer activation
    // without nesting interactive controls.
    const primaryAction = row.querySelector<HTMLButtonElement>(
      'button.nr-primary-action',
    );
    expect(primaryAction).toBeTruthy();
    expect(primaryAction?.tabIndex).toBe(0);
    oneLine!.click();
    flushSync();
    expect(onopen).toHaveBeenCalledTimes(1);

    // Native button semantics provide keyboard focus + Enter/Space activation.
    primaryAction!.focus();
    expect(document.activeElement).toBe(primaryAction);
    primaryAction!.click();
    expect(onopen).toHaveBeenCalledTimes(2);

    const replyInput = row.querySelector<HTMLInputElement>('input.nr-reply');
    expect(replyInput).toBeTruthy();
    expect(replyInput?.placeholder).toBe('Reply…');

    const reactButtons = row.querySelectorAll<HTMLButtonElement>('button.nr-react');
    expect(reactButtons.length).toBe(3);
    expect([...reactButtons].map((b) => b.textContent)).toEqual(['👍', '❤️', '👀']);

    // Reply input and react buttons must not fire onopen
    const openBeforeControls = onopen.mock.calls.length;
    replyInput!.click();
    flushSync();
    reactButtons[0].click();
    flushSync();
    expect(onopen).toHaveBeenCalledTimes(openBeforeControls);
    expect(onreact).toHaveBeenCalledWith('👍');

    // Type a reply and submit with Enter
    setInputValue(replyInput!, 'On it');
    replyInput!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onreply).toHaveBeenCalledWith('On it');

    // Keyboard focus keeps the row expanded across mouse-out.
    row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
    flushSync();
    expect(row.getAttribute('data-expanded')).toBe('true');

    // Releasing focus collapses once there is no hover or reply hold.
    primaryAction!.blur();
    flushSync();
    expect(row.getAttribute('data-expanded')).toBe('false');
    expect(row.querySelector('[data-testid="notification-hoverbar"]')).toBeNull();
    expect(row.querySelector('input.nr-reply')).toBeNull();
  });

  it('Given a selected conversation row, then selection stays open with a neutral baseline and no side rail.', () => {
    mountRow({
      type: 'message',
      actor: 'Corey',
      text: 'Selected conversation',
      ts: Date.now(),
      selected: true,
      onopen: vi.fn(),
    });

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    expect(row.classList.contains('nr-selected')).toBe(true);

    const selectedRule =
      rowSource.match(/\.nr-selected\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(selectedRule).toContain('background: transparent');
    expect(selectedRule).toContain(
      'box-shadow: inset 0 -1px 0 var(--popover-divider)',
    );
    expect(selectedRule).not.toMatch(/border-(?:left|right)/);
    expect(rowSource).not.toMatch(/\.nr-selected::(?:before|after)/);
  });

  it('keeps notification and pinned system-notice rows square because they are structural rows, not cards.', () => {
    expect(styleRule(rowSource, '.nr')).toContain('border-radius: 0');
    expect(styleRule(popoverSource, '.snr')).toContain('border-radius: 0');
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

    // Dismissed rows must not keep the unread badge stale: count from visibleItems
    expect(feedSource).toMatch(/countUnread\s*\(\s*visibleItems\b/);
    expect(feedSource).not.toMatch(/countUnread\s*\(\s*items\b/);
  });
});

describe('Round-2 polish — calm typography and no-reflow hover (source contract)', () => {
  const rowSource = readFileSync(
    resolve(__dirname, '../../src/components/NotificationRow.svelte'),
    'utf-8',
  );
  const rowStyle = rowSource.slice(rowSource.indexOf('<style>'));

  it('uses at most two font weights: regular everywhere, semibold only for the actor', () => {
    const weights = [...rowStyle.matchAll(/font-weight:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(weights.length).toBeGreaterThan(0);
    for (const w of weights) {
      expect([400, 600]).toContain(w);
    }
    // Semibold is reserved for the actor (and the inline Retry affordance) —
    // body text, meta labels, counts, and action pills are regular.
    for (const cls of ['.nr-text {', '.nr-meta-type {', '.nr-count {']) {
      const idx = rowStyle.indexOf(cls);
      expect(idx).toBeGreaterThan(-1);
      const block = rowStyle.slice(idx, rowStyle.indexOf('}', idx));
      expect(block).not.toMatch(/font-weight:\s*(?!400)\d+/);
    }
  });

  it('mutes the company/ambient actor prefix instead of bolding it', () => {
    expect(rowStyle).toMatch(
      /\.nr:not\(\[data-type='message'\]\):not\(\[data-type='mention'\]\) \.nr-actor \{[^}]*font-weight:\s*400[^}]*var\(--popover-text-muted\)/,
    );
  });

  it('keeps rows at a fixed breathing-room height with overlay-only hover actions', () => {
    const nrIdx = rowStyle.indexOf('.nr {');
    const nrBlock = rowStyle.slice(nrIdx, rowStyle.indexOf('}', nrIdx));
    expect(nrBlock).toContain('min-height: 32px');
    expect(nrBlock).toContain('position: relative');
    // Hover toolbar and quick-reply are absolutely positioned overlays.
    expect(rowStyle).toMatch(/\.nr-hoverbar \{[\s\S]*?position: absolute/);
    expect(rowStyle).toMatch(/\.nr-foot \{[\s\S]*?position: absolute/);
    // The expanded-message rule must not change row geometry.
    const expIdx = rowStyle.indexOf('.nr-message.nr-expanded {');
    const expBlock = rowStyle.slice(expIdx, rowStyle.indexOf('}', expIdx));
    for (const prop of ['padding', 'min-height', 'flex-direction']) {
      expect(expBlock).not.toContain(prop);
    }
  });
});

describe('Actionable rows — resolving "needs attention" items in place', () => {
  it('renders a resolution trigger and picker, calls the assignment, and reports busy + error states', async () => {
    const onresolveopen = vi.fn();
    let settle: ((value: void) => void) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    const onresolve = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<void>((_, r) => { reject = r; }),
      )
      .mockImplementationOnce(
        () => new Promise<void>((res) => { settle = res; }),
      );

    mountRow({
      type: 'system',
      text: 'Meeting needs a company — "Amir Tor…" isn’t filed yet.',
      ts: Date.now() - 60_000,
      resolvePrompt: 'File to company',
      resolveOptions: [
        { value: 'cmp_indigo', label: 'Indigo' },
        { value: 'cmp_alive', label: 'Alive' },
      ],
      onresolveopen,
      onresolve,
    });

    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    // The needs-action marker and trigger occupy reserved space in the row —
    // not hover-revealed — so nothing shifts (round-2 no-reflow rule).
    expect(row.querySelector('[data-testid="notification-needs-action"]')).toBeTruthy();
    const trigger = row.querySelector<HTMLButtonElement>(
      '[data-testid="notification-resolve-trigger"]',
    )!;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent?.trim()).toBe('File to company');
    expect(row.querySelector('[data-testid="notification-resolve-sheet"]')).toBeNull();

    trigger.click();
    flushSync();
    await Promise.resolve();
    flushSync();
    expect(onresolveopen).toHaveBeenCalledTimes(1);

    const options = [
      ...row.querySelectorAll<HTMLButtonElement>('[data-testid="notification-resolve-option"]'),
    ];
    expect(options.map((o) => o.dataset.value)).toEqual(['cmp_indigo', 'cmp_alive']);
    // Nothing chosen yet — nothing filed.
    expect(onresolve).not.toHaveBeenCalled();

    // Failure keeps the sheet open with an inline error.
    options[0].click();
    flushSync();
    expect(onresolve).toHaveBeenCalledWith('cmp_indigo');
    expect(options[0].getAttribute('aria-busy')).toBe('true');
    reject!(new Error('nope'));
    for (let i = 0; i < 4; i++) await Promise.resolve();
    flushSync();
    expect(
      row.querySelector('[data-testid="notification-resolve-error"]')?.textContent,
    ).toContain('Couldn’t save');
    expect(row.querySelector('[data-testid="notification-resolve-sheet"]')).toBeTruthy();

    // Success closes the picker — the host dismisses the resolved row.
    const retry = row.querySelector<HTMLButtonElement>(
      '[data-testid="notification-resolve-option"][data-value="cmp_indigo"]',
    )!;
    expect(retry.disabled).toBe(false);
    retry.click();
    flushSync();
    expect(onresolve).toHaveBeenCalledTimes(2);
    settle!();
    for (let i = 0; i < 4; i++) await Promise.resolve();
    flushSync();
    expect(onresolve).toHaveBeenCalledTimes(2);
    expect(row.querySelector('[data-testid="notification-resolve-sheet"]')).toBeNull();
  });

  it('stays a plain row when no resolution is declared', () => {
    mountRow({ type: 'system', text: 'Nothing to do here', ts: Date.now() });
    const row = host.querySelector<HTMLElement>('[data-testid="notification-row"]')!;
    expect(row.querySelector('[data-testid="notification-resolve-trigger"]')).toBeNull();
    expect(row.querySelector('[data-testid="notification-needs-action"]')).toBeNull();
  });

  it('keeps the picker out of normal flow so opening it cannot reflow the list', () => {
    const style = rowSource.slice(rowSource.indexOf('<style>'));
    const idx = style.indexOf('.nr-resolve-sheet {');
    expect(idx).toBeGreaterThan(-1);
    const block = style.slice(idx, style.indexOf('}', idx));
    expect(block).toContain('position: absolute');
    // Trigger itself is in flow but fixed-size — it never changes row height.
    const trigIdx = style.indexOf('.nr-resolve {');
    const trigBlock = style.slice(trigIdx, style.indexOf('}', trigIdx));
    expect(trigBlock).toContain('height: 20px');
    expect(trigBlock).toContain('font-weight: 400');
  });
});
