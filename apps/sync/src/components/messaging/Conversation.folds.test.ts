// @vitest-environment happy-dom
//
// hq-message-visibility US-005: the apps/sync DM thread collapses runs of
// agent-audience messages into fold lines (shared @hq/ui MessageFold).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import Conversation, { type ConversationMessage } from './Conversation.svelte';

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
  host.remove();
});

const msg = (id: string, body: string, audience: string, minute: number): ConversationMessage => ({
  eventId: id,
  fromPersonUid: audience === 'agent' ? 'agt_scout' : 'prs_ada',
  fromDisplayName: audience === 'agent' ? 'Scout' : 'Ada',
  body,
  createdAt: `2026-10-23T10:${String(minute).padStart(2, '0')}:00Z`,
  direction: 'in',
  audience,
});

const thread = [
  msg('h1', 'hello there', 'human', 0),
  msg('a1', 'agent one', 'agent', 1),
  msg('a2', 'agent two', 'agent', 2),
  msg('h2', 'second human', 'human', 3),
  msg('a3', 'trailing agent', 'agent', 4),
];

const text = () => host.textContent ?? '';
const folds = () => [...host.querySelectorAll<HTMLElement>('[data-testid="message-fold"]')];

describe('apps/sync Conversation folds', () => {
  it('folds agent runs in place, including the trailing run, and toggles open', () => {
    component = mount(Conversation, {
      target: host,
      props: { messages: thread, messageTypes: { agents: false, system: false }, onsend: () => {} },
    });
    flushSync();
    expect(text()).toContain('second human');
    expect(text()).not.toContain('agent one');
    expect(text()).not.toContain('trailing agent');
    expect(folds().map((f) => f.querySelector('[data-testid="message-fold-label"]')?.textContent?.trim())).toEqual([
      '2 agent updates',
      '1 agent update',
    ]);

    const pill = folds()[0].querySelector<HTMLButtonElement>('[data-testid="message-fold-toggle"]')!;
    pill.click();
    flushSync();
    expect(pill.getAttribute('aria-expanded')).toBe('true');
    expect(pill.textContent).toContain('hide 2 agent updates');
    expect(text()).toContain('agent one');
    expect(text()).toContain('agent two');

    pill.click();
    flushSync();
    expect(text()).not.toContain('agent one');
  });

  it('renders every message as a row without a type preference', () => {
    component = mount(Conversation, {
      target: host,
      props: { messages: thread, onsend: () => {} },
    });
    flushSync();
    expect(folds()).toHaveLength(0);
    expect(text()).toContain('trailing agent');
  });
});
