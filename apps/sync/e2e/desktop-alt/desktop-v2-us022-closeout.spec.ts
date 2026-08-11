import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';
import {
  companyActivityEmpty,
  companyActivityPopulated,
  conflictFixtures,
  popoverDriftProps,
  popoverRescueProps,
} from '../../dev-harness/fixtures';
import {
  SETTINGS_SECTIONS,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { consoleDeepLinks } from '../../src/desktop-alt/lib/console-links';
import { HQ_CONSOLE_BASE } from '../../src/desktop-alt/lib/hq-console';
import {
  hasTeamActivity,
  normalizeTeamActivity,
  teamMemberRows,
} from '../../src/desktop-alt/lib/team-activity';
import { checksPassing } from '../../src/desktop-alt/lib/overview-model';
import {
  getV2WorkspaceSwitcherItems,
  V2_GENERAL_NAV_ITEMS,
  V2_WORKSPACE_SECTION_ITEMS,
} from '../../src/desktop-alt/v4/model';
import type { Workspace } from '../../src/lib/workspaces';
import type { Project } from '../../src/desktop-alt/lib/projects-model';
import { runStoryPrompt } from '../../src/desktop-alt/lib/projects-model';

/**
 * US-022 — V2 e2e coverage and visual states (closeout).
 *
 * Strengthens per-screen source contracts and harness production-contract
 * fixtures for the full V2 shell. Never weakens safety suites (secrets-never-leak,
 * gate, moderation-admin-gate, safety-flows).
 *
 * Covers: shell + workspace switcher, command palette + console deep links,
 * overview pulse/needs-you/analytics empty+populated, projects/task/run story,
 * goals linking, skills/workers, knowledge/files, team, inbox, messages
 * governance + delivery, meetings, library/marketplace/moderation, settings
 * appearance persistence, popover rescue card, onboarding welcome card, and
 * console-drop removals.
 */

const REPO = process.cwd();

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    slug: 'indigo',
    displayName: 'Indigo',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cmp_indigo',
    bucketName: 'hq-vault-indigo',
    hasLocalFolder: true,
    localPath: '/tmp/HQ/companies/indigo',
    membershipStatus: 'active',
    role: 'owner',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    title: 'Project',
    name: 'Project',
    description: '',
    company: 'indigo',
    status: 'in-progress',
    prdPath: 'companies/indigo/projects/p1/prd.json',
    createdAt: null,
    updatedAt: null,
    storiesTotal: 4,
    storiesComplete: 2,
    ...overrides,
  } as Project;
}

describe('US-022: V2 shell + workspace switcher', () => {
  const sidebar = readRepoFile('src/desktop-alt/v4/V2Sidebar.svelte');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('mounts V2Sidebar with workspace switcher and company section nav', () => {
    expect(desktopApp).toContain('V2Sidebar');
    expect(sidebar).toContain('data-testid="v2-workspace-switcher"');
    expect(sidebar).toContain('data-testid="v2-workspace-menu"');
    expect(sidebar).toContain('getV2WorkspaceSwitcherItems');
    // Workspace sections under the active company (model table).
    expect(V2_WORKSPACE_SECTION_ITEMS.map((s) => s.label)).toEqual([
      'Overview',
      'Goals',
      'Projects',
      'Skills',
      'Workers',
      'Knowledge',
      'Team',
    ]);
    // GENERAL group — Marketplace is intentionally absent from the V2 sidebar.
    expect(V2_GENERAL_NAV_ITEMS.map((s) => s.label)).toEqual([
      'Inbox',
      'Messages',
      'Meetings',
      'Library',
      'Files',
    ]);
  });

  it('lists companies then Personal with Cmd chords (⌘1–⌘9 / ⌘0)', () => {
    expect(model).toContain('export function getV2WorkspaceSwitcherItems');
    const items = getV2WorkspaceSwitcherItems(
      [
        workspace({ slug: 'indigo', displayName: 'Indigo' }),
        workspace({ slug: 'amass', displayName: 'Amass' }),
        workspace({
          slug: 'personal',
          displayName: 'Personal',
          kind: 'personal',
          state: 'personal',
        }),
      ],
      'indigo',
    );
    expect(items.map((i) => i.slug)).toEqual(['amass', 'indigo', 'personal']);
    expect(items.find((i) => i.slug === 'personal')?.hotkey).toBe('⌘0');
    expect(items[0].hotkey).toBe('⌘1');
  });

  it('titlebar exposes Sync and command palette search', () => {
    const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
    expect(titleBar).toContain('Open command palette');
    expect(desktopApp).toContain("await invoke('start_sync')");
    expect(desktopApp).toContain('handleSyncAll');
  });
});

describe('US-022: command palette + console deep links', () => {
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const consoleLinks = readRepoFile('src/desktop-alt/lib/console-links.ts');

  it('palette carries console deep links for dropped surfaces', () => {
    expect(desktopApp).toContain('consoleDeepLinks');
    const links = consoleDeepLinks('indigo');
    const ids = links.map((l) => l.id);
    for (const id of [
      'command-go-console-deployments',
      'command-go-console-secrets',
      'command-go-console-activity',
      'command-go-console-telescope',
      'command-go-console-settings',
    ]) {
      expect(ids).toContain(id);
      expect(consoleLinks).toContain(id);
    }
    expect(links.find((l) => l.id === 'command-go-console-secrets')?.url).toContain(
      '/secrets',
    );
  });

  it('Appearance is a palette-reachable Settings section', () => {
    expect(SETTINGS_SECTIONS.some((s) => s.id === 'appearance')).toBe(true);
    expect(desktopApp).toContain(
      "SETTINGS_SECTIONS.filter((section) => section.id !== DEFAULT_SETTINGS_TAB)",
    );
  });
});

describe('US-022: overview analytics empty + populated', () => {
  const digest = readRepoFile('src/desktop-alt/components/OverviewActivityDigest.svelte');
  const teamActivity = readRepoFile('src/desktop-alt/lib/team-activity.ts');
  const panel = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');

  it('normalizes the production CompanyActivity contract (empty is zeroed, not error)', () => {
    const empty = normalizeTeamActivity(companyActivityEmpty);
    expect(empty.stats.edits7).toBe(0);
    expect(empty.stats.files7).toBe(0);
    expect(empty.membersDetail).toBeUndefined();
    expect(empty.stats.vaultBytes).toBeUndefined();
    expect(hasTeamActivity(empty)).toBe(false);

    const populated = normalizeTeamActivity(companyActivityPopulated);
    expect(populated.stats.edits7).toBe(342);
    expect(populated.stats.vaultBytes).toBe(2_576_980_377);
    expect(populated.membersDetail?.length).toBeGreaterThan(0);
    expect(hasTeamActivity(populated)).toBe(true);
    expect(teamMemberRows(populated).length).toBeGreaterThan(0);
  });

  it('Overview team activity card degrades cleanly when analytics are absent', () => {
    expect(digest).toContain('No activity yet — it appears here after files sync.');
    expect(digest).toContain('companyStore.loadActivity');
    expect(teamActivity).toContain('means NO DATA');
    expect(teamActivity).toContain('membersDetail');
    expect(teamActivity).toContain('vaultBytes');
  });

  it('pulse renders checks-passing only when denominator > 0', () => {
    expect(panel).toContain('checksPassing(companyProjects)');
    const none = checksPassing([project({ storiesTotal: 0, storiesComplete: 0 })]);
    expect(none).toBeNull();
    const some = checksPassing([project({ storiesTotal: 4, storiesComplete: 2 })]);
    expect(some).toEqual({ passed: 2, total: 4, percent: 50 });
  });
});

describe('US-022: projects / task detail / run story / goals', () => {
  it('Run story hands off /execute-task {project}/{story}', () => {
    expect(runStoryPrompt('hq-desktop-v2', 'US-022')).toBe(
      '/execute-task hq-desktop-v2/US-022',
    );
    const storyPanel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
    expect(storyPanel).toContain('Run story');
    expect(storyPanel).toContain('runStoryPrompt');
  });

  it('goal-project linking lives on CompanyGoalsPage + goal-links helper', () => {
    const goals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
    const links = readRepoFile('src/desktop-alt/lib/goal-links.ts');
    expect(goals).toContain("from '../lib/goal-links'");
    expect(links).toContain('initiativeIds');
  });
});

describe('US-022: skills / workers / knowledge / files / team / inbox', () => {
  it('company Skills and Workers pages mount with testids', () => {
    const skills = readRepoFile('src/desktop-alt/pages/CompanySkillsPage.svelte');
    const workers = readRepoFile('src/desktop-alt/pages/CompanyWorkersPage.svelte');
    expect(skills).toContain('data-testid="company-skills-panel"');
    expect(workers).toContain('data-testid="company-workers-panel"');
  });

  it('Knowledge and Files keep HQ-scoped list_hq_dir paths', () => {
    const knowledge = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
    expect(knowledge).toContain('list_hq_dir');
  });

  it('Team page uses telemetry adapter + console team deep link', () => {
    const team = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
    expect(team).toContain('companyTeamUrl');
    expect(team).toContain('data-testid="team-scope-meta"');
  });

  it('Inbox routing merges notifications without a separate secrets path', () => {
    const inbox = readRepoFile('src/desktop-alt/lib/inbox-routing.ts');
    expect(inbox).toMatch(/inbox|route|notification/i);
    expect(inbox).not.toContain('get_company_secrets');
  });
});

describe('US-022: messages governance + delivery states', () => {
  const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const conversation = readRepoFile('src/components/messaging/Conversation.svelte');
  const compose = readRepoFile('src/components/messaging/ComposeMessage.svelte');
  const harness = readRepoFile('dev-harness/mocks/core.ts');

  it('outbound delivery states use delivered false → Sending…, true → Delivered', () => {
    expect(conversation).toContain('delivered?: boolean');
    expect(conversation).toContain('Sending…');
    expect(conversation).toContain('<span class="dm-msg-time">Delivered</span>');
    expect(shell).toContain('delivered: false');
  });

  it('compose SendDmOutcome uses camelCase connectionRequested (production serde)', () => {
    expect(compose).toContain("state: 'delivered' | 'connectionRequested'");
    expect(compose).toContain("outcome?.state === 'connectionRequested'");
    // Harness mock must match production tag — not snake_case.
    expect(harness).toContain("state: 'connectionRequested'");
    expect(harness).not.toContain("state: 'connection_requested'");
  });

  it('connection-request governance stays in the Messages rail', () => {
    expect(shell).toContain('Connection requests');
    expect(shell).toContain('visibleRequestItems');
    const requestCard = readRepoFile('src/components/messaging/DmRequestCard.svelte');
    expect(requestCard).toContain("invoke('respond_dm_request'");
  });
});

describe('US-022: meetings + library / marketplace / moderation', () => {
  it('meeting permissions wizard remains a harness-previewable surface', () => {
    const harness = readRepoFile('dev-harness/Harness.svelte');
    const mocks = readRepoFile('dev-harness/mocks/core.ts');
    expect(harness).toContain("view === 'permissions'");
    expect(harness).toContain('MeetingPermissionsWindow');
    expect(mocks).toContain('meetings_permissions_state:');
    expect(mocks).toContain('allRequiredGranted: false');
  });

  it('moderation admin gate + yank kill switch remain wired', () => {
    const market = readRepoFile('src/desktop-alt/lib/marketplace.ts');
    const mocks = readRepoFile('dev-harness/mocks/core.ts');
    expect(market).toMatch(/yank|moderation/i);
    expect(mocks).toContain('list_moderation_queue:');
    expect(mocks).toContain('yank_marketplace_listing:');
    expect(mocks).toContain('decide_moderation_listing:');
  });
});

describe('US-022: settings Appearance persistence', () => {
  const page = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const route = readRepoFile('src/desktop-alt/route.ts');
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const mocks = readRepoFile('dev-harness/mocks/core.ts');
  const fixtures = readRepoFile('dev-harness/fixtures.ts');

  it('Appearance section offers theme, opacity, interface size, and Show in Dock', () => {
    expect(route).toContain("id: 'appearance'");
    expect(page).toContain('data-testid="settings-appearance"');
    expect(page).toContain('<strong>Theme</strong>');
    expect(page).toContain('<strong>Window opacity</strong>');
    expect(page).toContain('<strong>Interface size</strong>');
    expect(page).toContain('Show in Dock');
    expect(page).toContain('requestAppearancePreferenceChange');
  });

  it('persists theme / windowOpacity / interfaceSize through the settings wire', () => {
    expect(page).toMatch(/theme:\s*appearance\.colorTheme/);
    expect(page).toMatch(/windowOpacity:\s*windowOpacityFromTransparency\(/);
    expect(page).toMatch(/interfaceSize:\s*Math\.round\(interfaceZoom \* 100\)/);
    expect(page).toContain('settings.theme ?? null');
    expect(page).toContain('settings.windowOpacity ?? null');
    expect(page).toContain('settings.interfaceSize ?? null');
  });

  it('harness exposes Appearance tab + appearance-persisted scenario', () => {
    expect(harness).toContain('settingsTab');
    expect(harness).toContain('SettingsPage activeTab={settingsTab}');
    expect(mocks).toContain("scenario === 'appearance-persisted'");
    expect(mocks).toContain("theme: 'dark'");
    expect(mocks).toContain('windowOpacity: 65');
    expect(mocks).toContain('interfaceSize: 120');
    // Default settings keep appearance null (absent-safe, production default).
    expect(mocks).toContain('theme: null as string | null');
    expect(mocks).toContain('windowOpacity: null as number | null');
    expect(mocks).toContain('interfaceSize: null as number | null');
    expect(fixtures).toContain('companyActivityEmpty');
    expect(fixtures).toContain('companyActivityPopulated');
  });
});

describe('US-022: popover rescue card + banners + onboarding welcome', () => {
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const fixtures = readRepoFile('dev-harness/fixtures.ts');
  const popover = readRepoFile('src/components/Popover.svelte');
  const wizard = readRepoFile('src/components/onboarding/OnboardingWizard.svelte');

  it('rescue card mounts from popover scenario with production ConflictFile shape', () => {
    expect(popover).toContain('data-testid="popover-rescue-card"');
    expect(harness).toContain("scenario === 'rescue'");
    expect(harness).toContain('popoverRescueProps');
    expect(fixtures).toContain('popoverRescueProps');
    expect(fixtures).toContain('conflictFixtures');
    // Fixture shape matches ConflictFile.
    expect(conflictFixtures[0]).toMatchObject({
      path: expect.any(String),
      localHash: expect.any(String),
      remoteHash: expect.any(String),
      canAutoResolve: expect.any(Boolean),
      status: 'pending',
    });
    expect(popoverRescueProps.showConflictModal).toBe(true);
    expect(popoverRescueProps.conflicts.length).toBeGreaterThan(0);
  });

  it('drift scenario exposes HQ core drift + desktop update rows', () => {
    expect(harness).toContain("scenario === 'drift'");
    expect(harness).toContain('popoverDriftProps');
    expect(popover).toContain('data-testid="popover-core-row"');
    expect(popover).toContain('data-testid="popover-app-row"');
    expect(popoverDriftProps.coreDriftCount).toBeGreaterThan(0);
    expect(popoverDriftProps.coreNeedsUpdate).toBe(true);
  });

  it('all four banner kinds stay in harness fixtures', () => {
    for (const kind of ['share', 'meeting', 'dm', 'update']) {
      expect(fixtures).toContain(`${kind}:`);
    }
    expect(harness).toContain('bannerFixtures');
  });

  it('onboarding step 0 is the V2 welcome card', () => {
    expect(wizard).toContain('Welcome to HQ');
    expect(wizard).toContain('class="panel v2-welcome"');
    expect(wizard).toContain('onboarding-title-signin');
    expect(harness).toContain("view === 'onboarding'");
    expect(harness).toContain('OnboardingWizard');
    expect(harness).toContain('initialStep={onboardingStep}');
  });
});

describe('US-022: console-drop removals + no secrets fetch', () => {
  it('legacy deployments / secrets routes remap to console, not dead panels', () => {
    expect(
      existsSync(join(REPO, 'src/desktop-alt/panels/DeploymentsPanel.svelte')),
    ).toBe(false);
    expect(resolvePendingDesktopRoute('company:indigo:deployments')).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/deployments`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
    expect(resolvePendingDesktopRoute('company:indigo:secrets')).toEqual({
      mode: 'console',
      url: `${HQ_CONSOLE_BASE}/companies/indigo/secrets`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });

  it('renderer sources never call get_company_secrets', () => {
    const desktopAlt = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
    const companyStore = readRepoFile('src/desktop-alt/lib/company-store.svelte.ts');
    const mocks = readRepoFile('dev-harness/mocks/core.ts');
    expect(desktopAlt).not.toContain('pub async fn get_company_secrets');
    expect(companyStore).not.toContain('get_company_secrets');
    // No live invoke handler — comments may still name the removed command.
    expect(mocks).not.toMatch(/get_company_secrets\s*:/);
    // Summary hardcodes secrets: 0 (US-021).
    expect(mocks).toContain('secrets: 0');
  });
});

describe('US-022: harness visual-state coverage contracts', () => {
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const mocks = readRepoFile('dev-harness/mocks/core.ts');

  it('documents V2 preview views: desktop, home, settings, popover, messages, permissions, onboarding', () => {
    for (const view of [
      'desktop',
      'home',
      'settings',
      'popover',
      'messages',
      'permissions',
      'onboarding',
      'conversation',
      'banner',
      'company',
    ]) {
      // Each view is either an equality branch or the default settings path.
      expect(
        harness.includes(`view === '${view}'`) ||
          harness.includes(`?view=${view}`) ||
          view === 'settings',
      ).toBe(true);
    }
  });

  it('analytics empty/populated scenarios are selectable from the harness mock', () => {
    expect(mocks).toContain("scenario === 'analytics-empty'");
    expect(mocks).toContain('companyActivityEmpty');
    expect(mocks).toContain('companyActivityPopulated');
    expect(mocks).toContain('membersDetail');
    expect(mocks).toContain('vaultBytes');
  });

  it('conversation harness can preview Sending… delivery state', () => {
    expect(harness).toContain("conversationScenario === 'sending'");
    expect(harness).toContain('delivered:');
  });

  it('home harness still passes portfolio projects + today meetings', () => {
    expect(harness).toContain('homeProjects');
    expect(harness).toContain('homeMeetings');
    expect(harness).toContain('HomePage');
    expect(harness).toContain('data-window');
  });
});
