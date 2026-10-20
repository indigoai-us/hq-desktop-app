// @vitest-environment happy-dom
//
// PR #1717 review, critical 1: the share-detail window mounts the shared
// @hq/ui ReactionBar, whose hover title and aria-label name each reactor and
// say "You" only for the reactor whose personUid is `selfPersonUid`. The server
// lists the caller in `reactors`, so a mount without the caller's uid read
// "You and <your own name> reacted with 👍". Both share-detail mounts
// (ShareMainPane for shares, Conversation for the DM pane) are covered here.

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
import ShareMainPane from './ShareMainPane.svelte';
import DmThreadPane from './DmThreadPane.svelte';
import Conversation, { type ConversationMessage } from './messaging/Conversation.svelte';
import type { ShareEvent } from '../lib/notificationGroups';
import type { ReactionAggregate } from '../lib/reactions';

const SELF = 'prs_self';
const SELF_NAME = 'Shawon Majid';

/** Server-shaped aggregates: the caller is listed in `reactors`. */
const SELF_ONLY: ReactionAggregate = {
  emoji: '👍',
  count: 1,
  reactedByMe: true,
  reactors: [{ personUid: SELF, displayName: SELF_NAME }],
};
const SELF_AND_ADA: ReactionAggregate = {
  emoji: '🎉',
  count: 2,
  reactedByMe: true,
  reactors: [
    { personUid: SELF, displayName: SELF_NAME },
    { personUid: 'prs_ada', displayName: 'Ada' },
  ],
};

const SHARE: ShareEvent = {
  eventId: 'evt_share_1',
  issuerEmail: 'ada@example.com',
  issuerDisplayName: 'Ada',
  issuerPersonUid: 'prs_ada',
  paths: ['indigo/README.md'],
  note: null,
  permission: 'read',
  createdAt: '2026-10-19T10:00:00Z',
};

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
  tauri.invoke.mockReset();
});

const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
    flushSync();
  }
};

/** Each pill's "title | aria-label", sorted (the bar orders pills by count). */
function pillLabels(): string[] {
  return [...host.querySelectorAll('.reaction-pill')]
    .map((el) => `${el.getAttribute('title')} | ${el.getAttribute('aria-label')}`)
    .sort();
}

function mockInvoke(whoami: () => unknown) {
  tauri.invoke.mockImplementation(async (command: string) => {
    if (command === 'whoami') return whoami();
    if (command === 'fetch_reactions') return [SELF_ONLY, SELF_AND_ADA];
    return null;
  });
}

describe('share-detail reactions name the signed-in user once', () => {
  it('ShareMainPane passes the caller uid from whoami to the ReactionBar', async () => {
    mockInvoke(() => ({ personUid: SELF }));
    component = mount(ShareMainPane, { target: host, props: { events: [SHARE] } });
    await settle();

    const labels = pillLabels();
    expect(labels).toEqual([
      'You and Ada reacted with 🎉 | You and Ada reacted with 🎉',
      'You reacted with 👍 | You reacted with 👍',
    ]);
    expect(labels.join(' ')).not.toContain(SELF_NAME);
  });

  it('ShareMainPane hides reactor names when whoami fails, without naming the caller', async () => {
    mockInvoke(() => {
      throw new Error('Not signed in');
    });
    component = mount(ShareMainPane, { target: host, props: { events: [SHARE] } });
    await settle();

    const labels = pillLabels();
    expect(labels).toEqual([
      'You and 1 other person reacted with 🎉 | You and 1 other person reacted with 🎉',
      'You reacted with 👍 | You reacted with 👍',
    ]);
    expect(labels.join(' ')).not.toContain(SELF_NAME);
  });

  it('DmThreadPane passes the caller uid from whoami down to the ReactionBar', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'whoami') return { personUid: SELF };
      if (command === 'fetch_reactions') return [SELF_ONLY, SELF_AND_ADA];
      if (command === 'fetch_dm_thread') return { messages: [] };
      if (command === 'list_syncable_workspaces') return { workspaces: [] };
      return null;
    });
    component = mount(DmThreadPane, {
      target: host,
      props: {
        event: {
          eventId: 'evt_dm_live',
          fromPersonUid: 'prs_ada',
          fromEmail: 'ada@example.com',
          fromDisplayName: 'Ada',
          body: 'hello',
          createdAt: '2026-10-19T10:00:00Z',
        },
      },
    });
    await settle();

    const labels = pillLabels();
    expect(labels).toEqual([
      'You and Ada reacted with 🎉 | You and Ada reacted with 🎉',
      'You reacted with 👍 | You reacted with 👍',
    ]);
  });

  it('Conversation (DM pane) says "You" for the caller when given selfPersonUid', () => {
    const msg: ConversationMessage = {
      eventId: 'evt_dm_1',
      fromPersonUid: 'prs_ada',
      fromDisplayName: 'Ada',
      body: 'hello',
      createdAt: '2026-10-19T10:00:00Z',
      direction: 'in',
    };
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [msg],
        onsend: vi.fn(),
        reactions: { evt_dm_1: [SELF_ONLY, SELF_AND_ADA] },
        ontogglereaction: vi.fn(),
        selfPersonUid: SELF,
      },
    });
    flushSync();

    expect(pillLabels()).toEqual([
      'You and Ada reacted with 🎉 | You and Ada reacted with 🎉',
      'You reacted with 👍 | You reacted with 👍',
    ]);
  });

  it('Conversation without selfPersonUid never names the caller', () => {
    const msg: ConversationMessage = {
      eventId: 'evt_dm_1',
      fromPersonUid: 'prs_ada',
      fromDisplayName: 'Ada',
      body: 'hello',
      createdAt: '2026-10-19T10:00:00Z',
      direction: 'in',
    };
    component = mount(Conversation, {
      target: host,
      props: {
        messages: [msg],
        onsend: vi.fn(),
        reactions: { evt_dm_1: [SELF_ONLY, SELF_AND_ADA] },
        ontogglereaction: vi.fn(),
      },
    });
    flushSync();

    expect(pillLabels().join(' ')).not.toContain(SELF_NAME);
  });
});
