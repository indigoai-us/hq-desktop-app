import { describe, expect, it } from 'vitest';
import {
  MEETINGS_PAGE_DEK,
  MEETINGS_PAST_EMPTY,
  formatMeetingsFooterLabel,
  notetakerToggleState,
  partitionUpcomingPast,
} from '../../src/desktop-alt/lib/meetings-view-model';
import type { MeetingEvent, ScheduledBot } from '../../src/desktop-alt/lib/meetings-model';
import {
  buildLibraryNavRows,
  formatNavLabel,
  marketplaceBadgeForListing,
  indexInstalledPacks,
  resolveOverlayTab,
  overlayTabToLibraryTab,
} from '../../src/desktop-alt/chat/library-overlay-model';
import { readRepoFile } from './harness';

/**
 * US-017 — Desktop: Meetings view + Library overlay (salvage).
 *
 * Grep-the-source specs + pure-model behavior tests. Locks meetings redesign
 * (Upcoming|Past, notetaker toggle → invite/cancel paths, footer) and the
 * Library full-screen overlay (tabs, back, marketplace badges).
 */

const now = new Date(2026, 4, 27, 12, 0, 0);

function eventAt(id: string, startLocal: Date, durationMin = 30): MeetingEvent {
  return {
    id,
    status: 'confirmed',
    summary: id,
    start: { dateTime: startLocal.toISOString() },
    end: {
      dateTime: new Date(startLocal.getTime() + durationMin * 60_000).toISOString(),
    },
  };
}

function bot(overrides: Partial<ScheduledBot> = {}): ScheduledBot {
  return {
    botId: 'bot-1',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    platform: 'google_meet',
    status: 'scheduled',
    autoScheduled: true,
    ...overrides,
  };
}

describe('desktop meetings + library overlay (US-017)', () => {
  const page = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
  const agenda = readRepoFile('src/desktop-alt/components/MeetingsAgenda.svelte');
  const store = readRepoFile('src/desktop-alt/lib/meetings-store.svelte.ts');
  const viewModel = readRepoFile('src/desktop-alt/lib/meetings-view-model.ts');
  const overlay = readRepoFile('src/desktop-alt/chat/LibraryOverlay.svelte');
  const overlayModel = readRepoFile('src/desktop-alt/chat/library-overlay-model.ts');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const route = readRepoFile('src/desktop-alt/route.ts');

  it('MeetingsPage exposes redesign chrome: dek, connect, refresh, toggle, footer', () => {
    expect(page).toContain('data-testid="desktop-alt-meetings"');
    expect(page).toContain('data-testid="meetings-feature-hidden"');
    expect(page).toContain('data-testid="meetings-dek"');
    expect(page).toContain('MEETINGS_PAGE_DEK');
    expect(page).toContain('Connect calendar');
    expect(page).toContain('data-testid="meetings-connect-calendar"');
    expect(page).toContain('data-testid="meetings-refresh"');
    expect(page).toContain("meetingsStore.refresh()");
    expect(page).toContain('data-testid="meetings-agenda-toggle"');
    expect(page).toContain('data-testid="meetings-tab-upcoming"');
    expect(page).toContain('data-testid="meetings-tab-past"');
    expect(page).toContain('data-testid="meetings-up-next"');
    expect(page).toContain('data-testid="meetings-footer"');
    expect(page).toContain('data-testid="meetings-manage"');
    expect(page).toContain('formatMeetingsFooterLabel');
    expect(page).toContain('partitionUpcomingPast');
    expect(page).toContain('Paste a Zoom or Google Meet URL');
    expect(page).toContain('No calendars connected yet');
    expect(page).toContain('HQ_CONSOLE_INTEGRATIONS_URL');
  });

  it('notetaker toggle is wired to invite/cancel store paths (no new endpoints)', () => {
    expect(agenda).toContain('data-testid="meeting-notetaker-toggle"');
    expect(agenda).toContain('onclick={() => onInvite(event)}');
    expect(agenda).toContain('onclick={() => onUninvite(event)}');
    expect(page).toContain('meetingsStore.inviteBot');
    expect(page).toContain('meetingsStore.cancelBot');
    expect(store).toContain("invoke<ScheduledBot>('meetings_invite_bot'");
    expect(store).toContain("invoke<CancelBotResult>('meetings_cancel_bot'");
    expect(store).toContain("invoke<MeetingEvent[]>('meetings_list_upcoming')");
    // No invented list-past command.
    expect(store).not.toContain('meetings_list_past');
    expect(viewModel).not.toContain('meetings_list_past');
  });

  it('PRD e2e: given a meeting today, enabling notetaker schedules via invite path', () => {
    // Model: a meeting today with no bot → toggle off / invite.
    const meeting = eventAt('today-standup', new Date(2026, 4, 27, 15, 0, 0));
    const { upcoming } = partitionUpcomingPast([meeting], now);
    expect(upcoming.map((e) => e.id)).toContain('today-standup');

    const off = notetakerToggleState(undefined);
    expect(off.visual).toBe('off');
    expect(off.action).toBe('invite');

    // After schedule: store paints scheduled bot → toggle on / cancel.
    const on = notetakerToggleState(
      bot({ status: 'scheduled', calendarEventId: 'today-standup' }),
    );
    expect(on.visual).toBe('on');
    expect(on.action).toBe('cancel');

    // Source contract: invite path is the existing store method + Rust command.
    expect(page).toContain('async function onInvite');
    expect(page).toContain('meetingsStore.inviteBot(evt)');
    expect(store).toContain("invoke<ScheduledBot>('meetings_invite_bot'");
  });

  it('pure model: past empty, footer label, dek constants', () => {
    expect(MEETINGS_PAGE_DEK).toBe('agenda, notetaker, and recaps');
    expect(MEETINGS_PAST_EMPTY).toBe('No past meetings yet');
    const { past } = partitionUpcomingPast(
      [eventAt('future', new Date(2026, 4, 28, 10, 0, 0))],
      now,
    );
    expect(past).toEqual([]);
    expect(
      formatMeetingsFooterLabel({
        calendarCount: 3,
        lastSyncedAt: new Date(now.getTime() - 120_000),
        now,
      }),
    ).toBe('3 CALENDARS CONNECTED · LAST SYNCED 2m ago');
  });

  it('DesktopApp mounts LibraryOverlay for library route (not LibraryPage + secondary)', () => {
    expect(desktopApp).toContain("import LibraryOverlay from './chat/LibraryOverlay.svelte'");
    expect(desktopApp).toContain('<LibraryOverlay');
    expect(desktopApp).toContain('data-testid="library-overlay-host"');
    expect(desktopApp).toContain('onback={exitLibrary}');
    expect(desktopApp).toContain('routeBeforeLibrary');
    expect(desktopApp).not.toContain("import LibraryPage from './pages/LibraryPage.svelte'");
    expect(route).toContain("'library'");
    expect(route).toMatch(/if \(route\.kind === 'library'\) \{\s*return null;/);
  });

  it('Library overlay exposes back, nav tabs, search, marketplace badges', () => {
    expect(overlay).toContain('data-testid="library-overlay"');
    expect(overlay).toContain('data-testid="library-back"');
    expect(overlay).toContain('data-testid="library-overlay-nav"');
    expect(overlay).toContain('data-testid="library-overlay-search"');
    expect(overlay).toContain('data-testid="library-skills-panel"');
    expect(overlay).toContain('data-testid="library-workers-panel"');
    expect(overlay).toContain('data-testid="library-marketplace-panel"');
    expect(overlay).toContain('data-testid="library-pack-get"');
    expect(overlay).toContain('data-testid="library-pack-badge"');
    expect(overlay).toContain('loadLibraryRoot');
    expect(overlay).toContain('loadMarketplaceListings');
    expect(overlay).toContain('installMarketplacePack');
    expect(overlay).toContain("invoke<PackagesView>('list_packages')");
    expect(overlayModel).toContain('export function marketplaceBadgeForListing');
    expect(overlayModel).toContain('export function buildLibraryNavRows');
  });

  it('pure model: nav counts, tab mapping, marketplace badges', () => {
    const rows = buildLibraryNavRows({
      skills: [
        {
          name: 'A',
          description: '',
          scope: 'root',
          path: 'a',
          allowedTools: [],
        },
      ],
      workers: [],
    });
    expect(rows.map((r) => formatNavLabel(r))).toEqual([
      'Skills 1',
      'Workers 0',
      'Marketplace',
    ]);
    expect(resolveOverlayTab('installed')).toBe('marketplace');
    expect(overlayTabToLibraryTab('marketplace')).toBe('installed');

    const index = indexInstalledPacks([
      { name: 'engineering', updateAvailable: false },
      { name: 'gstack', updateAvailable: true },
    ]);
    expect(
      marketplaceBadgeForListing({ slug: 'engineering', name: 'engineering' }, index),
    ).toBe('installed');
    expect(marketplaceBadgeForListing({ slug: 'gstack', name: 'gstack' }, index)).toBe(
      'update',
    );
    expect(marketplaceBadgeForListing({ slug: 'new-pack', name: 'new-pack' }, index)).toBe(
      'get',
    );
  });

  it('⌘4 and command palette still resolve library kind', () => {
    expect(route).toContain("if (event.key === '4') return { kind: 'library' }");
    expect(desktopApp).toContain("id: 'command-go-library'");
    expect(desktopApp).toContain("openLibrary({ kind: 'library' })");
  });
});
