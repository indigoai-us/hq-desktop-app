import { describe, expect, it } from 'vitest';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * Meetings native IA — compact toolbar, Live now → Up next → bot health →
 * day-grouped agenda, naked canvas, preserved actions (alongside the PRD
 * design language from DESKTOP-001/003/011).
 */

describe('Meetings native: compact IA and preserved actions', () => {
  const page = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
  const agenda = readRepoFile('src/desktop-alt/components/MeetingsAgenda.svelte');
  const live = readRepoFile('src/desktop-alt/components/LiveNowCard.svelte');
  const model = readRepoFile('src/desktop-alt/lib/meetings-model.ts');
  const store = readRepoFile('src/desktop-alt/lib/meetings-store.svelte.ts');

  it('uses a compact toolbar without an oversized title block or three summary cards', () => {
    expect(page).toContain('class="page-header meetings-toolbar chat-shell"');
    expect(page).toContain('<h1>Meetings</h1>');
    expect(page).toContain('MEETINGS_PAGE_DEK');
    expect(page).toContain('{toolbarMeta}');
    // Token contract §7: meetings reuses the chan-head pattern — 15px w600
    // title on an inline baseline row (no display-scale grid title block).
    expect(page).toMatch(/\.ph-titles h1\s*\{[\s\S]*?font-size:\s*15px/);
    // No permanent 3-card dashboard (Live/Up next/Signal pool as equal cards).
    expect(page).not.toContain('class="three-col"');
    expect(page).not.toContain('>Signal pool<');
    expect(page).not.toContain('class="sp-stats"');
    // Primary actions stay unshrunk.
    expect(page).toContain('class="actions detail-primary-actions"');
    expect(page).toMatch(
      /\.detail-primary-actions\s*\{[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
    // US-017: Connect calendar + Open calendar + Refresh.
    expect(page).toContain('Connect calendar');
    expect(page).toContain('Open calendar');
    expect(page).toContain("meetingsStore.refresh()");
    expect(page).toContain('data-testid="meetings-agenda-toggle"');
    expect(page).toContain('data-testid="meetings-footer"');
  });

  it('orders Live now, Up next, meeting-bot health, then day-grouped agenda', () => {
    // Prefer the markup usage (not the import line) for MeetingsAgenda order.
    const liveIdx = page.indexOf('<LiveNowCard\n');
    const upNextIdx = page.indexOf('data-testid="meetings-up-next"');
    const botIdx = page.indexOf('data-testid="meetings-bot-health"');
    const agendaIdx = page.lastIndexOf('<MeetingsAgenda');

    expect(liveIdx).toBeGreaterThan(-1);
    expect(upNextIdx).toBeGreaterThan(liveIdx);
    expect(botIdx).toBeGreaterThan(upNextIdx);
    expect(agendaIdx).toBeGreaterThan(botIdx);

    expect(page).toContain('data-testid="meetings-up-next"');
    expect(page).toContain('data-testid="meetings-bot-health"');
    expect(page).toContain('aria-label="Meeting bot status"');
    expect(page).toContain('{botHealthLabel}');
    expect(agenda).toContain('data-testid="meetings-agenda"');
    expect(agenda).toContain('{#each groups as group (group.label)}');
    expect(agenda).toContain('class="day-heading"');
  });

  it('keeps the main canvas naked: hairlines + whitespace, rounded only for live monitor / controls / status', () => {
    // Agenda drops rounded meeting-card shells.
    expect(agenda).toMatch(/\.agenda-list\s*\{[\s\S]*?border-radius:\s*0;/);
    expect(agenda).toMatch(/\.agenda-panel\s*\{[\s\S]*?background:\s*transparent;/);
    expect(agenda).toMatch(
      /\.meeting-row\s*\{[\s\S]*?border-radius:\s*10px/,
    );
    expect(agenda).not.toContain('box-shadow: var(--v4-shadow-card)');
    // Secondary sections are hairline, not raised cards.
    expect(page).toMatch(
      /\.secondary-section\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
    expect(page).toMatch(
      /\.health-strip\s*\{[\s\S]*?border-radius:\s*0;[\s\S]*?background:\s*transparent;/,
    );
    // True live monitor may keep radius when active.
    expect(live).toMatch(
      /\.card\s*\{[\s\S]*?border-radius:\s*var\(--v4-radius-field\)/,
    );
    // Standing-by is calm hairline, not an empty decorative card.
    expect(live).toContain('class="standby"');
    expect(live).toMatch(/\.standby\s*\{[\s\S]*?border-radius:\s*0;/);
    // Status pills / control buttons may keep radius.
    expect(agenda).toMatch(
      /\.pill\s*\{[\s\S]*?border-radius:\s*var\(--v4-radius-pill\)/,
    );
    expect(agenda).toMatch(
      /\.row-icon-btn\s*\{[\s\S]*?border-radius:\s*var\(--v4-radius-button\)/,
    );
  });

  it('uses the five type roles and 3px title/meta slots', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 13,
      secondary: 14,
      body: 15,
      section: 17,
      detail: 24,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);

    expect(page).toContain('--type-secondary');
    expect(page).toContain('--type-body');
    expect(page).toContain('--type-metadata');
    expect(page).toContain('var(--v4-row-stack-gap, 3px)');

    expect(agenda).toMatch(
      /\.mmeta\s*\{[\s\S]*?display:\s*flex/,
    );
    expect(agenda).toContain('--type-section');
    expect(agenda).toContain('--type-body');
    expect(live).toMatch(
      /\.live-copy\s*\{[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
  });

  it('preserves every meeting action and state surface', () => {
    // Calendar + refresh + report pathway.
    expect(page).toContain('Open calendar');
    expect(page).toContain("openExternal('https://calendar.google.com')");
    expect(page).toContain('meetingsStore.refresh()');
    expect(page).toContain('reportRefreshProblem');
    expect(page).toContain('data-testid="meetings-refresh-error"');
    expect(page).toContain('Report a problem');

    // Live recording controls + company attribution.
    expect(page).toContain('onstart={startRecording}');
    expect(page).toContain('onstop={stopRecording}');
    expect(page).toContain('oncompany={setRecordingCompany}');
    expect(live).toContain('Start recording');
    expect(live).toContain('Stop recording');
    expect(live).toContain('Record as');
    expect(live).toContain("onclick={() => onstart(meeting.windowId)}");
    expect(live).toContain("onclick={() => onstop(meeting.windowId)}");

    // Row open / invite / uninvite / join-now + US-017 notetaker toggle.
    expect(agenda).toContain('aria-label="Open meeting in browser"');
    expect(agenda).toContain(
      "aria-label={invitePending ? 'Inviting bot' : recurring ? 'Invite bot to series' : 'Invite bot'}",
    );
    expect(agenda).toContain(
      "aria-label={uninvitePending ? 'Cancelling bot invitation' : recurring ? 'Uninvite bot from series' : 'Uninvite bot'}",
    );
    expect(agenda).toContain(
      "aria-label={joinNowPending ? 'Telling bot to join now' : 'Tell bot to join now'}",
    );
    expect(agenda).toContain('data-testid="meeting-notetaker-toggle"');
    expect(agenda).toContain('aria-busy={invitePending}');
    expect(agenda.match(/aria-busy=\{uninvitePending\}/g)).toHaveLength(3);
    expect(agenda).toContain('aria-busy={joinNowPending}');
    expect(agenda).not.toContain('aria-busy={pending}');
    expect(agenda).toContain('<span class="pill">Scheduled</span>');
    expect(agenda).toContain('<span class="pill live">Live</span>');
    expect(agenda).toContain('class="pill">Next</span>');

    // Store still owns backend commands (no invented endpoints).
    expect(store).toContain("invoke<MeetingEvent[]>('meetings_list_upcoming')");
    expect(store).toContain("invoke<ScheduledBot>('meetings_invite_bot'");
    expect(store).toContain("invoke<CancelBotResult>('meetings_cancel_bot'");
    expect(store).toContain("invoke<ScheduledBot>('meetings_join_bot_now'");

    // Company / source labels + sync empty states.
    expect(page).toContain('companyLabel(upNext, companyNamesByUid)');
    expect(page).toContain('<strong>{row.email}</strong>');
    expect(page).toContain('{row.calendar} -> {row.routingTarget}');
    expect(page).toContain('No calendars connected yet');
    expect(page).toContain('Open HQ Console Integrations');
    expect(agenda).toContain('MEETINGS_UPCOMING_EMPTY');
    expect(agenda).toContain('MEETINGS_PAST_EMPTY');
    expect(page).toContain('data-testid="meetings-feature-hidden"');
  });

  it('keeps waiting states calm and errors explicit without decorative alarms', () => {
    expect(live).toContain('No active meeting window has been detected.');
    expect(live).toContain('class="standby"');
    expect(page).toContain('Nothing scheduled next');
    expect(page).toContain('No bots scheduled');
    // Errors use semantic tokens, not alarm chrome.
    expect(page).toContain('class="error-pill"');
    expect(page).toContain('Refresh issue');
    expect(page).toMatch(/\.error-pill\s*\{[\s\S]*?color:\s*var\(--v4-error\)/);
    expect(page).not.toMatch(/\.error-pill\s*\{[\s\S]*?color:\s*var\(--v4-warn\)/);
    expect(live).toMatch(/\.live-error\s*\{[\s\S]*?color:\s*var\(--v4-error\)/);
    expect(page).not.toContain('🚨');
    expect(page).not.toContain('alarm');
  });

  it('suppresses implausible durations and stays on semantic light/dark tokens', () => {
    expect(model).toContain('export function durationLabel');
    expect(model).toContain("'duration unavailable'");
    expect(model).toContain('MAX_PLAUSIBLE_DURATION_MINUTES');
    expect(agenda).toContain('durationLabel(event)');
    expect(page).toContain('durationLabel(upNext)');
    // Semantic surfaces only — no hard-coded light ink on dark assumptions.
    expect(page).toContain('var(--v4-text-1)');
    expect(page).toContain('var(--v4-text-3)');
    expect(page).toContain('var(--v4-rowline)');
    expect(agenda).toContain('@media (prefers-reduced-motion: reduce)');
    expect(page).toContain('@media (prefers-reduced-motion: reduce)');
    expect(page).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(page).toContain('@media (max-width: 820px)');
  });
});
