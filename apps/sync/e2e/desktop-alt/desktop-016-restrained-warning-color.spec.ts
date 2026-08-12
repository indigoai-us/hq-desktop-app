import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('DESKTOP-016: restrained warning color', () => {
  const projectDetail = readRepoFile(
    'src/desktop-alt/pages/ProjectDetailView.svelte',
  );
  const projectList = readRepoFile(
    'src/desktop-alt/components/ProjectListView.svelte',
  );
  const storyList = readRepoFile('src/desktop-alt/components/StoryList.svelte');
  const storyKanban = readRepoFile(
    'src/desktop-alt/components/StoryKanban.svelte',
  );
  const storyPanel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const storyDetail = readRepoFile(
    'src/desktop-alt/components/StoryDetailPanel.svelte',
  );
  const meetings = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
  const meetingsAgenda = readRepoFile(
    'src/desktop-alt/components/MeetingsAgenda.svelte',
  );
  const agencyChat = readRepoFile(
    'src/desktop-alt/panels/AgencyChatPanel.svelte',
  );
  const agencyTeams = readRepoFile(
    'src/desktop-alt/panels/AgencyTeamsPanel.svelte',
  );
  const liveSessions = readRepoFile(
    'src/desktop-alt/panels/LiveSessionsPanel.svelte',
  );
  const companyBoard = readRepoFile(
    'src/desktop-alt/panels/CompanyBoardPanel.svelte',
  );
  const sidebarModel = readRepoFile('src/desktop-alt/v4/model.ts');
  const home = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
  const homeModel = readRepoFile('src/desktop-alt/v4/home-model.ts');
  const profile = readRepoFile('src/desktop-alt/panels/ProfilePanel.svelte');
  const libraryBrowser = readRepoFile(
    'src/desktop-alt/components/LibraryBrowser.svelte',
  );
  const libraryDetail = readRepoFile(
    'src/desktop-alt/components/LibraryDetailPanel.svelte',
  );
  const marketplace = readRepoFile(
    'src/desktop-alt/panels/MarketplacePanel.svelte',
  );
  const filePreview = readRepoFile(
    'src/desktop-alt/components/FilePreviewPane.svelte',
  );
  const companyGoals = readRepoFile(
    'src/desktop-alt/pages/CompanyGoalsPage.svelte',
  );
  const needsYou = readRepoFile('src/desktop-alt/v4/NeedsYouCard.svelte');
  const deploymentRow = readRepoFile(
    'src/desktop-alt/components/DeploymentRow.svelte',
  );
  const desktopCss = readRepoFile(
    'src/desktop-alt/styles/desktop-alt.css',
  );
  const popover = readRepoFile('src/components/Popover.svelte');
  // US-018: MissionControlPage retired — awaiting_input tone lives on LiveSessionsPanel.
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const agentWorkflow = readRepoFile(
    'src/desktop-alt/lib/agent-workflow.ts',
  );

  it('keeps routine workflow, priority, meeting, and identity states neutral', () => {
    expect(
      rule(
        projectDetail,
        ".status-in_progress .status-dot,\n  .status-dot.status-in_progress",
      ),
    ).toContain('background: var(--v4-text-2)');

    for (const [name, source] of [
      ['story list', storyList],
      ['story kanban', storyKanban],
      ['story panel', storyPanel],
      ['story detail', storyDetail],
      ['meetings agenda', meetingsAgenda],
      ['agency chat', agencyChat],
      ['profile', profile],
    ] as const) {
      expect(source, `${name} still treats routine state as a warning`).not.toContain(
        'var(--v4-warn)',
      );
    }

    expect(storyDetail).not.toMatch(/rgba\(\s*245,\s*158,\s*11/i);
    expect(rule(meetingsAgenda, '.meeting-row.focused')).toContain(
      'background: var(--v4-active-row)',
    );
    expect(rule(meetingsAgenda, '.meeting-row.focused')).toContain(
      'box-shadow: inset 0 0 0 1px var(--v4-hairline)',
    );
    expect(meetingsAgenda).not.toContain('#c9a227');
    expect(rule(agencyTeams, '.waiting')).toContain('color: var(--v4-text-3)');
    expect(agencyTeams.match(/var\(--v4-warn\)/g) ?? []).toHaveLength(1);
    expect(rule(deploymentRow, '.status-dot.paused')).toContain(
      'background: var(--v4-idle)',
    );
  });

  it('keeps pending membership, progress, and cadence metadata neutral', () => {
    expect(sidebarModel).toContain(
      "workspace.membershipStatus === 'pending') return 'idle'",
    );
    // Pending invite is model metadata (idle tone), not a warning chrome badge.
    expect(sidebarModel).toContain('pendingInvite:');
    expect(homeModel).toMatch(/title: `Invite[^]*?tone: 'neutral'/);
    expect(home).toContain('class="home-label-dot idle"');
    expect(liveSessions).toContain(
      '<span class="ls-dot idle" aria-hidden="true"></span>\n        best-effort',
    );
    expect(rule(liveSessions, '.ls-besteffort')).toContain('border-radius: 0');
    expect(rule(liveSessions, '.ls-besteffort')).toContain('background: transparent');
    expect(companyBoard).toContain(
      "if (status === 'in-progress') return { label: 'In progress', tone: 'idle' };",
    );
    expect(rule(liveSessions, '.ls-dot.awaiting_input')).toContain(
      'background: var(--v4-text-2)',
    );
    expect(companyBoard).toContain("return { label: 'Review', tone: 'idle' };");
    expect(rule(marketplace, '.consent-note::before')).toContain(
      'background: var(--v4-idle)',
    );
  });

  it('uses the error token for actual failures instead of presenting them as warnings', () => {
    for (const [name, source, selector] of [
      ['project status', projectDetail, '.status-error'],
      ['project detail', projectDetail, '.drill-error'],
      ['project list', projectList, '.list-error'],
      ['library browser', libraryBrowser, '.browser-error'],
      ['library detail', libraryDetail, '.detail-error'],
      ['file reveal', filePreview, '.reveal-btn.error'],
      ['company goals', companyGoals, '.goals-error'],
      ['meeting load', meetings, '.error-pill'],
      ['workspace load', desktopCss, '.workspace-error'],
    ] as const) {
      expect(
        rule(source, selector),
        `${name} failure should use the error channel`,
      ).toContain('var(--v4-error');
    }
  });

  it('presents semantic errors as open rows rather than tinted rounded notices', () => {
    for (const [name, source, selector] of [
      ['project detail', projectDetail, '.drill-error'],
      ['project list', projectList, '.list-error'],
      ['library browser', libraryBrowser, '.browser-error'],
      ['library detail', libraryDetail, '.detail-error'],
      ['company goals', companyGoals, '.goals-error'],
      ['marketplace', marketplace, '.state-error'],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${name} error selector should exist`).not.toBe('');
      expect(block, `${name} error still has a closed perimeter`).toContain('border: 0');
      expect(block, `${name} error still has structural rounding`).toContain(
        'border-radius: 0',
      );
      expect(block, `${name} error still has a tinted fill`).toContain(
        'background: transparent',
      );
      expect(block, `${name} error still has an edge rail`).not.toContain(
        'border-left:',
      );
    }
  });

  it('keeps meeting status copy neutral and confines a real warning to one compact dot', () => {
    expect(rule(meetings, '.toast')).toContain('color: var(--v4-text-2)');
    expect(rule(meetings, '.toast-warn')).toContain(
      '--toast-dot: var(--v4-warn)',
    );
    expect(rule(meetings, '.toast-warn')).not.toMatch(/\bcolor\s*:/);
  });

  it('renders needs-attention items as open rows with no colored card edge', () => {
    const card = rule(needsYou, '.v4-card');
    expect(card).toContain('border-top: 1px solid var(--v4-rowline)');
    expect(card).toContain('border-radius: 0');
    expect(card).toContain('background: transparent');
    expect(card).toContain('box-shadow: none');
    expect(needsYou).not.toMatch(
      /border-(?:left|inline-start)\s*:[^;]*(?:--v4-warn|--v4-error)/,
    );
    expect(needsYou).not.toContain('background: color-mix(');
  });

  it('reserves amber popover cues for conflicts or auth attention and uses error red for failures', () => {
    expect(popover).toContain(
      "class:attention={syncState === 'auth-error' || syncState === 'conflict'}",
    );
    expect(popover).toContain("class:error={syncState === 'error'}");
    expect(rule(popover, '.mbp-status.error .gd')).toContain(
      'background: var(--popover-danger)',
    );
    expect(popover).toContain(
      ".snr[data-kind='error'] .snr-icon.alert,\n  .snr[data-kind='manifest'] .snr-icon.alert",
    );
    expect(popover).toMatch(
      /\.snr\[data-kind='manifest'\] \.snr-icon\.alert\s*\{[\s\S]*?color:\s*var\(--popover-danger\)/,
    );
  });

  it('treats copied agent prompts as a neutral usable fallback', () => {
    expect(agentWorkflow).toContain("outcome: 'opened' | 'copied' | 'failed'");
    expect(agentWorkflow).toContain("outcome: 'copied'");
    expect(desktopApp).toContain(
      "result.outcome === 'opened' ? 'ok' : result.outcome === 'copied' ? 'neutral' : 'error'",
    );
    expect(rule(desktopApp, '.action-toast.error .toast-dot')).toContain(
      'background: var(--v4-error)',
    );
    expect(rule(desktopApp, '.action-toast.warn .toast-dot')).toContain(
      'background: var(--v4-warn)',
    );
  });
});
