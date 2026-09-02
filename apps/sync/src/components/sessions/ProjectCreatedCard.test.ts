// @vitest-environment happy-dom
/**
 * The project-created card, mounted for real against a mocked backend.
 *
 * Pinned: a notice for THIS session shows the offer; the confirm click is the
 * one and only `session_share_to_channel` call, with the exact outward-safe
 * payload (new channel from the project path, no transcript, no invites);
 * success reports the channel, raises the linked event the shell refreshes
 * on, and hands the id to "Open channel". A project that already has a
 * channel is linked without any creation. Other sessions' notices are
 * ignored, and dismiss hides the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => {
      listeners.delete(name);
    });
  }),
}));

import { flushSync, mount, unmount } from 'svelte';
import ProjectCreatedCard from './ProjectCreatedCard.svelte';
import {
  PROJECT_CHANNEL_LINKED_EVENT,
  PROJECT_CREATED_EVENT,
} from '../../desktop-alt/lib/session-project-links';

const NOTICE = {
  sessionId: 's1',
  company: 'indigo',
  project: 'draft',
  projectPath: '/hq/companies/indigo/projects/draft',
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
const opened: string[] = [];

function mountCard(sessionId: string | null = 's1') {
  component = mount(ProjectCreatedCard, {
    target: host,
    props: { sessionId, onopenchannel: (id: string) => opened.push(id) },
  });
  flushSync();
}

async function fire(payload: unknown): Promise<void> {
  // The listener is attached from onMount after a microtask.
  await vi.waitFor(() => {
    if (!listeners.get(PROJECT_CREATED_EVENT)) throw new Error('not listening yet');
  });
  listeners.get(PROJECT_CREATED_EVENT)?.({ payload });
  flushSync();
}

function card(): HTMLElement | null {
  return host.querySelector<HTMLElement>('[data-testid="session-project-created"]');
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  invoke.mockReset();
  listeners.clear();
  opened.length = 0;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('ProjectCreatedCard', () => {
  it('offers a channel for THIS session and creates it only on confirm, with the exact payload', async () => {
    const linked: unknown[] = [];
    const onLinked = (event: Event) => linked.push((event as CustomEvent).detail);
    window.addEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);

    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'session_project_links') {
        return [{ project: 'draft', projectName: 'Draft', projectPath: NOTICE.projectPath, sessions: [] }];
      }
      if (cmd === 'session_share_to_channel') {
        return { channelId: 'chn_new', channelName: 'p-draft', created: true, invited: [], digestChars: 0 };
      }
      throw new Error(`unexpected ${cmd}`);
    });

    mountCard();
    expect(card()).toBeNull();

    await fire(NOTICE);
    expect(card()?.getAttribute('data-state')).toBe('offer');
    expect(card()?.textContent).toContain('Project draft was created');
    // The pre-check is read-only; nothing outward has happened.
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('session_project_links', { company: 'indigo' }));
    expect(invoke).not.toHaveBeenCalledWith('session_share_to_channel', expect.anything());
    expect(card()?.getAttribute('data-state')).toBe('offer');

    host.querySelector<HTMLButtonElement>('[data-testid="session-project-create-channel"]')?.click();
    flushSync();
    await vi.waitFor(() => expect(card()?.getAttribute('data-state')).toBe('linked'));

    const shareCalls = invoke.mock.calls.filter(([cmd]) => cmd === 'session_share_to_channel');
    expect(shareCalls).toHaveLength(1);
    expect(shareCalls[0]?.[1]).toEqual({
      sessionId: 's1',
      company: 'indigo',
      target: { kind: 'new', name: '', projectPath: NOTICE.projectPath },
      inviteUids: [],
      includeTranscript: false,
    });

    expect(card()?.querySelector('[data-testid="session-project-channel"]')?.textContent).toBe('#p-draft');
    expect(card()?.textContent).toContain('has its channel');
    expect(linked).toEqual([
      { company: 'indigo', project: 'draft', channelId: 'chn_new', channelName: 'p-draft' },
    ]);

    host.querySelector<HTMLButtonElement>('[data-testid="session-project-open-channel"]')?.click();
    expect(opened).toEqual(['chn_new']);
    window.removeEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);
  });

  it('just links when the project already has a channel — nothing is created', async () => {
    const linked: unknown[] = [];
    const onLinked = (event: Event) => linked.push((event as CustomEvent).detail);
    window.addEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'session_project_links') {
        return [
          {
            project: 'draft',
            projectName: 'Draft',
            projectPath: NOTICE.projectPath,
            channelId: 'chn_existing',
            channelName: 'p-draft',
            sessions: [],
          },
        ];
      }
      throw new Error(`unexpected ${cmd}`);
    });

    mountCard();
    await fire(NOTICE);
    await vi.waitFor(() => expect(card()?.getAttribute('data-state')).toBe('linked'));
    expect(card()?.textContent).toContain('is linked');
    expect(card()?.textContent).toContain('#p-draft');
    expect(invoke.mock.calls.some(([cmd]) => cmd === 'session_share_to_channel')).toBe(false);
    expect(linked).toEqual([
      { company: 'indigo', project: 'draft', channelId: 'chn_existing', channelName: 'p-draft' },
    ]);
    window.removeEventListener(PROJECT_CHANNEL_LINKED_EVENT, onLinked);
  });

  it('reports a failed creation inline and lets the operator try again', async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'session_project_links') return [];
      if (cmd === 'session_share_to_channel') throw new Error('hq-pro is away');
      throw new Error(`unexpected ${cmd}`);
    });
    mountCard();
    await fire(NOTICE);
    host.querySelector<HTMLButtonElement>('[data-testid="session-project-create-channel"]')?.click();
    await vi.waitFor(() => expect(card()?.getAttribute('data-state')).toBe('error'));
    expect(card()?.textContent).toContain('hq-pro is away');
    host.querySelector<HTMLButtonElement>('[data-testid="session-project-retry"]')?.click();
    flushSync();
    expect(card()?.getAttribute('data-state')).toBe('offer');
  });

  it("ignores another session's notice, and dismiss hides the card", async () => {
    invoke.mockImplementation(async () => []);
    mountCard('s1');
    await fire({ ...NOTICE, sessionId: 's2' });
    expect(card()).toBeNull();

    await fire(NOTICE);
    expect(card()).toBeTruthy();
    host.querySelector<HTMLButtonElement>('[data-testid="session-project-dismiss"]')?.click();
    flushSync();
    expect(card()).toBeNull();
  });

  it('listens for nothing useful without a session on screen', async () => {
    invoke.mockImplementation(async () => []);
    mountCard(null);
    await fire(NOTICE);
    expect(card()).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });
});
