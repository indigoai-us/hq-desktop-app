<script lang="ts">
  import {
    botAttachmentState,
    botForEvent,
    companyLabel,
    durationLabel,
    eventMeetingUrl,
    isRecurringMeeting,
    meetingState,
    rowButtonKind,
    signalCounts,
    signalSummary,
    timeLabel,
    type DayGroup,
    type MeetingEvent,
    type ScheduledBot,
  } from '../lib/meetings-model';
  import type { MeetingBotAction } from '../lib/meetings-store.svelte';
  import '../v4/tokens.css';

  interface Props {
    /** Pre-grouped, chronologically ordered day buckets (see groupByDay). */
    groups: DayGroup[];
    /** Up-next pick — used to mark the "Next" row (hero owns the big card). */
    upNext: MeetingEvent | null;
    /** Total upcoming meetings across all days — shown in the panel header. */
    totalCount: number;
    /** uid -> company display name, for each row's routing subtitle. */
    companyNames?: Map<string, string>;
    /** sourceEventId of the active/live meeting, if any — marks the "Live" row. */
    liveEventId?: string | null;
    /** calendarEventId -> active scheduled bot, drives the per-row action state. */
    botsByEventId?: Map<string, ScheduledBot>;
    /** Full active scheduled-bot list for recurring-series row resolution. */
    scheduledBots?: ScheduledBot[];
    /** Event -> in-flight bot operation. Siblings disable without false busy UI. */
    pendingActionsByEventId?: Map<string, MeetingBotAction>;
    /** Deep-link focus from notification / open_meetings_window. */
    focusedMeetingId?: string | null;
    /** Bot-action callbacks. The store owns the network call; this stays presentational. */
    onInvite?: (evt: MeetingEvent) => void;
    onUninvite?: (evt: MeetingEvent) => void;
    onJoinNow?: (evt: MeetingEvent) => void;
    /** Open a meeting URL in the system browser (Tauri shell open, passed in). */
    onOpenExternal?: (url: string) => void | Promise<void>;
  }

  let {
    groups,
    upNext,
    totalCount,
    companyNames = new Map(),
    liveEventId = null,
    botsByEventId = new Map(),
    scheduledBots = [],
    pendingActionsByEventId = new Map(),
    focusedMeetingId = null,
    onInvite = () => {},
    onUninvite = () => {},
    onJoinNow = () => {},
    onOpenExternal = () => {},
  }: Props = $props();

  const upNextId = $derived(upNext?.id ?? null);
  let openingEventIds = $state(new Set<string>());
  let openingFailures = $state(new Map<string, string>());

  async function openMeeting(eventId: string, url: string): Promise<void> {
    if (openingEventIds.has(eventId)) return;
    if (openingFailures.has(eventId)) {
      const nextFailures = new Map(openingFailures);
      nextFailures.delete(eventId);
      openingFailures = nextFailures;
    }
    openingEventIds = new Set(openingEventIds).add(eventId);
    try {
      await onOpenExternal(url);
    } catch (err) {
      console.error('meetings: failed to open meeting URL', err);
      openingFailures = new Map(openingFailures).set(
        eventId,
        'Couldn’t open this meeting.',
      );
    } finally {
      const next = new Set(openingEventIds);
      next.delete(eventId);
      openingEventIds = next;
    }
  }

  $effect(() => {
    const id = focusedMeetingId?.trim();
    if (!id) return;
    const frame = requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="meeting-row"][data-meeting-id="${CSS.escape(id)}"]`,
      );
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<!-- Naked agenda: hairline day groups, no rounded meeting-card shells. -->
<section class="agenda-panel" aria-labelledby="agenda-title" data-testid="meetings-agenda">
  <div class="panel-header">
    <h2 id="agenda-title">Upcoming</h2>
    <span>{totalCount} meeting{totalCount === 1 ? '' : 's'}</span>
  </div>

  {#each groups as group (group.label)}
    <div class="day-section">
      <h3 class="day-heading">
        <span>{group.label}</span>
        <span class="day-count">{group.events.length}</span>
      </h3>
      <div class="agenda-list">
        {#each group.events as event (event.id)}
          {@const state = meetingState(event, { liveEventId, upNextId })}
          {@const dur = durationLabel(event)}
          {@const sig = signalSummary(signalCounts(event))}
          {@const bot = botForEvent(event, botsByEventId, scheduledBots)}
          {@const pendingAction = pendingActionsByEventId.get(event.id)}
          {@const pending = pendingAction !== undefined}
          {@const invitePending = pendingAction === 'invite'}
          {@const uninvitePending = pendingAction === 'uninvite'}
          {@const joinNowPending = pendingAction === 'join-now'}
          {@const kind = rowButtonKind(bot)}
          {@const attachment = botAttachmentState(bot)}
          {@const url = eventMeetingUrl(event)}
          {@const recurring = isRecurringMeeting(event)}
          <div
            class="meeting-row"
            class:past={state === 'past'}
            class:live={state === 'live'}
            class:next={state === 'next'}
            class:focused={focusedMeetingId === event.id}
            data-bot-state={attachment}
            data-meeting-id={event.id}
            data-testid="meeting-row"
          >
            <div class="mtime">{timeLabel(event)}</div>
            <div class="mmeta">
              <div class="mname">
                {#if state === 'live'}<span class="dot-live" aria-hidden="true">&#9679;</span>{:else if state === 'next'}<span
                    class="arrow-next"
                    aria-hidden="true">&#8593;</span
                  >{/if}
                <span class="meeting-title">{event.summary ?? '(no title)'}</span>
                {#if recurring}
                  <span class="series-chip" title="series" aria-label="series" role="img">
                    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                      <path d="M3.5 4.5h5.8c.95 0 1.7.76 1.7 1.7v.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M8.8 2.8 11 4.5 8.8 6.2" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M10.5 9.5H4.7C3.76 9.5 3 8.74 3 7.8v-.3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M5.2 11.2 3 9.5l2.2-1.7" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </span>
                {/if}
              </div>
              <div class="mcompany">
                {companyLabel(event, companyNames)}{#if dur} · {dur}{/if}
              </div>
              {#if openingFailures.has(event.id) && url}
                <div class="meeting-open-error" role="alert">
                  <span>{openingFailures.get(event.id)}</span>
                  <button
                    type="button"
                    onclick={() => void openMeeting(event.id, url)}
                    disabled={openingEventIds.has(event.id)}
                    aria-busy={openingEventIds.has(event.id)}
                  >
                    {openingEventIds.has(event.id) ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              {/if}
            </div>
            <div class="msig">{sig}</div>
            <div class="mstate">
              {#if state === 'live'}
                <span class="pill live">Live</span>
              {:else if state === 'next'}
                <span class="pill">Next</span>
              {:else if state === 'past'}
                <span class="pill ok"><span class="check" aria-hidden="true">&#10003;</span> Synced</span>
              {:else}
                <span class="pill">Scheduled</span>
              {/if}
            </div>
            <!-- Action cluster: Open (browser) + per-state bot button + join-now.
                 Icon-only; the rich state lives in colour + tooltip so the row
                 stays dense. The store owns the network call — these are pure
                 callbacks, keeping this component presentational. -->
            <div class="mactions detail-primary-actions">
              {#if url}
                <button
                  type="button"
                  class="row-icon-btn row-icon-join"
                  title={openingEventIds.has(event.id) ? 'Opening meeting…' : 'Open meeting in browser'}
                  aria-label="Open meeting in browser"
                  disabled={openingEventIds.has(event.id)}
                  aria-busy={openingEventIds.has(event.id)}
                  onclick={() => void openMeeting(event.id, url)}
                >
                  {#if openingEventIds.has(event.id)}
                    <span class="row-icon-spinner" aria-hidden="true"></span>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M4 2h6v6M10 2L4.5 7.5M2 4v6h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {/if}
                </button>
              {/if}
              {#if !url}
                <span class="row-icon-spacer" aria-hidden="true"></span>
              {:else if kind === 'invite'}
                <button
                  type="button"
                  class="row-icon-btn row-icon-invite"
                  disabled={pending}
                  title={invitePending ? 'Inviting…' : pending ? 'Wait for the current bot action' : recurring ? 'Invite bot to this series' : 'Invite bot to this meeting'}
                  aria-busy={invitePending}
                  aria-label={invitePending ? 'Inviting bot' : recurring ? 'Invite bot to series' : 'Invite bot'}
                  onclick={() => onInvite(event)}
                >
                  {#if invitePending}
                    <span class="row-icon-spinner" aria-hidden="true"></span>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M6 2v8M2 6h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                    </svg>
                  {/if}
                </button>
              {:else if kind === 'invited'}
                <button
                  type="button"
                  class="row-icon-btn row-icon-invited"
                  disabled={pending}
                  title={uninvitePending ? 'Cancelling…' : pending ? 'Wait for the current bot action' : recurring ? 'Bot scheduled for series — click to uninvite series' : 'Bot scheduled — click to uninvite'}
                  aria-busy={uninvitePending}
                  aria-label={uninvitePending ? 'Cancelling bot invitation' : recurring ? 'Uninvite bot from series' : 'Uninvite bot'}
                  onclick={() => onUninvite(event)}
                >
                  {#if uninvitePending}
                    <span class="row-icon-spinner" aria-hidden="true"></span>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  {/if}
                </button>
              {:else if kind === 'in-call'}
                <button
                  type="button"
                  class="row-icon-btn row-icon-incall"
                  disabled={pending}
                  title={uninvitePending ? 'Removing bot…' : pending ? 'Wait for the current bot action' : recurring ? 'Bot is in this series — click to remove from series' : 'Bot is in the meeting — click to remove'}
                  aria-busy={uninvitePending}
                  aria-label={uninvitePending ? 'Removing bot' : recurring ? 'Remove bot from series' : 'Remove bot from meeting'}
                  onclick={() => onUninvite(event)}
                >
                  {#if uninvitePending}
                    <span class="row-icon-spinner" aria-hidden="true"></span>
                  {:else}
                    <span class="live-dot" aria-hidden="true"></span>
                  {/if}
                </button>
              {:else if kind === 'joining'}
                <button
                  type="button"
                  class="row-icon-btn row-icon-joining"
                  disabled={pending}
                  title={uninvitePending ? 'Cancelling…' : pending ? 'Wait for the current bot action' : recurring ? 'Bot is joining this series — click to cancel series' : 'Bot is joining — click to cancel'}
                  aria-busy={uninvitePending}
                  aria-label={uninvitePending ? 'Cancelling bot join' : recurring ? 'Cancel bot series join' : 'Cancel bot join'}
                  onclick={() => onUninvite(event)}
                >
                  <span class="row-icon-spinner row-icon-spinner-amber" aria-hidden="true"></span>
                </button>
              {:else if kind === 'processing'}
                <span class="row-icon-btn row-icon-processing" title="Processing transcript">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                    <circle cx="2.5" cy="6" r="1" />
                    <circle cx="6" cy="6" r="1" />
                    <circle cx="9.5" cy="6" r="1" />
                  </svg>
                </span>
              {:else}
                <span class="row-icon-btn row-icon-done" title="Done — transcript saved">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2.5 6.5L5 9L9.5 3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </span>
              {/if}
              {#if url}
                <button
                  type="button"
                  class="row-icon-btn row-icon-bot-now"
                  disabled={pending}
                  title={joinNowPending ? 'Telling bot to join…' : pending ? 'Wait for the current bot action' : 'Tell bot to join now'}
                  aria-busy={joinNowPending}
                  aria-label={joinNowPending ? 'Telling bot to join now' : 'Tell bot to join now'}
                  onclick={() => onJoinNow(event)}
                >
                  {#if joinNowPending}
                    <span class="row-icon-spinner" aria-hidden="true"></span>
                  {:else}
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <line x1="6" y1="1" x2="6" y2="2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                      <rect x="2" y="3" width="8" height="6.5" rx="1.5" stroke="currentColor" stroke-width="1.4" />
                      <circle cx="4.6" cy="6.5" r="0.7" fill="currentColor" />
                      <circle cx="7.4" cy="6.5" r="0.7" fill="currentColor" />
                    </svg>
                  {/if}
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="agenda-list">
      <div class="meeting-row empty-row">No meetings in your synced calendars yet.</div>
    </div>
  {/each}
</section>

<style>
  .agenda-panel {
    min-width: 0;
    background: transparent;
    border-radius: 0;
  }

  .panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 10px;
  }

  .panel-header h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, 14px);
    font-weight: 600;
    line-height: 18px;
  }

  .panel-header span {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
  }

  .day-section {
    margin-top: 14px;
  }

  .day-section:first-of-type {
    margin-top: 0;
  }

  /* Day separator — uppercase metadata, no card chrome. */
  .day-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 24px;
    margin: 0 0 2px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 14px;
    text-transform: uppercase;
  }

  .day-count {
    font-variant-numeric: tabular-nums;
    letter-spacing: 0;
    text-transform: none;
    font-weight: 500;
  }

  /* Naked list — hairline rows only (no rounded meeting-card shell). */
  .agenda-list {
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  /* `.meeting-row`: 5-col grid — time / name+company / signals / status pill /
     action cluster. The 5th column (`.mactions`) is the parity addition over
     the informational design row: Open + bot state-machine + join-now. */
  .meeting-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto auto auto;
    gap: 12px;
    align-items: center;
    padding: 9px 0;
    border-top: none;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    transition: background-color 140ms ease;
  }

  .meeting-row:last-child {
    border-bottom: none;
  }

  .meeting-row:not(.empty-row):hover {
    background: var(--v4-active-row);
  }

  .meeting-row.past {
    opacity: 0.62;
  }

  .meeting-row.focused {
    background: var(--v4-active-row);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
  }

  .mtime {
    color: var(--v4-text-3);
    font-family: var(--font-mono);
    font-size: var(--type-metadata, 10px);
    white-space: nowrap;
  }

  .mmeta {
    min-width: 0;
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .mname {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, 12px);
    line-height: 16px;
    white-space: nowrap;
  }

  .meeting-title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .series-chip {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 14px;
    color: var(--v4-text-3);
    line-height: 1;
    opacity: 0.76;
  }

  .series-chip svg {
    display: block;
    width: 12px;
    height: 12px;
  }

  .series-chip:hover {
    color: var(--v4-text-2);
    opacity: 1;
  }

  .dot-live {
    margin-right: 2px;
    color: var(--v4-ok);
  }

  .arrow-next {
    margin-right: 2px;
    color: var(--v4-text-2);
  }

  .mcompany {
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 14px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meeting-open-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 2px;
    color: var(--v4-error);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
  }

  .meeting-open-error button {
    padding: 0;
    border: 0;
    background: transparent;
    color: currentColor;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }

  .msig {
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    white-space: nowrap;
  }

  /* Discrete status payloads may keep pill radius. */
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    color: var(--v4-text-3);
    font-size: var(--type-metadata, 10px);
    line-height: 14px;
    white-space: nowrap;
  }

  .pill.ok {
    color: var(--v4-ok);
    border-color: var(--v4-control-border);
  }

  .pill.live {
    color: var(--v4-ok);
    border-color: var(--v4-control-border);
  }

  .pill.live::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-ok);
    box-shadow: none;
    animation: livePulse 2s ease-in-out infinite;
  }

  .pill .check {
    font-size: var(--type-metadata, 10px);
  }

  /* ── Action cluster (parity 5th column) ───────────────────────────────
     Icon-only buttons ported from classic MeetingsWindow.row-actions, with
     base neutrals retoned to the desktop-alt token palette. The status
     colour vocabulary (red live / amber joining / neutral processing / green
     done) is preserved; tooltips carry meaning so icon-only stays a11y-safe. */
  .mactions,
  .detail-primary-actions {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
  }

  .row-icon-btn {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-active-row);
    color: var(--v4-text-2);
    font: inherit;
    font-size: var(--type-body, 12px);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .row-icon-btn:hover:not(:disabled) {
    background: var(--v4-active-row);
    border-color: var(--v4-control-border);
    color: var(--v4-text-1);
  }
  .row-icon-btn:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 1px;
  }
  .row-icon-btn:disabled {
    opacity: 0.6;
    cursor: wait;
  }

  /* No URL — preserve column rhythm without painting a placeholder glyph. */
  .row-icon-spacer {
    flex: 0 0 auto;
    width: 24px;
    height: 24px;
  }
  /* Open-in-browser — discreet so the eye lands on the state button first. */
  .row-icon-join {
    color: var(--v4-text-2);
    background: transparent;
    border-color: var(--v4-hairline);
  }
  /* Invite CTA — brighter so it reads as actionable. */
  .row-icon-invite {
    color: var(--v4-text-1);
    background: var(--v4-control-bg);
    border-color: var(--v4-control-border);
  }
  .row-icon-invite:hover:not(:disabled) {
    background: var(--v4-active-row);
  }
  /* Invited — muted check; hover hints at the uninvite affordance. */
  .row-icon-invited {
    color: var(--v4-text-2);
  }
  .row-icon-invited:hover:not(:disabled) {
    color: var(--v4-error);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
  }
  /* In-call — red tint broadcasts "live" at a glance. */
  .row-icon-incall {
    color: var(--v4-error);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
  }
  .row-icon-incall:hover:not(:disabled) {
    background: var(--v4-active-row);
  }
  /* Joining — quiet transient progress. */
  .row-icon-joining {
    color: var(--v4-text-2);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
  }
  /* Processing — muted neutral; non-interactive. */
  .row-icon-processing {
    color: var(--v4-text-2);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
    cursor: default;
  }
  /* Done — muted green; non-interactive. */
  .row-icon-done {
    color: var(--v4-ok);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
    cursor: default;
  }
  /* Join-now — high-contrast neutral action, distinct from state colours. */
  .row-icon-bot-now {
    color: var(--v4-text-1);
    background: var(--v4-control-faint);
    border-color: var(--v4-control-border);
  }
  .row-icon-bot-now:hover:not(:disabled) {
    background: var(--v4-active-row);
    border-color: var(--v4-control-border);
  }

  .live-dot {
    display: inline-block;
    width: 6px;
    height: 6px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-error);
    box-shadow: 0 0 0 0 var(--v4-error);
    animation: live-pulse 1.6s ease-out infinite;
  }
  @keyframes live-pulse {
    0% {
      box-shadow: 0 0 0 0 var(--v4-error);
    }
    70% {
      box-shadow: 0 0 0 6px transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  /* Inline spinner while a request is pending. 12px box matches the SVG
     icons so the button doesn't resize when state flips. */
  .row-icon-spinner {
    width: 12px;
    height: 12px;
    border-radius: var(--v4-radius-pill);
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    animation: row-icon-spin 0.7s linear infinite;
    opacity: 0.85;
  }
  .row-icon-spinner-amber {
    color: var(--v4-text-2);
  }
  @keyframes row-icon-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .empty-row {
    display: block;
    color: var(--v4-text-2);
    font-size: var(--type-body, 12px);
    line-height: 18px;
    border-bottom: none;
  }

  @keyframes livePulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.45;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .meeting-row {
      transition: none;
    }

    .pill.live::before,
    .live-dot,
    .row-icon-spinner {
      animation: none;
    }

    .row-icon-btn {
      transition: none;
    }
  }

  @media (max-width: 720px) {
    .meeting-row {
      grid-template-columns: 64px minmax(0, 1fr) auto;
      gap: 8px 10px;
    }

    .msig {
      display: none;
    }

    .mstate {
      justify-self: end;
    }

    .mactions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }

  @media (max-width: 520px) {
    .meeting-row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 4px 12px;
    }

    .mtime {
      grid-column: 1;
    }

    .mstate {
      grid-column: 2;
      grid-row: 1;
      justify-self: end;
    }

    .mmeta {
      grid-column: 1 / -1;
    }

    .mactions {
      grid-column: 1 / -1;
      justify-content: flex-start;
      flex: 0 0 auto;
    }
  }
</style>
