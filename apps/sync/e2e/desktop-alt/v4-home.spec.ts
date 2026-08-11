import { describe, expect, it } from 'vitest';
import {
  getConflictCardModel,
  getHomePortfolioStats,
  getHomeProgressModel,
  getHomeTodayAgenda,
  getNeedsYouCount,
  type HomeConflict,
} from '../../src/desktop-alt/v4/home-model';
import { checksPassing } from '../../src/desktop-alt/lib/overview-model';
import type { Project } from '../../src/desktop-alt/lib/projects-model';
import type { MeetingEvent } from '../../src/desktop-alt/lib/meetings-model';
import type { Workspace } from '../../src/lib/workspaces';
import { getV4TitleBarModel } from '../../src/desktop-alt/v4/model';
import { emptyWorkspaceStats } from '../../src/desktop-alt/lib/sync-model';
import { readRepoFile } from './harness';

/**
 * US-003 — V4 Home (healthy / syncing / error states).
 *
 * Source-contract + model harness, matching the existing desktop-alt spec
 * style. Story E2E scenarios:
 *  1. Given an unresolved conflict, when Home renders, then a needs-you card
 *     shows inline Keep mine / Take theirs actions.
 *  2. Given a running sync, when events stream, then per-company rows update
 *     and Cancel is available.
 *  3. US-020 — checks-passing on the Home stat strip (shared formula).
 *  4. US-020 — Today schedule rail hides without accounts/events.
 */

function conflict(overrides: Partial<HomeConflict> = {}): HomeConflict {
  return {
    path: 'policies/slack-channel.md',
    canAutoResolve: false,
    status: 'pending',
    at: Date.now(),
    ...overrides,
  };
}

describe('desktop-alt V4 Home (US-003)', () => {
  it('an unresolved conflict renders a needs-you card with inline Keep mine / Take theirs', () => {
    const pending = [conflict()];
    expect(getNeedsYouCount(pending, null, false)).toBe(1);

    const card = getConflictCardModel(pending[0]);
    expect(card.actions.map((action) => action.label)).toEqual([
      'Keep mine',
      'Take theirs',
      'Compare',
    ]);

    // The card's resolution actions are wired to the real backend commands.
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain("listen<{ path: string; localHash: string; remoteHash: string; canAutoResolve: boolean }>(");
    expect(desktopApp).toContain("await invoke('resolve_conflict', { path, strategy })");
    expect(desktopApp).toContain("invoke('open_in_editor', { path })");

    const homePage = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
    expect(homePage).toContain('<NeedsYouCard');
    expect(homePage).toContain('getConflictCardModel(conflict)');
  });

  it('a running sync streams per-company fanout rows and the title bar offers Cancel', () => {
    // Mid-run snapshot: two companies done, one downloading, two queued.
    const model = getHomeProgressModel({
      filesProgressed: 187,
      totalFiles: 412,
      transferredBytes: 2_201_000,
      progress: { company: 'indigo', path: 'policies/indigo-hq-slack-channel.md', bytes: 1 },
      companies: [
        { uid: 'cmp_1', slug: 'corey-epstein' },
        { uid: 'cmp_2', slug: 'hpo' },
        { uid: 'cmp_3', slug: 'indigo' },
        { uid: 'cmp_4', slug: 'amass' },
        { uid: 'cmp_5', slug: 'keptwork' },
      ],
      statsBySlug: {
        'corey-epstein': { ...emptyWorkspaceStats(), completedFiles: 97 },
        hpo: { ...emptyWorkspaceStats(), completedFiles: 14 },
        indigo: { ...emptyWorkspaceStats(), plannedFiles: 301, progressedFiles: 76 },
      },
      workspaces: [],
    });

    expect(model.headline).toBe('187 of 412 files');
    expect(model.rows.map((row) => row.state)).toEqual(['done', 'done', 'active']);
    expect(model.rows[2].detail).toContain('downloading policies/indigo-hq-slack-channel.md');
    expect(model.queued?.count).toBe(2);

    // A later progress event for the active company updates its row in place.
    const updated = getHomeProgressModel({
      filesProgressed: 190,
      totalFiles: 412,
      transferredBytes: 2_400_000,
      progress: { company: 'indigo', path: 'docs/next.md', bytes: 1 },
      companies: [{ uid: 'cmp_3', slug: 'indigo' }],
      statsBySlug: {
        indigo: { ...emptyWorkspaceStats(), plannedFiles: 301, progressedFiles: 79 },
      },
      workspaces: [],
    });
    expect(updated.rows[0].detail).toBe('downloading docs/next.md · 79 of 301');

    // Title-bar contextual action while syncing is Cancel, wired to cancel_sync.
    const titleBar = getV4TitleBarModel({ syncState: 'syncing', watchedCount: 12 });
    expect(titleBar.action).toEqual({ id: 'cancel', label: 'Cancel' });
    const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    expect(desktopApp).toContain("await invoke('cancel_sync')");
    expect(desktopApp).toContain('oncancel={handleCancelSync}');
  });

  it('file verb lanes are gray text, not colored (story AC)', () => {
    const digest = readRepoFile('src/desktop-alt/v4/ActivityDigest.svelte');
    const verbRule = digest.match(/\.v4-file-verb\s*\{[\s\S]*?\}/)?.[0] ?? '';
    expect(verbRule).toContain('color: var(--v4-text-2)');
    expect(verbRule).not.toMatch(/--v4-(ok|warn|error|unread)/);
  });

  it('sync-halted discipline: Home offers no override/force affordance', () => {
    for (const path of [
      'src/desktop-alt/pages/HomePage.svelte',
      'src/desktop-alt/v4/home-model.ts',
      'src/desktop-alt/v4/NeedsYouCard.svelte',
    ]) {
      const source = readRepoFile(path);
      expect(source).not.toMatch(/sync anyway|force sync|override/i);
    }
  });
});

describe('desktop-alt V4 Home checks-passing + Today rail (US-020)', () => {
  const workspace = (overrides: Partial<Workspace> = {}): Workspace => ({
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_1',
    bucketName: 'bucket',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'member',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  });

  const project = (overrides: Partial<Project> = {}): Project =>
    ({
      id: 'p1',
      title: 'Project',
      name: 'Project',
      description: '',
      company: 'indigo',
      status: '',
      prdPath: '',
      createdAt: null,
      updatedAt: null,
      storiesTotal: 0,
      storiesComplete: 0,
      ...overrides,
    }) as Project;

  it('checks-passing stat matches the shared formula and is omitted at denominator 0', () => {
    const mixed = [
      project({ id: 'a', company: 'indigo', storiesTotal: 4, storiesComplete: 2 }),
      project({ id: 'b', company: 'amass', storiesTotal: 6, storiesComplete: 3 }),
    ];
    const formula = checksPassing(mixed);
    expect(formula).toEqual({ passed: 5, total: 10, percent: 50 });

    const stats = getHomePortfolioStats({
      workspaces: [workspace({ slug: 'indigo' }), workspace({ slug: 'amass' })],
      projects: mixed,
    });
    expect(stats.find((s) => s.label === 'Checks passing')).toEqual({
      label: 'Checks passing',
      value: `${formula!.percent}%`,
    });

    // Denominator 0 → stat absent (never "0%").
    const empty = getHomePortfolioStats({
      workspaces: [workspace()],
      projects: [project({ storiesTotal: 0, storiesComplete: 0 })],
    });
    expect(empty.some((s) => s.label === 'Checks passing')).toBe(false);
    expect(empty.map((s) => s.value).join(' ')).not.toMatch(/0%/);

    // Home reuses overview-model.checksPassing — no local reimplementation.
    const homeModel = readRepoFile('src/desktop-alt/v4/home-model.ts');
    expect(homeModel).toContain("import { checksPassing } from '../lib/overview-model'");
    expect(homeModel).toContain('checksPassing(portfolioProjects)');

    const homePage = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
    expect(homePage).toContain('getHomePortfolioStats');
    expect(homePage).toContain('data-testid="home-stats"');
  });

  it('Today schedule rail owns live fetch and hides without accounts/events', () => {
    // No agenda items → rail must not render empty-state copy.
    const emptyAgenda = getHomeTodayAgenda({
      events: [],
      companyNamesByUid: new Map(),
      now: new Date('2026-06-15T12:00:00'),
    });
    expect(emptyAgenda).toEqual([]);

    const cancelledOnly: MeetingEvent[] = [
      {
        id: 'c1',
        summary: 'Scrubbed',
        start: { dateTime: '2026-06-15T10:00:00' },
        end: { dateTime: '2026-06-15T10:30:00' },
        status: 'cancelled',
      },
    ];
    expect(
      getHomeTodayAgenda({
        events: cancelledOnly,
        companyNamesByUid: new Map(),
        now: new Date('2026-06-15T12:00:00'),
      }),
    ).toEqual([]);

    const rail = readRepoFile('src/desktop-alt/components/TodayScheduleRail.svelte');
    expect(rail).toContain("invoke<GoogleAccount[]>('meetings_list_accounts')");
    expect(rail).toContain("invoke<MeetingEvent[]>('meetings_list_upcoming')");
    expect(rail).toContain('getHomeTodayAgenda');
    expect(rail).toContain('data-testid="today-schedule-rail"');
    // Hide entirely — never "No meetings today."
    expect(rail).not.toMatch(/No meetings today/i);
    expect(rail).toContain('{#if visible}');

    const homePage = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
    expect(homePage).toContain('TodayScheduleRail');
    expect(homePage).toContain('{meetingEvents}');
    expect(homePage).toContain('{companyNamesByUid}');
    expect(homePage).not.toMatch(/No meetings today/i);
    // Grid collapses when the rail component renders nothing.
    expect(homePage).toMatch(/:has\(>\s*:global\(\.home-col-rail\)\)/);
  });
});
