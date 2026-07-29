// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { mount, unmount } from 'svelte';
import MeetingsAgenda from './MeetingsAgenda.svelte';
import type { MeetingEvent } from '../lib/meetings-model';
import type { MeetingBotAction } from '../lib/meetings-store.svelte';

const event = {
  id: 'event-1',
  summary: 'Design review',
  start: { dateTime: '2026-07-29T16:00:00Z' },
  end: { dateTime: '2026-07-29T16:30:00Z' },
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
} as MeetingEvent;

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe('MeetingsAgenda pending controls', () => {
  it('marks only Join now busy while disabling the sibling Invite action', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    component = mount(MeetingsAgenda, {
      target: host,
      props: {
        groups: [{ label: 'Today', events: [event] }],
        upNext: null,
        totalCount: 1,
        pendingActionsByEventId: new Map<string, MeetingBotAction>([
          ['event-1', 'join-now'],
        ]),
      },
    });

    const invite = host.querySelector<HTMLButtonElement>('.row-icon-invite');
    const joinNow = host.querySelector<HTMLButtonElement>('.row-icon-bot-now');
    expect(invite?.disabled).toBe(true);
    expect(invite?.getAttribute('aria-busy')).toBe('false');
    expect(invite?.querySelector('.row-icon-spinner')).toBeNull();
    expect(joinNow?.disabled).toBe(true);
    expect(joinNow?.getAttribute('aria-busy')).toBe('true');
    expect(joinNow?.querySelector('.row-icon-spinner')).not.toBeNull();
  });
});
