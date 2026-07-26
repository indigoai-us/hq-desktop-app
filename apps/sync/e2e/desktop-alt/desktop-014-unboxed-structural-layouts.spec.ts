import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

function rules(source: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return Array.from(
    source.matchAll(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`, 'g')),
    (match) => match[1] ?? '',
  );
}

function expectOpenRule(block: string, label: string): void {
  expect(block, `${label} selector should exist`).not.toBe('');
  expect(block, `${label} still has a closed perimeter`).toMatch(/\bborder:\s*(?:0|none)\s*;/);
  expect(block, `${label} still paints a raised structural fill`).toContain(
    'background: transparent',
  );
  expect(block, `${label} still has structural rounding`).toMatch(
    /border-radius:\s*0(?:px)?\s*;/,
  );
}

function expectOpenStructure(
  source: string,
  selector: string,
  label: string,
): void {
  expectOpenRule(rule(source, selector), label);
}

function expectEveryOpenStructure(
  source: string,
  selector: string,
  label: string,
): void {
  const blocks = rules(source, selector);
  expect(blocks, `${label} selector should exist`).not.toHaveLength(0);
  blocks.forEach((block, index) => {
    expectOpenRule(block, `${label} rule ${index + 1}`);
  });
}

describe('DESKTOP-014: unboxed structural layouts', () => {
  const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const missionControl = readRepoFile('src/desktop-alt/pages/MissionControlPage.svelte');
  const agencyTeams = readRepoFile(
    'src/desktop-alt/panels/AgencyTeamsPanel.svelte',
  );
  const agencyChat = readRepoFile('src/desktop-alt/panels/AgencyChatPanel.svelte');
  const companyBoard = readRepoFile(
    'src/desktop-alt/panels/CompanyBoardPanel.svelte',
  );
  const overviewDigest = readRepoFile(
    'src/desktop-alt/components/OverviewActivityDigest.svelte',
  );
  const companyGoals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
  const projectDetail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const companyKnowledge = readRepoFile(
    'src/desktop-alt/panels/CompanyKnowledgePanel.svelte',
  );
  const companyOperations = readRepoFile(
    'src/desktop-alt/panels/CompanyOperationsPanel.svelte',
  );
  const team = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
  const activity = readRepoFile('src/desktop-alt/panels/ActivityPanel.svelte');
  const statTile = readRepoFile('src/desktop-alt/components/StatTile.svelte');
  const deployments = readRepoFile(
    'src/desktop-alt/panels/DeploymentsPanel.svelte',
  );
  const secrets = readRepoFile('src/desktop-alt/panels/SecretsPanel.svelte');
  const profile = readRepoFile('src/desktop-alt/panels/ProfilePanel.svelte');
  const submit = readRepoFile('src/desktop-alt/panels/SubmitPanel.svelte');
  const marketplace = readRepoFile(
    'src/desktop-alt/panels/MarketplacePanel.svelte',
  );
  const installedPacks = readRepoFile(
    'src/desktop-alt/panels/InstalledPacksPanel.svelte',
  );
  const companyProjects = readRepoFile(
    'src/desktop-alt/pages/CompanyProjectsPage.svelte',
  );
  const companyLibrary = readRepoFile(
    'src/desktop-alt/panels/CompanyLibraryPanel.svelte',
  );
  const libraryList = readRepoFile('src/desktop-alt/components/LibraryList.svelte');
  const storyList = readRepoFile('src/desktop-alt/components/StoryList.svelte');
  const storyPanel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const activityDigest = readRepoFile('src/desktop-alt/v4/ActivityDigest.svelte');
  const meetings = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
  const liveSessions = readRepoFile(
    'src/desktop-alt/panels/LiveSessionsPanel.svelte',
  );
  const libraryBrowser = readRepoFile(
    'src/desktop-alt/components/LibraryBrowser.svelte',
  );
  const storyKanban = readRepoFile(
    'src/desktop-alt/components/StoryKanban.svelte',
  );
  const sessionHistory = readRepoFile(
    'src/desktop-alt/panels/SessionHistoryPanel.svelte',
  );
  const projectList = readRepoFile(
    'src/desktop-alt/components/ProjectListView.svelte',
  );
  const libraryDetail = readRepoFile(
    'src/desktop-alt/components/LibraryDetailPanel.svelte',
  );
  const sidebarSyncMode = readRepoFile(
    'src/desktop-alt/v4/SidebarSyncMode.svelte',
  );
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const popoverCss = readRepoFile('src/styles/popover.css');
  const accountView = readRepoFile('src/lib/crm/AccountView.svelte');

  it('uses open settings groups while preserving row and notice semantics', () => {
    expectOpenStructure(settings, '.settings-card', 'settings groups');
    expect(rule(settings, '.setting-row')).toContain(
      'border-top: 1px solid var(--v4-rowline)',
    );

    const notice = rule(settings, '.notice-card');
    expect(notice).toContain('border-top: 1px solid var(--v4-rowline)');
    expect(notice).not.toContain('border-left:');
    expect(notice).toContain('background: transparent');
  });

  it('opens mission-control sections and separates them with single rules', () => {
    expectOpenStructure(missionControl, '.mc-col', 'mission-control sections');
    expect(rule(missionControl, '.mc-col.mc-agency-q')).toContain('padding-right:');
    expect(rule(missionControl, '.mc-col.mc-agency-t')).toContain('border-left:');
    expect(rule(missionControl, '.mc-col-history')).toContain('border-left:');
    expect(rule(missionControl, '.mc-col.mc-agency-chat')).toContain('border-top:');

    expectOpenStructure(agencyChat, '.thread', 'agency conversation thread');
    expect(rule(agencyChat, '.thread')).toContain('border-top:');

    expectOpenStructure(agencyTeams, '.team', 'agency team section');
    expect(rule(agencyTeams, '.team')).toContain('box-shadow: none');
    expect(rule(agencyTeams, '.teams')).toContain('gap: 0');
    expect(rule(agencyTeams, '.team + .team')).toContain('border-top:');
    expectOpenStructure(agencyTeams, '.count', 'agency team count');
  });

  it('keeps list-detail workspaces open while retaining their internal splits', () => {
    for (const [source, selector, label] of [
      [companyGoals, '.goals-workspace', 'goals workspace'],
      [projectDetail, '.task-workspace', 'task workspace'],
      [projectDetail, '.files-layout', 'files workspace'],
      [
        companyKnowledge,
        '.company-knowledge-panel,\n  .knowledge-workspace',
        'knowledge workspace',
      ],
      [companyOperations, '.operations-workspace', 'operations workspace'],
      [team, '.team-workspace', 'team workspace'],
    ] as const) {
      expectOpenStructure(source, selector, label);
    }

    expect(rule(companyGoals, '.goals-list-pane')).toContain('border-right:');
    expect(rule(projectDetail, '.project-task-rail')).toContain('border-right:');
    expect(rule(projectDetail, '.files-tree')).toContain('border-right:');
    expect(rule(companyKnowledge, '.knowledge-tree-pane')).toContain('border-right:');
    expect(rule(companyOperations, '.ops-nav-pane')).toContain('border-right:');
    expect(rule(team, '.team-list-pane')).toContain('border-right:');
  });

  it('keeps Meetings status feedback open instead of wrapping it in a rounded notice box', () => {
    expectOpenStructure(meetings, '.toast', 'meeting status');
    expect(rule(meetings, '.toast')).toContain('border-top:');
  });

  it('uses open operational sections with only header and row dividers', () => {
    for (const [source, selector, label] of [
      [activity, '.activity-card', 'activity section'],
      [deployments, '.deployments-card', 'deployments section'],
      [secrets, '.secrets-card', 'secrets section'],
      [companyOperations, '.ops-settings-list', 'operations settings list'],
    ] as const) {
      expectOpenStructure(source, selector, label);
      expect(rule(source, selector), `${label} needs a single section divider`).toContain(
        'border-top:',
      );
    }
  });

  it('keeps summary monitors and inline status selectors free of enclosing tracks', () => {
    for (const [source, selector, label] of [
      [companyBoard, '.pulse-row', 'company pulse summary'],
      [overviewDigest, '.digest-monitor', 'activity digest monitor'],
      [titleBar, '.v4-status', 'title-bar status'],
      [sidebarSyncMode, '.sidebar-sync-mode', 'sidebar sync selector'],
      [storyPanel, '.status-control', 'task status selector'],
    ] as const) {
      expectOpenStructure(source, selector, label);
    }

    for (const [source, selector, activeSelector, baseSelector, label] of [
      [
        sidebarSyncMode,
        '.sidebar-sync-mode-opt',
        '.sidebar-sync-mode-opt.active',
        '.sidebar-sync-mode-opt',
        'sidebar sync option',
      ],
      [
        storyPanel,
        '.status-control button',
        '.status-control button.active',
        '.status-control button,\n  .panel-footer button',
        'task status option',
      ],
    ] as const) {
      const option = rule(source, selector);
      expect(option, `${label} selector should exist`).not.toBe('');
      expect(option).toContain('border-bottom: 1px solid transparent');
      expect(option).toContain('border-radius: 0');
      expect(rule(source, baseSelector)).toContain('background: transparent');
      expect(rule(source, activeSelector)).toContain('border-bottom-color:');
      expect(rule(source, activeSelector)).toContain('background: transparent');
    }
  });

  it('renders summary and KPI groups as open data strips with responsive dividers', () => {
    expectOpenStructure(missionControl, '.mc-tile', 'mission-control summary metric');
    expect(rule(missionControl, '.mc-summary')).toContain('gap: 0');
    expect(rule(missionControl, '.mc-tile + .mc-tile')).toContain('border-left:');
    expect(rule(missionControl, '.mc-tile:nth-child(n + 3)')).toContain('border-top:');

    expectOpenStructure(statTile, '.stat-tile', 'activity summary metric');
    expect(rule(activity, '.stats-grid')).toContain('gap: 0');
    expect(
      rule(activity, '.stats-grid :global(.stat-tile + .stat-tile)'),
    ).toContain('border-left:');
    expect(
      rule(activity, '.stats-grid :global(.stat-tile:nth-child(n + 3))'),
    ).toContain('border-top:');

    expectOpenStructure(projectDetail, '.kpi-tile', 'project summary metric');
    expect(rule(projectDetail, '.kpi-strip')).toContain('gap: 0');
    expect(rule(projectDetail, '.kpi-tile + .kpi-tile')).toContain('border-left:');
    expect(rule(projectDetail, '.kpi-tile:nth-child(n + 3)')).toContain('border-top:');
  });

  it('opens project information and workflow groups without erasing controls', () => {
    expectOpenStructure(projectDetail, '.info-card', 'project information section');
    expectOpenStructure(
      projectDetail,
      '.info-card,\n  .overview-task-rail',
      'project overview sections',
    );
    expectOpenStructure(
      projectDetail,
      '.overview-task-rail',
      'project task roll-up',
    );
    expect(rule(projectDetail, '.detail-main > .info-card')).toContain('border-top:');
    expect(rule(projectDetail, '.detail-layout > .overview-task-rail')).toContain(
      'border-left:',
    );

    for (const [source, selector, label] of [
      [profile, '.claim,\n  .edit', 'profile form'],
      [submit, '.picker', 'submission picker'],
      [marketplace, '.your-listings', 'marketplace listing summary'],
    ] as const) {
      expectOpenStructure(source, selector, label);
      expect(rule(source, selector), `${label} needs a section divider`).toContain(
        'border-top:',
      );
    }

    for (const [selector, label] of [
      ['.op', 'pack operation'],
      ['.setup-prompt', 'pack setup prompt'],
    ] as const) {
      expectOpenStructure(installedPacks, selector, label);
      expect(rule(installedPacks, selector), `${label} needs a section divider`).toContain(
        'border-top:',
      );
    }

    expectOpenStructure(installedPacks, '.row', 'installed pack list row');
    expect(rule(installedPacks, '.group')).toContain('gap: 0');
    expect(rule(installedPacks, '.row + .row')).toContain('border-top:');

    expectOpenStructure(installedPacks, '.confirm', 'pack removal confirmation');
    expect(rule(installedPacks, '.confirm')).toContain(
      'border-top: 1px solid var(--v4-rowline)',
    );
    expect(rule(installedPacks, '.confirm')).not.toContain('border-left:');
  });

  it('keeps empty, loading, and error states open and quiet', () => {
    expectEveryOpenStructure(projectDetail, '.drill-empty', 'project empty state');
    expectEveryOpenStructure(activityDigest, '.v4-digest-empty', 'activity digest empty state');
    expectEveryOpenStructure(companyProjects, '.empty-state', 'projects empty state');
    expectEveryOpenStructure(companyProjects, '.column-empty', 'project column empty state');
    expectEveryOpenStructure(companyGoals, '.empty-state', 'goals empty state');
    expectEveryOpenStructure(companyLibrary, '.empty-state', 'company library empty state');
    expectEveryOpenStructure(libraryList, '.empty-state', 'library empty state');
    expectEveryOpenStructure(storyList, '.empty-state', 'story list empty state');
    expectEveryOpenStructure(storyKanban, '.column-empty', 'task column empty state');
    expectEveryOpenStructure(
      team,
      '.team-empty,\n  .team-detail-empty',
      'team empty state',
    );
    expectEveryOpenStructure(installedPacks, '.state-empty', 'installed packs empty state');
    expectEveryOpenStructure(marketplace, '.state-empty', 'marketplace empty state');
    expectEveryOpenStructure(profile, '.resolving', 'profile loading state');
    expectEveryOpenStructure(profile, '.preview-empty', 'profile preview empty state');
    expectEveryOpenStructure(accountView, '.av-empty', 'CRM empty state');
    expectEveryOpenStructure(accountView, '.av-firstrun-card', 'CRM first-run state');
    expectOpenStructure(accountView, '.av-skeleton-row', 'CRM loading row');

    for (const [source, selector, label] of [
      [companyBoard, '.board-error', 'company overview error'],
      [projectDetail, '.drill-error', 'project detail error'],
      [projectDetail, '.status-error', 'project status error'],
      [projectList, '.list-error', 'project list error'],
      [companyProjects, '.projects-error', 'projects error'],
      [companyGoals, '.goals-error', 'goals error'],
      [team, '.team-error', 'team error'],
      [libraryBrowser, '.browser-error', 'library browser error'],
      [libraryDetail, '.detail-error', 'library detail error'],
      [marketplace, '.state-error', 'marketplace error'],
      [accountView, '.av-error', 'CRM error'],
    ] as const) {
      expectOpenStructure(source, selector, label);
    }

    expect(companyProjects).toContain('class="projects-error" role="alert"');
  });

  it('uses open dividers for structural strips and accordion groups', () => {
    expectOpenStructure(activityDigest, '.v4-digest-group', 'activity actor group');
    expect(rule(activityDigest, '.v4-digest-list')).toContain('gap: 0');
    expect(rule(activityDigest, '.v4-digest-group + .v4-digest-group')).toContain(
      'border-top:',
    );

    expectOpenStructure(meetings, '.next-strip', 'next meeting strip');
    expect(rule(meetings, '.next-strip')).toContain('border-top:');

    expectOpenStructure(liveSessions, '.ls-group-ctl', 'live session grouping control');
    expectOpenStructure(liveSessions, '.ls-group-head', 'live session group header');
    expect(rule(liveSessions, '.ls-groups')).toContain('gap: 0');
    expect(rule(liveSessions, '.ls-group + .ls-group')).toContain('border-top:');

    expectOpenStructure(liveSessions, '.ls-outpost-card', 'outpost status group');
    expect(rule(liveSessions, '.ls-outpost-card')).toContain(
      'border-top: 1px solid var(--v4-hairline)',
    );
  });

  it('keeps sticky settings failures attached with a neutral rule instead of a card perimeter', () => {
    const stickyError = rule(settings, '.error');
    expect(stickyError, 'sticky settings error selector should exist').not.toBe('');
    expect(stickyError).toContain('position: sticky');
    expect(stickyError).toContain('border-bottom: 1px solid var(--v4-rowline)');
    expect(stickyError).not.toMatch(/\bborder:\s*1px/);
    expect(stickyError).not.toMatch(/border-radius:\s*(?!0(?:px)?\s*;)/);
    expect(stickyError).not.toContain('background: var(--v4-raised)');
    expect(stickyError).not.toContain('box-shadow: var(--v4-shadow-card)');
  });

  it('renders project activity as an open event list instead of full-width cards', () => {
    expectOpenStructure(projectDetail, '.session-row', 'project activity row');
    expect(rule(projectDetail, '.session-list')).toContain('gap: 0');
    expect(rule(projectDetail, '.session-row + .session-row')).toContain('border-top:');
  });

  it('uses an open status row for live task activity instead of a tinted card or colored edge rail', () => {
    const liveMonitor = rule(storyPanel, '.live-monitor');
    expectOpenRule(liveMonitor, 'live task activity');
    expect(liveMonitor).toContain('border-top: 1px solid var(--v4-rowline)');
    expect(liveMonitor).not.toContain('border-left:');
    expect(liveMonitor).not.toContain('color-mix(');
  });

  it('keeps CRM attention as an open section with divided rows', () => {
    expectOpenStructure(accountView, '.av-attention', 'CRM attention section');
    expect(rule(accountView, '.av-attention')).toContain(
      'border-top: 1px solid var(--v4-rowline)',
    );
    expect(rule(accountView, '.av-attention-row')).toContain('border-radius: 0');
    expect(rule(accountView, '.av-attention-list')).toContain('gap: 0');
    expect(rule(accountView, '.av-attention-list > li + li')).toContain(
      'border-top: 1px solid var(--v4-rowline)',
    );
  });

  it('never encloses navigation or view selectors in segmented-control boxes', () => {
    for (const [source, selector, label] of [
      [projectDetail, '.tabs', 'project section tabs'],
      [libraryBrowser, '.segmented', 'library type tabs'],
      [companyProjects, '.view-toggle', 'project view selector'],
      [storyKanban, '.view-toggle', 'task view selector'],
      [sessionHistory, '.hi-seg', 'session history filter'],
      [agencyChat, '.tabs', 'agency conversation tabs'],
      [projectList, '.status-pills', 'project status filters'],
      [projectList, '.group-toggle', 'project grouping selector'],
      [activity, '.direction-toggle', 'activity direction filter'],
      [popoverCss, '.seg-track', 'legacy popover selector'],
    ] as const) {
      expectOpenStructure(source, selector, label);
      expect(rule(source, selector), `${label} retains wrapper padding`).toContain(
        'padding: 0',
      );
    }

    for (const [source, selector, activeSelector, label] of [
      [projectDetail, '.tab', '.tab.active', 'project section tab'],
      [libraryBrowser, '.segmented button', '.segmented button.active', 'library type tab'],
      [companyProjects, '.toggle-segment', '.toggle-segment.is-active', 'project view option'],
      [storyKanban, '.toggle-segment', '.toggle-segment.is-active', 'task view option'],
      [sessionHistory, '.hi-seg-btn', '.hi-seg-btn.active', 'session history option'],
      [agencyChat, '.tab', '.tab.active', 'agency conversation tab'],
      [projectList, '.status-pill', '.status-pill.is-active', 'project status option'],
      [projectList, '.group-segment', '.group-segment.is-active', 'project grouping option'],
      [activity, '.direction-toggle button', '.direction-toggle button.is-active', 'activity direction option'],
      [popoverCss, '.seg', '.seg.active', 'legacy popover option'],
    ] as const) {
      const control = rule(source, selector);
      expect(control, `${label} selector should exist`).not.toBe('');
      expect(control).toContain('border-bottom: 1px solid transparent');
      expect(control).toContain('border-radius: 0');
      expect(control).toContain('background: transparent');

      const active = rule(source, activeSelector);
      expect(active, `${label} active selector should exist`).not.toBe('');
      expect(active).toMatch(
        /border-bottom-color:\s*var\(--(?:v4-text-2|border-strong|pop-text)\)/,
      );
      expect(active).toContain('background: transparent');
    }
  });
});
