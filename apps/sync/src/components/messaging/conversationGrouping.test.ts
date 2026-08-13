// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

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

function message(
  eventId: string,
  fromPersonUid: string,
  fromDisplayName: string,
  createdAt: string,
  direction: ConversationMessage['direction'] = 'in',
): ConversationMessage {
  return {
    eventId,
    fromPersonUid,
    fromDisplayName,
    body: eventId,
    createdAt,
    direction,
  };
}

describe('conversation message grouping', () => {
  it('groups only consecutive same-sender messages in the same five-minute window and day', () => {
    component = mount(Conversation, {
      target: host,
      props: {
        showAuthors: true,
        messages: [
          message('maya-1', 'maya', 'Maya', '2026-07-28T10:00:00.000Z'),
          message('maya-2', 'maya', 'Maya', '2026-07-28T10:04:00.000Z'),
          message('avery-sender-change', 'avery', 'Avery', '2026-07-28T10:04:30.000Z'),
          message('avery-window-change', 'avery', 'Avery', '2026-07-28T10:10:00.000Z'),
          message('avery-day-change', 'avery', 'Avery', '2026-07-29T10:10:00.000Z'),
          message('out-1', 'self', 'You', '2026-07-29T10:11:00.000Z', 'out'),
          message('out-2', 'self', 'You', '2026-07-29T10:13:00.000Z', 'out'),
        ],
        onsend: vi.fn(),
      },
    });
    flushSync();

    const rendered = [...host.querySelectorAll<HTMLElement>('.dm-msg')];
    expect(rendered).toHaveLength(7);
    expect(
      rendered.map((element) => [
        element.classList.contains('dm-msg-group-start'),
        element.classList.contains('dm-msg-group-end'),
      ]),
    ).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [true, true],
      [true, true],
      [true, false],
      [false, true],
    ]);

    expect(
      rendered.map((element) =>
        element.querySelector('.dm-msg-author')?.textContent?.trim() ?? null,
      ),
    ).toEqual(['Maya', null, 'Avery', 'Avery', 'Avery', 'You', null]);
    // S1 token parity: no visible footer status at rest — "Delivered" is
    // screen-reader-only now, and header times stay hover-revealed.
    expect(
      rendered.map((element) => element.querySelectorAll('.dm-msg-time').length),
    ).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(
      rendered.map((element) => element.querySelectorAll('.dm-msg-header-time').length),
    ).toEqual([1, 0, 1, 1, 1, 1, 0]);
    expect(
      [...(rendered[6]?.querySelectorAll('.sr-only') ?? [])].map(
        (element) => element.textContent,
      ),
    ).toContain('Delivered');
    expect(host.querySelectorAll('.date-separator')).toHaveLength(2);
  });
});
