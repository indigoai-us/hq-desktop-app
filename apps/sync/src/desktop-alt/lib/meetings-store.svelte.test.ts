// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingEvent, ScheduledBot } from './meetings-model';

const invoke = vi.hoisted(() => vi.fn());
const saveMeetingsCache = vi.hoisted(() => vi.fn());

vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../../lib/meetingsCache', () => ({
  loadMeetingsCache: vi.fn(() => null),
  saveMeetingsCache,
}));
vi.mock('../../lib/activeMeetings', () => ({
  ensureActiveMeetingListeners: vi.fn(async () => undefined),
  loadRecordingCompanyContext: vi.fn(async () => undefined),
  seedActiveMeetingsFromBackend: vi.fn(async () => undefined),
}));

import { meetingsStore } from './meetings-store.svelte';

const planRequiredError =
  'bot/invite HTTP 402: {"requiredPlan":"agents-500","code":"MEETING_PLAN_REQUIRED"}';
const planRequiredToast = {
  kind: 'warn' as const,
  text: 'Meetings need the $500/mo Team plan—upgrade in HQ Console to record.',
};
const event: MeetingEvent = {
  id: 'event-plan-required',
  summary: 'Roadmap',
  status: 'confirmed',
  start: { dateTime: '2026-07-29T17:00:00.000Z' },
  end: { dateTime: '2026-07-29T17:30:00.000Z' },
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function expectPlanGateDoesNotCommitOrRefresh(
  action: () => Promise<unknown>,
  expectedCommand: string,
  expectedPayload: object,
) {
  const upcoming = deferred<MeetingEvent[]>();
  let upcomingCalls = 0;
  invoke.mockImplementation((command: string) => {
    if (command === 'meetings_list_upcoming') {
      upcomingCalls += 1;
      return upcoming.promise;
    }
    if (
      command === 'meetings_list_memberships' ||
      command === 'meetings_list_accounts' ||
      command === 'meetings_list_scheduled_bots'
    ) {
      return Promise.resolve([]);
    }
    if (command === 'meetings_invite_bot' || command === 'meetings_join_bot_now') {
      return Promise.reject(planRequiredError);
    }
    throw new Error(`Unexpected invoke: ${command}`);
  });

  const poll = meetingsStore.refresh();
  expect(upcomingCalls).toBe(1);

  await expect(action()).resolves.toEqual(planRequiredToast);
  expect(invoke).toHaveBeenCalledWith(expectedCommand, expectedPayload);

  // The in-flight snapshot applies only if the denial did not call
  // markMutationCommitted(). A refresh would also queue a second poll.
  upcoming.resolve([]);
  await poll;
  expect(upcomingCalls).toBe(1);
  expect(saveMeetingsCache).toHaveBeenCalledTimes(1);
}

beforeEach(() => {
  invoke.mockReset();
  saveMeetingsCache.mockReset();
});

describe('meetings store refresh coordination', () => {
  it('shares a poll and queues a post-mutation refresh without committing stale data', async () => {
    const event: MeetingEvent = {
      id: 'event-1',
      summary: 'Roadmap',
      status: 'confirmed',
      start: { dateTime: '2026-07-29T17:00:00.000Z' },
      end: { dateTime: '2026-07-29T17:30:00.000Z' },
      meetingUrl: 'https://meet.google.com/abc-defg-hij',
    };
    const bot: ScheduledBot = {
      botId: 'bot-1',
      meetingUrl: event.meetingUrl!,
      platform: 'google_meet',
      status: 'scheduled',
      calendarEventId: event.id,
      autoScheduled: false,
    };
    const staleUpcoming = deferred<MeetingEvent[]>();
    let upcomingCalls = 0;

    invoke.mockImplementation((command: string) => {
      if (command === 'meetings_list_upcoming') {
        upcomingCalls += 1;
        return upcomingCalls === 1
          ? staleUpcoming.promise
          : Promise.resolve([event]);
      }
      if (
        command === 'meetings_list_memberships' ||
        command === 'meetings_list_accounts'
      ) {
        return Promise.resolve([]);
      }
      if (command === 'meetings_list_scheduled_bots') {
        return Promise.resolve(upcomingCalls >= 2 ? [bot] : []);
      }
      if (command === 'meetings_invite_bot') return Promise.resolve(bot);
      throw new Error(`Unexpected invoke: ${command}`);
    });

    const poll = meetingsStore.refresh();
    expect(meetingsStore.refresh()).toBe(poll);

    let mutationSettled = false;
    const mutation = meetingsStore.inviteBot(event).then((result) => {
      mutationSettled = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(upcomingCalls).toBe(1);
    expect(mutationSettled).toBe(false);
    expect(saveMeetingsCache).not.toHaveBeenCalled();

    staleUpcoming.resolve([]);
    await expect(mutation).resolves.toEqual({
      kind: 'info',
      text: 'Bot invited.',
    });
    await poll;

    expect(upcomingCalls).toBe(2);
    expect(meetingsStore.events).toEqual([event]);
    expect(meetingsStore.botsByEventId.get(event.id)).toEqual(bot);
    // The stale pass was discarded; only the authoritative trailing snapshot
    // reached the cache.
    expect(saveMeetingsCache).toHaveBeenCalledTimes(1);
  });
});

describe('meetings store Team-plan gate', () => {
  it('returns the plan warning without committing or refreshing for a row invite', async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.inviteBot(event),
      'meetings_invite_bot',
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: event.id,
        calendarSeriesId: null,
        companyId: null,
      },
    );
  });

  it('returns the plan warning without committing or refreshing for a URL invite', async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.inviteBotByUrl(event.meetingUrl!, 'company-1'),
      'meetings_invite_bot',
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: null,
        calendarSeriesId: null,
        companyId: 'company-1',
      },
    );
  });

  it('returns the plan warning without committing or refreshing for join now', async () => {
    await expectPlanGateDoesNotCommitOrRefresh(
      () => meetingsStore.joinBotNow(event),
      'meetings_join_bot_now',
      {
        meetingUrl: event.meetingUrl,
        calendarEventId: event.id,
        calendarSeriesId: null,
        companyId: null,
      },
    );
  });
});
