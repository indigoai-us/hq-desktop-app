/**
 * US-005 — Meeting bot identity and duplicate-invite recovery
 *
 * Acceptance coverage for conservative Zoom/Meet/Teams URL normalization,
 * event → series → URL bot join order, active URL match with missing calendar
 * IDs, HTTP 409 → already-invited + background refresh (no error banner), and
 * visible lifecycle states before interaction.
 *
 * Note: apps/sync/__tests__/stories/US-005.test.ts is a legacy window-routing /
 * settings story (retargeted) — do not overwrite it. This file is the
 * acceptance suite for hq-desktop-windows-reliability / US-005.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  botAttachmentState,
  botForEvent,
  meetingUrlsMatch,
  normalizeMeetingUrl,
  optimisticAlreadyInvitedBot,
  rowButtonKind,
  type MeetingEvent,
  type ScheduledBot,
} from '../../src/desktop-alt/lib/meetings-model';
import { isAlreadyScheduledError } from '../../src/lib/invite-errors';

const repoRoot = join(process.cwd());

function readRepo(...parts: string[]): string {
  const path = join(repoRoot, ...parts);
  expect(existsSync(path), `missing ${parts.join('/')}`).toBe(true);
  return readFileSync(path, 'utf8');
}

function event(
  id: string,
  overrides: Partial<MeetingEvent> = {},
): MeetingEvent {
  return {
    id,
    status: 'confirmed',
    start: { dateTime: '2026-05-27T17:00:00.000Z' },
    end: { dateTime: '2026-05-27T17:30:00.000Z' },
    ...overrides,
  };
}

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

describe('US-005: Meeting bot identity and duplicate-invite recovery', () => {
  describe('AC1: conservative URL normalization', () => {
    it('joins equivalent Zoom / Meet / Teams URLs despite query or fragment noise', () => {
      expect(
        meetingUrlsMatch(
          'https://us02web.zoom.us/j/8412345678?pwd=secret&status=success',
          'https://zoom.us/j/8412345678#frag',
        ),
      ).toBe(true);
      expect(
        meetingUrlsMatch(
          'https://meet.google.com/abc-defg-hij?authuser=0',
          'https://meet.google.com/ABC-defg-HIJ',
        ),
      ).toBe(true);
      const teamsId = '19%3ameeting_AbCd%40thread.v2';
      expect(
        meetingUrlsMatch(
          `https://teams.microsoft.com/l/meetup-join/${teamsId}?context=x`,
          `https://teams.microsoft.com/l/meetup-join/${teamsId}`,
        ),
      ).toBe(true);
    });

    it('keeps near-match meetings distinct', () => {
      expect(
        meetingUrlsMatch('https://zoom.us/j/1111111111', 'https://zoom.us/j/2222222222'),
      ).toBe(false);
      expect(
        meetingUrlsMatch(
          'https://meet.google.com/abc-defg-hij',
          'https://meet.google.com/abc-defg-xyz',
        ),
      ).toBe(false);
      expect(normalizeMeetingUrl('https://example.com/not-a-meeting')).toBeNull();
    });
  });

  describe('AC2–AC3: bot join order event → series → normalized URL', () => {
    it('prefers exact event id, then series, then normalized URL', () => {
      const evt = event('series-1_20260527T190000Z', {
        recurringEventId: 'series-1',
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
      });
      const exact = bot({
        botId: 'bot-exact',
        calendarEventId: evt.id,
        calendarSeriesId: 'series-1',
        meetingUrl: 'https://meet.google.com/other-room-zzz',
      });
      const series = bot({
        botId: 'bot-series',
        calendarEventId: 'other-instance',
        calendarSeriesId: 'series-1',
        meetingUrl: 'https://meet.google.com/other-room-zzz',
      });
      const urlOnly = bot({
        botId: 'bot-url',
        calendarEventId: null,
        calendarSeriesId: null,
        meetingUrl: 'https://meet.google.com/abc-defg-hij?authuser=1',
      });

      expect(
        botForEvent(evt, new Map([[evt.id, exact]]), [urlOnly, series, exact])?.botId,
      ).toBe('bot-exact');
      expect(botForEvent(evt, new Map(), [urlOnly, series])?.botId).toBe('bot-series');
      expect(botForEvent(evt, new Map(), [urlOnly])?.botId).toBe('bot-url');
    });

    it('shows an active bot via URL when calendar IDs are missing or stale', () => {
      const evt = event('one-off', {
        meetingUrl: 'https://us02web.zoom.us/j/8412345678?pwd=abc',
      });
      const stale = bot({
        botId: 'bot-stale-ids',
        status: 'recording',
        calendarEventId: 'stale-or-missing',
        calendarSeriesId: null,
        meetingUrl: 'https://zoom.us/j/8412345678',
        platform: 'zoom',
      });

      const matched = botForEvent(evt, new Map(), [stale]);
      expect(matched?.botId).toBe('bot-stale-ids');
      expect(botAttachmentState(matched)).toBe('recording');
    });
  });

  describe('AC4: HTTP 409 → already-invited + background refresh', () => {
    it('classifies 409 / bot-already-schedu* as already-scheduled (not a hard error)', () => {
      expect(
        isAlreadyScheduledError(
          'bot/invite HTTP 409: {"error":"A bot is already scheduled","code":"bot-already-scheduled"}',
        ),
      ).toBe(true);
      expect(
        isAlreadyScheduledError(
          'bot/invite HTTP 409: {"code":"bot-already-scheduling"}',
        ),
      ).toBe(true);
      expect(isAlreadyScheduledError(new Error('HTTP 500'))).toBe(false);
    });

    it('optimistic seed paints invited immediately (rowButtonKind + attachment state)', () => {
      const evt = event('evt-409', {
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        summary: 'Weekly',
      });
      const seeded = optimisticAlreadyInvitedBot(evt, evt.meetingUrl!);
      expect(rowButtonKind(seeded)).toBe('invited');
      expect(botAttachmentState(seeded)).toBe('invited');
      // Join works via event id so the agenda row flips without a refresh.
      expect(botForEvent(evt, new Map([[evt.id, seeded]]), [seeded])?.botId).toBe(
        seeded.botId,
      );
    });

    it('store recovers 409 with isAlreadyScheduledError, seed, info toast, background refresh', () => {
      const store = readRepo('src/desktop-alt/lib/meetings-store.svelte.ts');
      expect(store).toMatch(/isAlreadyScheduledError/);
      expect(store).toMatch(/seedAlreadyInvited|optimisticAlreadyInvitedBot/);
      expect(store).toMatch(/Already invited — refreshing\./);
      // Background refresh — void, not awaited on the conflict path.
      expect(store).toMatch(/void\s+refresh\(\)/);
      // Conflict path must not return kind:'warn'.
      expect(store).toMatch(/kind:\s*'info',\s*text:\s*'Already invited/);
    });

    it('MeetingsPage does not promote 409 recovery to the refresh-error banner', () => {
      const page = readRepo('src/desktop-alt/pages/MeetingsPage.svelte');
      expect(page).toMatch(/US-005/);
      expect(page).toMatch(/already-invited|HTTP 409/);
      // Invite only flashes toast; never assigns fetchError locally.
      expect(page).toMatch(/flashToast\(t\.kind,\s*t\.text\)/);
      expect(page).toMatch(/const fetchError = \$derived\(meetingsStore\.fetchError\)/);
      expect(page).not.toMatch(/fetchError\s*=\s*['"`]/);
      expect(page).not.toMatch(/meetingsStore\.fetchError\s*=/);
    });

    it('MeetingsPage consumes open_meetings_window focus handoff', () => {
      const page = readRepo('src/desktop-alt/pages/MeetingsPage.svelte');
      const agenda = readRepo('src/desktop-alt/components/MeetingsAgenda.svelte');
      expect(page).toContain("listen<{ meetingId?: string }>('meetings:focus-meeting'");
      expect(page).toContain("invoke<string | null>('meetings_take_pending_focus')");
      expect(page).toContain('{focusedMeetingId}');
      expect(agenda).toContain('data-meeting-id={event.id}');
      expect(agenda).toContain('data-bot-id={bot?.botId ?? \'\'}');
      expect(agenda).toContain(
        'class:focused={meetingMatchesFocusId(focusedMeetingId, event, bot)}',
      );
    });
  });

  describe('AC5: list distinguishes lifecycle states before interaction', () => {
    it('maps bot statuses onto available-to-invite / invited / joining / recording / completed', () => {
      expect(botAttachmentState(undefined)).toBe('available-to-invite');
      expect(botAttachmentState(bot({ status: 'scheduled' }))).toBe('invited');
      expect(botAttachmentState(bot({ status: 'joining' }))).toBe('joining');
      expect(botAttachmentState(bot({ status: 'recording' }))).toBe('recording');
      expect(
        botAttachmentState(bot({ status: 'completed', sourceLanded: true })),
      ).toBe('completed');
    });

    it('agenda rows expose data-bot-state for each visible attachment lifecycle', () => {
      const agenda = readRepo('src/desktop-alt/components/MeetingsAgenda.svelte');
      expect(agenda).toMatch(/botAttachmentState/);
      expect(agenda).toMatch(/data-bot-state=\{attachment\}/);
      // Distinct affordances for the five user-facing states.
      expect(agenda).toMatch(/kind === 'invite'/);
      expect(agenda).toMatch(/kind === 'invited'/);
      expect(agenda).toMatch(/kind === 'joining'/);
      expect(agenda).toMatch(/kind === 'in-call'/);
      expect(agenda).toMatch(/row-icon-done|Done — transcript saved/);
    });
  });
});
