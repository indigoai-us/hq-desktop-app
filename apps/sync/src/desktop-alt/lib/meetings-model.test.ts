import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import {
  activeRecordingsFromScheduledBots,
  botForEvent,
  buildRefreshProblemReport,
  buildConnectedCalendarRows,
  calendarEventIdsForBotLookup,
  dayLabel,
  groupByDay,
  isAuthError,
  isPlausibleMeetingUrl,
  isRecurringMeeting,
  MEETINGS_STALE_NOTICE_FAILURES,
  meetingsRefreshGate,
  mergeScheduledBotLookups,
  mergeScheduledBots,
  pickLiveMeeting,
  recurringSeriesId,
  rowButtonKind,
  totalSignalCounts,
  urlInviteDestinationLabel,
  type MeetingEvent,
  type ScheduledBot,
} from './meetings-model';
import {
  activeMeetings,
  upsertActiveMeeting,
  type ActiveMeeting,
} from '../../lib/activeMeetings';

describe('meetings-model', () => {
  it('prioritizes recording meetings over newer detections', () => {
    const rows: ActiveMeeting[] = [
      {
        windowId: 'newer',
        platform: 'zoom',
        meetingUrl: 'recall-window:newer',
        detectedAt: '2026-05-27T17:00:00.000Z',
        state: 'detected',
        companyUid: null,
      },
      {
        windowId: 'recording',
        platform: 'meet',
        meetingUrl: 'recall-window:recording',
        detectedAt: '2026-05-27T16:00:00.000Z',
        state: 'recording',
        companyUid: null,
      },
    ];

    expect(pickLiveMeeting(rows)?.windowId).toBe('recording');
  });

  it('preserves active recording state when the same meeting is detected again', () => {
    activeMeetings.set([]);
    upsertActiveMeeting({
      windowId: 'call-window',
      platform: 'meet',
      meetingUrl: 'recall-window:call-window',
      detectedAt: '2026-05-27T16:00:00.000Z',
      state: 'recording',
      recordingId: 'rec_123',
      companyUid: null,
    });
    upsertActiveMeeting({
      windowId: 'call-window',
      platform: 'meet',
      meetingUrl: 'recall-window:call-window',
      detectedAt: '2026-05-27T17:00:00.000Z',
      state: 'detected',
      companyUid: null,
      summary: 'Updated title',
    });

    expect(get(activeMeetings)[0]).toMatchObject({
      windowId: 'call-window',
      state: 'recording',
      recordingId: 'rec_123',
      summary: 'Updated title',
    });
  });

  it('counts action, decision, and risk signals across meetings', () => {
    const events: MeetingEvent[] = [
      {
        id: 'a',
        status: 'confirmed',
        start: { dateTime: '2026-05-27T17:00:00.000Z' },
        end: { dateTime: '2026-05-27T17:30:00.000Z' },
        signals: {
          actions: ['Follow up'],
          decisions: [{ title: 'Ship it' }],
          risks: ['Blocked'],
        },
      },
      {
        id: 'b',
        status: 'confirmed',
        start: { dateTime: '2026-05-27T18:00:00.000Z' },
        end: { dateTime: '2026-05-27T18:30:00.000Z' },
        signals: [{ type: 'action_item' }, { kind: 'decision' }],
      },
    ];

    expect(totalSignalCounts(events)).toEqual({
      actions: 2,
      decisions: 2,
      risks: 1,
    });
  });

  it('joins enabled cached calendars to membership routing status', () => {
    const rows = buildConnectedCalendarRows(
      [{ accountId: 'acct_1', email: 'person@example.com' }],
      new Map([['acct_1', [{ id: 'primary', summary: 'Person' }]]]),
      new Map([['acct_1', new Set(['primary'])]]),
      [
        {
          id: 'event_1',
          status: 'confirmed',
          start: { dateTime: '2026-05-27T17:00:00.000Z' },
          end: { dateTime: '2026-05-27T17:30:00.000Z' },
          sourceAccountId: 'acct_1',
          sourceCalendarId: 'primary',
          sourceCompanyUid: 'cmp_123',
        },
      ],
      [{ companyUid: 'cmp_123', companyName: 'Indigo', status: 'active' }],
    );

    expect(rows).toEqual([
      {
        key: 'acct_1|primary',
        email: 'person@example.com',
        calendar: 'Person',
        routingTarget: 'Indigo',
        status: 'active',
      },
    ]);
  });

  it('treats an explicitly empty enabled calendar set as no enabled calendars', () => {
    const rows = buildConnectedCalendarRows(
      [{ accountId: 'acct_1', email: 'person@example.com' }],
      new Map([['acct_1', [{ id: 'primary', summary: 'Person' }]]]),
      new Map([['acct_1', new Set()]]),
      [
        {
          id: 'event_1',
          status: 'confirmed',
          start: { dateTime: '2026-05-27T17:00:00.000Z' },
          end: { dateTime: '2026-05-27T17:30:00.000Z' },
          sourceAccountId: 'acct_1',
          sourceCalendarId: 'primary',
        },
      ],
      [{ companyUid: 'cmp_123', companyName: 'Indigo', status: 'active' }],
    );

    expect(rows).toEqual([]);
  });

  it('seeds active Live now rows from cached scheduled recordings', () => {
    const rows = activeRecordingsFromScheduledBots(
      [
        {
          id: 'event_1',
          summary: 'Product Review',
          status: 'confirmed',
          start: { dateTime: '2026-05-27T17:00:00.000Z' },
          end: { dateTime: '2026-05-27T17:30:00.000Z' },
          sourceCompanyUid: 'cmp_123',
        },
      ],
      new Map([
        [
          'event_1',
          {
            botId: 'bot_1',
            meetingUrl: 'https://meet.google.com/abc-defg-hij',
            platform: 'google_meet',
            status: 'recording',
            calendarEventId: 'event_1',
            meetingTitle: 'Product Review',
            scheduledStartTime: '2026-05-27T17:00:00.000Z',
            autoScheduled: true,
          },
        ],
        [
          'event_2',
          {
            botId: 'bot_2',
            meetingUrl: 'https://meet.google.com/abc-defg-hij',
            platform: 'google_meet',
            status: 'scheduled',
            calendarEventId: 'event_2',
            autoScheduled: true,
          },
        ],
      ]),
    );

    expect(rows).toEqual([
      expect.objectContaining({
        windowId: 'scheduled-bot:bot_1',
        state: 'recording',
        recordingId: 'bot_1',
        companyUid: 'cmp_123',
        summary: 'Product Review',
        sourceEventId: 'event_1',
      }),
    ]);
  });

  // `now` is a fixed local wall-clock reference. Event times are built from
  // local Date components and round-tripped through ISO so the local-day
  // comparison in dayLabel/groupByDay is stable regardless of the test TZ.
  const now = new Date(2026, 4, 27, 9, 0, 0); // Wed May 27 2026, 09:00 local

  function eventAt(id: string, local: Date): MeetingEvent {
    return {
      id,
      status: 'confirmed',
      start: { dateTime: local.toISOString() },
      end: { dateTime: new Date(local.getTime() + 30 * 60_000).toISOString() },
    };
  }

  it('labels days relative to now as Today / Tomorrow / dated', () => {
    expect(dayLabel(new Date(2026, 4, 27, 15, 0, 0), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 4, 28, 8, 0, 0), now)).toBe('Tomorrow');

    const dated = dayLabel(new Date(2026, 4, 30, 8, 0, 0), now);
    expect(dated).not.toBe('Today');
    expect(dated).not.toBe('Tomorrow');
    expect(dated).toContain('30');
  });

  it('groups events into chronological per-day buckets', () => {
    const groups = groupByDay(
      [
        eventAt('today-late', new Date(2026, 4, 27, 16, 0, 0)),
        eventAt('tomorrow', new Date(2026, 4, 28, 10, 0, 0)),
        eventAt('today-early', new Date(2026, 4, 27, 9, 30, 0)),
      ],
      now,
    );

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Tomorrow']);
    // Sorted within the day even though input order was late-then-early.
    expect(groups[0].events.map((e) => e.id)).toEqual(['today-early', 'today-late']);
    expect(groups[1].events.map((e) => e.id)).toEqual(['tomorrow']);
  });

  it('drops events with no parseable start from the day groups', () => {
    const groups = groupByDay(
      [
        eventAt('real', new Date(2026, 4, 27, 12, 0, 0)),
        { id: 'startless', status: 'confirmed', start: {}, end: {} },
      ],
      now,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].events.map((e) => e.id)).toEqual(['real']);
  });

  describe('recurring meeting detection', () => {
    it('prefers the explicit Google recurringEventId', () => {
      const event = {
        ...eventAt('instance-1', new Date(2026, 4, 27, 12, 0, 0)),
        recurringEventId: 'series-1',
      };

      expect(recurringSeriesId(event)).toBe('series-1');
      expect(isRecurringMeeting(event)).toBe(true);
    });

    it('treats recurrence rules on a master event as a series', () => {
      const event = {
        ...eventAt('series-master', new Date(2026, 4, 27, 12, 0, 0)),
        recurrence: ['RRULE:FREQ=WEEKLY'],
      };

      expect(recurringSeriesId(event)).toBe('series-master');
      expect(isRecurringMeeting(event)).toBe(true);
    });

    it('derives the series id from Google instance ids for legacy payloads', () => {
      const event = eventAt('team_sync_20260527T190000Z', new Date(2026, 4, 27, 12, 0, 0));

      expect(recurringSeriesId(event)).toBe('team_sync');
      expect(isRecurringMeeting(event)).toBe(true);
    });

    it('returns null for one-off events', () => {
      const event = eventAt('one-off', new Date(2026, 4, 27, 12, 0, 0));

      expect(recurringSeriesId(event)).toBeNull();
      expect(isRecurringMeeting(event)).toBe(false);
    });
  });

  describe('botForEvent', () => {
    function bot(overrides: Partial<ScheduledBot>): ScheduledBot {
      return {
        botId: 'bot-1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        platform: 'google_meet',
        status: 'scheduled',
        autoScheduled: true,
        ...overrides,
      };
    }

    it('prefers the exact event bot when both exact and series bots match', () => {
      const event = {
        ...eventAt('series-1_20260527T190000Z', new Date(2026, 4, 27, 12, 0, 0)),
        recurringEventId: 'series-1',
      };
      const exact = bot({
        botId: 'bot-exact',
        calendarEventId: event.id,
        calendarSeriesId: 'series-1',
      });
      const series = bot({
        botId: 'bot-series',
        calendarEventId: 'series-1_20260520T190000Z',
        calendarSeriesId: 'series-1',
      });

      expect(botForEvent(event, new Map([[event.id, exact]]), [series, exact])?.botId).toBe(
        'bot-exact',
      );
    });

    it('matches a recurring event row to a bot scheduled for the series', () => {
      const event = {
        ...eventAt('series-1_20260527T190000Z', new Date(2026, 4, 27, 12, 0, 0)),
        recurringEventId: 'series-1',
      };
      const seriesBot = bot({
        calendarEventId: 'series-1_20260520T190000Z',
        calendarSeriesId: 'series-1',
      });

      expect(rowButtonKind(botForEvent(event, new Map(), [seriesBot]))).toBe('invited');
    });

    it('ignores inactive series bots so failed cancels can be retried by inviting again', () => {
      const event = {
        ...eventAt('series-1_20260527T190000Z', new Date(2026, 4, 27, 12, 0, 0)),
        recurringEventId: 'series-1',
      };
      const failedBot = bot({
        status: 'failed',
        calendarSeriesId: 'series-1',
      });

      expect(botForEvent(event, new Map(), [failedBot])).toBeUndefined();
    });
  });

  describe('bot list lookup helpers', () => {
    it('dedupes event ids before asking the backend for per-event bot state', () => {
      expect(
        calendarEventIdsForBotLookup([
          eventAt('event-1', new Date(2026, 4, 27, 12, 0, 0)),
          eventAt('event-2', new Date(2026, 4, 27, 13, 0, 0)),
          eventAt('event-1', new Date(2026, 4, 27, 14, 0, 0)),
          { ...eventAt('   ', new Date(2026, 4, 27, 15, 0, 0)), id: '   ' },
        ]),
      ).toEqual(['event-1', 'event-2']);
    });

    it('keeps authoritative per-event bot rows before legacy full-list rows', () => {
      const eventBot: ScheduledBot = {
        botId: 'bot-1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        platform: 'google_meet',
        status: 'scheduled',
        calendarEventId: 'event-1',
        autoScheduled: true,
        meetingTitle: 'Authoritative row',
      };
      const fullListBot: ScheduledBot = {
        ...eventBot,
        meetingTitle: 'Legacy full-list row',
      };
      const recordedBot: ScheduledBot = {
        botId: 'bot-2',
        meetingUrl: 'https://meet.google.com/def-ghij-klm',
        platform: 'google_meet',
        status: 'completed',
        calendarEventId: 'event-2',
        autoScheduled: true,
        meetingTitle: 'Recorded row',
      };

      expect(mergeScheduledBots([eventBot], [fullListBot, recordedBot])).toEqual([
        eventBot,
        recordedBot,
      ]);
    });

    it('requires per-event bot rows when visible event ids are known', () => {
      const eventBot: ScheduledBot = {
        botId: 'bot-1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        platform: 'google_meet',
        status: 'scheduled',
        calendarEventId: 'event-1',
        autoScheduled: true,
      };
      const fullListBot: ScheduledBot = {
        ...eventBot,
        botId: 'bot-legacy',
      };

      expect(mergeScheduledBotLookups(['event-1'], null, [fullListBot])).toBeNull();
      expect(mergeScheduledBotLookups(['event-1'], [eventBot], null)).toEqual([
        eventBot,
      ]);
      expect(mergeScheduledBotLookups([], null, [fullListBot])).toEqual([
        fullListBot,
      ]);
    });
  });

  describe('meetings refresh stale gate', () => {
    it('stays silent until N consecutive failures, then shows a muted stale notice', () => {
      let failures = 0;
      for (let i = 1; i < MEETINGS_STALE_NOTICE_FAILURES; i += 1) {
        const gate = meetingsRefreshGate(
          failures,
          'Error: 503 Service Unavailable',
          MEETINGS_STALE_NOTICE_FAILURES,
        );
        failures = gate.consecutiveFailures;
        expect(gate.notice).toBe('');
        expect(gate.refreshBlocked).toBe(false);
      }

      const blocked = meetingsRefreshGate(
        failures,
        'Error: 503 Service Unavailable',
        MEETINGS_STALE_NOTICE_FAILURES,
      );
      expect(blocked.consecutiveFailures).toBe(MEETINGS_STALE_NOTICE_FAILURES);
      expect(blocked.notice).toBe(
        'Showing your last synced meetings — couldn’t refresh just now.',
      );
      expect(blocked.notice).not.toMatch(/could not refresh/i);
      expect(blocked.refreshBlocked).toBe(true);
    });

    it('resets the failure streak on success', () => {
      const reset = meetingsRefreshGate(
        MEETINGS_STALE_NOTICE_FAILURES,
        null,
        MEETINGS_STALE_NOTICE_FAILURES,
      );
      expect(reset).toEqual({
        consecutiveFailures: 0,
        notice: '',
        refreshBlocked: false,
      });

      const firstMissAfterSuccess = meetingsRefreshGate(
        reset.consecutiveFailures,
        'Error: 503 Service Unavailable',
        MEETINGS_STALE_NOTICE_FAILURES,
      );
      expect(firstMissAfterSuccess.notice).toBe('');
      expect(firstMissAfterSuccess.refreshBlocked).toBe(false);
    });

    it('shows auth failures immediately without enabling the report action', () => {
      const gate = meetingsRefreshGate(0, 'Error: 401 Unauthorized');

      expect(isAuthError('auth token expired')).toBe(true);
      expect(gate.notice).toBe('Sign in again to load meetings.');
      expect(gate.refreshBlocked).toBe(false);
    });
  });

  describe('buildRefreshProblemReport', () => {
    it('attaches the raw error and refresh context', () => {
      const report = buildRefreshProblemReport({
        notice: 'Showing your last synced meetings — couldn’t refresh just now.',
        rawError: 'Error: 503 Service Unavailable',
        meetingsShown: 14,
        connectedAccounts: 2,
      });

      expect(report.title).toBe("HQ Sync: Meetings won't refresh");
      expect(report.body).toContain('Error: 503 Service Unavailable');
      expect(report.body).toContain('Meetings currently shown: 14');
      expect(report.body).toContain('Connected accounts: 2');
    });

    it('falls back gracefully when no raw error was captured', () => {
      const report = buildRefreshProblemReport({
        notice: '',
        rawError: '',
        meetingsShown: 0,
        connectedAccounts: 0,
      });

      expect(report.body).toContain('Last refresh error: (none captured)');
    });
  });

  // US-010 — "Done — transcript saved" must be gated on the REAL source-landed
  // signal, not on bot.status === 'completed' alone. The two can diverge: the
  // bot lifecycle status flips on the Recall webhook / retry path while the
  // per-company source write is a separate S3 PUT that can hard-fail (the
  // 2026-06-02 KMS-grant drift dead-lettered transcripts for ~13 days while
  // bots still read "completed"). hq-pro exposes `sourceLanded`; the row gates
  // the terminal "done" affordance on it.
  describe('rowButtonKind — gates Done on the real source-landed signal', () => {
    function bot(overrides: Partial<ScheduledBot>): ScheduledBot {
      return {
        botId: 'bot-1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        platform: 'google_meet',
        status: 'completed',
        autoScheduled: true,
        ...overrides,
      };
    }

    it('no bot → invite', () => {
      expect(rowButtonKind(undefined)).toBe('invite');
    });

    it('REGRESSION: completed bot whose ingest FAILED (sourceLanded:false) does NOT render done', () => {
      // The exact #240 symptom from the user's POV — completed status, but the
      // transcript never landed as a per-company source. Must show processing,
      // never "Done — transcript saved".
      expect(rowButtonKind(bot({ status: 'completed', sourceLanded: false }))).toBe(
        'processing',
      );
    });

    it('REGRESSION: completed bot with sourceLanded absent (pre-US-010 server) does NOT render done', () => {
      // A backend that predates US-010 omits the field entirely. The client
      // must fail safe to "processing" rather than show a premature "saved".
      expect(rowButtonKind(bot({ status: 'completed' }))).toBe('processing');
    });

    it('completed bot whose source LANDED (sourceLanded:true) renders done', () => {
      expect(rowButtonKind(bot({ status: 'completed', sourceLanded: true }))).toBe(
        'done',
      );
    });

    it('source-landed only flips done at the completed status — earlier statuses are unaffected', () => {
      // sourceLanded true on a non-terminal status (shouldn't happen, but be
      // defensive) does NOT short-circuit the lifecycle to done.
      expect(rowButtonKind(bot({ status: 'scheduled', sourceLanded: true }))).toBe(
        'invited',
      );
      expect(rowButtonKind(bot({ status: 'joining', sourceLanded: true }))).toBe(
        'joining',
      );
      expect(rowButtonKind(bot({ status: 'recording', sourceLanded: true }))).toBe(
        'in-call',
      );
      expect(rowButtonKind(bot({ status: 'processing', sourceLanded: true }))).toBe(
        'processing',
      );
    });

    it('a failed/unknown status falls back to invite regardless of sourceLanded', () => {
      expect(rowButtonKind(bot({ status: 'failed', sourceLanded: false }))).toBe(
        'invite',
      );
    });
  });

  // Gate for the paste-a-URL invite bar (parity with the classic MeetingsWindow):
  // the Invite button + Enter key only fire for a real join link, so a bogus
  // paste can never schedule a bot.
  describe('isPlausibleMeetingUrl', () => {
    it('accepts real Zoom / Google Meet / Teams / Webex links', () => {
      expect(isPlausibleMeetingUrl('https://us02web.zoom.us/j/8412345678')).toBe(true);
      expect(isPlausibleMeetingUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
      expect(
        isPlausibleMeetingUrl('https://teams.microsoft.com/l/meetup-join/xyz'),
      ).toBe(true);
      expect(isPlausibleMeetingUrl('https://acme.webex.com/meet/room')).toBe(true);
    });

    it('rejects empty, non-meeting, and non-https URLs', () => {
      expect(isPlausibleMeetingUrl('')).toBe(false);
      expect(isPlausibleMeetingUrl('   ')).toBe(false);
      expect(isPlausibleMeetingUrl('https://example.com/not-a-meeting')).toBe(false);
      expect(isPlausibleMeetingUrl('http://meet.google.com/abc-defg-hij')).toBe(false);
      expect(isPlausibleMeetingUrl('zoom.us/j/123')).toBe(false);
    });
  });

  describe('urlInviteDestinationLabel', () => {
    const names = new Map<string, string>([['co-1', 'Indigo']]);

    it('returns "Personal" when no company is picked', () => {
      expect(urlInviteDestinationLabel(null, names)).toBe('Personal');
    });

    it('returns the company name for a known uid', () => {
      expect(urlInviteDestinationLabel('co-1', names)).toBe('Indigo');
    });

    it('falls back to "company" for an unknown uid', () => {
      expect(urlInviteDestinationLabel('co-unknown', names)).toBe('company');
    });
  });
});
