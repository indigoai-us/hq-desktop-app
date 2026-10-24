// @vitest-environment happy-dom
//
// hq-message-visibility US-006: the quick-window DM pane is narrower than the
// Activity column needs, so it offers the header lens ("People ▾": People /
// Agents / System / All) per conversation for the session, matching the
// desktop shell's narrow fallback. No third column is drawn.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});
const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}), emit: vi.fn() }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import { activitySession, messageTypesStore } from '@hq/ui';
import DmThreadPane from './DmThreadPane.svelte';

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

const row = (id: string, minute: number, audience: string) => ({
  eventId: id,
  fromPersonUid: audience === 'agent' ? 'agt_scout' : 'prs_ada',
  fromEmail: 'ada@example.com',
  fromDisplayName: audience === 'agent' ? 'Scout' : 'Ada',
  body: `body-${id}`,
  createdAt: `2026-10-23T10:${String(minute).padStart(2, '0')}:00Z`,
  direction: 'in',
  audience,
});

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  activitySession.reset();
  messageTypesStore.set({ agents: false, system: false }, null);
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'whoami') return { personUid: 'prs_self' };
    if (command === 'fetch_reactions') return [];
    if (command === 'fetch_dm_thread')
      return { messages: [row('h1', 1, 'human'), row('a1', 2, 'agent'), row('a2', 3, 'agent')] };
    if (command === 'list_syncable_workspaces') return { workspaces: [] };
    return null;
  });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  tauri.invoke.mockReset();
  activitySession.reset();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('DmThreadPane Activity lens', () => {
  it('shows the People lens instead of a column, and Agents reveals the agent rows for this conversation only', async () => {
    component = mount(DmThreadPane, {
      target: host,
      props: {
        event: {
          eventId: 'evt_dm',
          fromPersonUid: 'prs_ada',
          fromEmail: 'ada@example.com',
          fromDisplayName: 'Ada',
          body: 'hello',
          createdAt: '2026-10-23T10:00:00Z',
        },
      },
    });
    await settle();

    expect(q('activity-toggle')).toBeNull();
    expect(q('activity-column')).toBeNull();
    expect(q('activity-lens')?.textContent).toContain('People ▾');
    expect(host.querySelectorAll('[data-testid="message-fold"]').length).toBe(1);
    expect(host.textContent).not.toContain('body-a1');

    q('activity-lens')!.click();
    await settle();
    q('activity-lens-agents')!.click();
    await settle();

    expect(q('activity-lens')?.textContent).toContain('Agents ▾');
    expect(host.querySelectorAll('[data-testid="message-fold"]').length).toBe(0);
    expect(host.textContent).toContain('body-a1');
    expect(host.textContent).toContain('body-a2');
    expect(activitySession.get('dm:prs_ada').lens).toBe('agents');
    expect(activitySession.get('dm:prs_bob').lens).toBeNull();
    expect(messageTypesStore.value).toEqual({ agents: false, system: false });
  });
});
