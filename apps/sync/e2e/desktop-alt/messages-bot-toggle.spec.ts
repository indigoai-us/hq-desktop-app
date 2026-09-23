// @vitest-environment happy-dom
//
// US-006 — "Show bot messages" toggle in the Messages header.
//
// Locks:
//   1. The localStorage storage key constant.
//   2. The audience filter function (pure unit).
//   3. MessagesShell.svelte toggle markup: button, aria-label, aria-pressed,
//      data-storage-key, and segment buttons present.
//   4. Toggle persists to localStorage and flips aria-pressed.
//   5. Filtering hides agent-audience messages when toggle is off.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

// ── 1. Storage key contract ──────────────────────────────────────────────────
describe('SHOW_BOT_MESSAGES_KEY', () => {
  it('is the expected localStorage key', async () => {
    const { SHOW_BOT_MESSAGES_KEY } = await import(
      '../../src/lib/botMessageFilter'
    );
    expect(SHOW_BOT_MESSAGES_KEY).toBe('hq:messages:show-bot-messages');
  });
});

// ── 2. Filter function ───────────────────────────────────────────────────────
describe('filterByAudience', () => {
  type Item = { audience?: string | null };

  beforeEach(async () => {
    const mod = await import('../../src/lib/botMessageFilter');
    // reset module state isn't needed — these are pure functions
    return mod;
  });

  it('passes all items when showBotMessages=true', async () => {
    const { filterByAudience } = await import('../../src/lib/botMessageFilter');
    const items: Item[] = [
      { audience: 'human' },
      { audience: 'agent' },
      { audience: 'both' },
      {},
    ];
    expect(filterByAudience(items, true)).toHaveLength(4);
  });

  it('hides agent-audience items when showBotMessages=false', async () => {
    const { filterByAudience } = await import('../../src/lib/botMessageFilter');
    const items: Item[] = [
      { audience: 'human' },
      { audience: 'agent' },
      { audience: 'both' },
      { audience: null },
      {},
    ];
    const visible = filterByAudience(items, false);
    expect(visible).toHaveLength(4); // human, both, null, absent all show
    expect(visible.every((m) => m.audience !== 'agent')).toBe(true);
  });

  it('treats absent audience as human (default)', async () => {
    const { filterByAudience } = await import('../../src/lib/botMessageFilter');
    const items: Item[] = [{}, { audience: null }, { audience: undefined }];
    expect(filterByAudience(items, false)).toHaveLength(3);
  });

  it('countHiddenByAudience returns 0 when toggle is on', async () => {
    const { countHiddenByAudience } = await import('../../src/lib/botMessageFilter');
    const items: Item[] = [{ audience: 'agent' }, { audience: 'agent' }];
    expect(countHiddenByAudience(items, true)).toBe(0);
  });

  it('countHiddenByAudience counts only agent items when toggle is off', async () => {
    const { countHiddenByAudience } = await import('../../src/lib/botMessageFilter');
    const items: Item[] = [
      { audience: 'human' },
      { audience: 'agent' },
      { audience: 'agent' },
      { audience: 'both' },
    ];
    expect(countHiddenByAudience(items, false)).toBe(2);
  });
});

// ── 3 & 4. MessagesShell component: markup + toggle behavior ─────────────────
describe('MessagesShell: toggle markup and behavior', () => {
  let host: HTMLElement;
  let component: Record<string, unknown> | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    localStorage.clear();
  });

  afterEach(async () => {
    if (component) {
      await unmount(component);
      component = null;
    }
    host?.remove();
    localStorage.clear();
  });

  it('renders segment buttons (All, People, Requests)', async () => {
    const MessagesShell = (await import('../../src/components/messaging/MessagesShell.svelte'))
      .default;
    component = mount(MessagesShell, { target: host, props: {} });
    flushSync();

    expect(host.querySelector('[data-testid="segment-all"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="segment-people"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="segment-requests"]')).not.toBeNull();
  });

  it('renders the bot toggle button with correct aria attributes when off', async () => {
    const MessagesShell = (await import('../../src/components/messaging/MessagesShell.svelte'))
      .default;
    component = mount(MessagesShell, {
      target: host,
      props: { showBotMessages: false },
    });
    flushSync();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="bot-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    expect(toggle?.getAttribute('aria-label')).toBe('Show bot messages');
    expect(toggle?.getAttribute('data-storage-key')).toBe('hq:messages:show-bot-messages');
  });

  it('renders the bot toggle with aria-label "Hide bot messages" when on', async () => {
    const MessagesShell = (await import('../../src/components/messaging/MessagesShell.svelte'))
      .default;
    component = mount(MessagesShell, {
      target: host,
      props: { showBotMessages: true },
    });
    flushSync();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="bot-toggle"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle?.getAttribute('aria-label')).toBe('Hide bot messages');
  });

  it('toggle button is separate from segment nav (not a segment)', async () => {
    const MessagesShell = (await import('../../src/components/messaging/MessagesShell.svelte'))
      .default;
    component = mount(MessagesShell, { target: host, props: {} });
    flushSync();

    const nav = host.querySelector('[data-testid="messages-segments"]');
    const toggle = host.querySelector('[data-testid="bot-toggle"]');
    // Toggle must NOT be inside the segments nav
    expect(nav?.contains(toggle)).toBe(false);
  });

  it('clicking the toggle persists to localStorage and flips aria-pressed', async () => {
    const MessagesShell = (await import('../../src/components/messaging/MessagesShell.svelte'))
      .default;
    component = mount(MessagesShell, {
      target: host,
      props: { showBotMessages: false },
    });
    flushSync();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="bot-toggle"]')!;
    expect(localStorage.getItem('hq:messages:show-bot-messages')).toBeNull();

    toggle.click();
    flushSync();

    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('hq:messages:show-bot-messages')).toBe('true');

    toggle.click();
    flushSync();

    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(localStorage.getItem('hq:messages:show-bot-messages')).toBeNull();
  });
});
