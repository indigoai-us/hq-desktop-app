/**
 * Pure presentation model for the Meetings main-pane redesign (US-017).
 *
 * Partitions upcoming vs past, derives notetaker toggle state, formats the
 * footer metadata strip, and re-exports day grouping from meetings-model so the
 * page stays a thin store consumer. No Svelte / Tauri.
 */

import {
  botForEvent,
  eventEnd,
  groupByDay,
  isActiveBotStatus,
  rowButtonKind,
  sortByStart,
  type DayGroup,
  type MeetingEvent,
  type RowButtonKind,
  type ScheduledBot,
} from './meetings-model';

export type MeetingsAgendaTab = 'upcoming' | 'past';

/** Notetaker toggle affordance on a meeting row. */
export type NotetakerToggleVisual = 'off' | 'on';

export interface NotetakerToggleModel {
  /** Visual: off = plus (invite), on = green check (scheduled). */
  visual: NotetakerToggleVisual;
  /** Underlying lifecycle kind from the bot map. */
  kind: RowButtonKind;
  /**
   * Whether clicking the toggle schedules (off→on) or cancels (on→off).
   * Processing / done / in-call still show "on" but cancel may still apply
   * for invited/joining/in-call; invite only when kind is invite.
   */
  action: 'invite' | 'cancel' | 'none';
  /** Accessible label for the toggle control. */
  ariaLabel: string;
}

/**
 * Split calendar events into upcoming (end >= now, start-ascending) and past
 * (end < now, newest-first). Events with no parseable end fall into upcoming
 * when start is missing or still in the future; otherwise past.
 */
export function partitionUpcomingPast(
  events: MeetingEvent[],
  now = new Date(),
): { upcoming: MeetingEvent[]; past: MeetingEvent[] } {
  const nowMs = now.getTime();
  const upcoming: MeetingEvent[] = [];
  const past: MeetingEvent[] = [];

  for (const event of events) {
    const end = eventEnd(event);
    if (!end) {
      upcoming.push(event);
      continue;
    }
    if (end.getTime() >= nowMs) upcoming.push(event);
    else past.push(event);
  }

  upcoming.sort(sortByStart);
  past.sort(
    (a, b) => (eventEnd(b)?.getTime() ?? 0) - (eventEnd(a)?.getTime() ?? 0),
  );
  return { upcoming, past };
}

/** Day-group the active agenda list (upcoming or past). Reuses groupByDay. */
export function groupMeetingsForAgenda(
  events: MeetingEvent[],
  now = new Date(),
): DayGroup[] {
  return groupByDay(events, now);
}

/**
 * Derive the notetaker toggle from bot attachment state.
 * - No active bot → off (plus) → invite
 * - Active scheduled/joining/recording/processing/done → on (green check)
 * - Click on → cancel when cancellable (invited/joining/in-call); none for processing/done
 */
export function notetakerToggleState(
  bot: ScheduledBot | undefined,
): NotetakerToggleModel {
  const kind = rowButtonKind(bot);
  if (!bot || !isActiveBotStatus(bot.status) || kind === 'invite') {
    return {
      visual: 'off',
      kind: 'invite',
      action: 'invite',
      ariaLabel: 'Schedule notetaker',
    };
  }
  if (kind === 'invited' || kind === 'joining' || kind === 'in-call') {
    return {
      visual: 'on',
      kind,
      action: 'cancel',
      ariaLabel:
        kind === 'in-call' ? 'Remove notetaker from meeting' : 'Cancel notetaker',
    };
  }
  // processing / done — show on, no toggle action
  return {
    visual: 'on',
    kind,
    action: 'none',
    ariaLabel: kind === 'done' ? 'Notetaker finished' : 'Notetaker processing',
  };
}

/**
 * Resolve toggle model for an event using the store's bot maps.
 */
export function notetakerToggleForEvent(
  event: MeetingEvent,
  botsByEventId: Map<string, ScheduledBot>,
  scheduledBots: ScheduledBot[] = Array.from(botsByEventId.values()),
): NotetakerToggleModel {
  return notetakerToggleState(botForEvent(event, botsByEventId, scheduledBots));
}

/**
 * Relative last-synced label for the footer ("just now", "5m ago", …).
 * Injectable `now` for tests. Missing timestamp → "never".
 */
export function formatLastSyncedRelative(
  lastSyncedAt: Date | string | number | null | undefined,
  now = new Date(),
): string {
  if (lastSyncedAt == null || lastSyncedAt === '') return 'never';
  const then =
    lastSyncedAt instanceof Date
      ? lastSyncedAt.getTime()
      : typeof lastSyncedAt === 'number'
        ? lastSyncedAt
        : new Date(lastSyncedAt).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Footer metadata: "N CALENDARS CONNECTED · LAST SYNCED <relative>".
 * Uppercase metadata styling is applied in CSS; this returns the raw label.
 * "Manage" is a separate control in the view.
 */
export function formatMeetingsFooterLabel(opts: {
  calendarCount: number;
  lastSyncedAt: Date | string | number | null | undefined;
  now?: Date;
}): string {
  const n = Math.max(0, Math.floor(opts.calendarCount));
  const calWord = n === 1 ? 'CALENDAR' : 'CALENDARS';
  const relative = formatLastSyncedRelative(opts.lastSyncedAt, opts.now);
  return `${n} ${calWord} CONNECTED · LAST SYNCED ${relative}`;
}

/** Page dek / subtitle under the Meetings title. */
export const MEETINGS_PAGE_DEK = 'agenda, notetaker, and recaps';

/** Full design string used in headers / a11y. */
export const MEETINGS_PAGE_TITLE_LINE = `Meetings — ${MEETINGS_PAGE_DEK}`;

/** Empty copy when Past tab has no ended events in the current snapshot. */
export const MEETINGS_PAST_EMPTY = 'No past meetings yet';

/** Empty copy when Upcoming tab has no events and calendars are connected. */
export const MEETINGS_UPCOMING_EMPTY = 'No meetings in your synced calendars yet.';
