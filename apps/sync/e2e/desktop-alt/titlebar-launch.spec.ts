import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Source contracts for the title bar's standing "Open in Claude Code" /
 * "Open in Codex" launch cluster. Anchored in files a whole-tree revert
 * keeps, for the same reason as setup-incomplete-card.spec.ts: deleting the
 * component deletes its behaviour tests with it, and only an assertion in a
 * surviving file fails loudly (see #454 → #525).
 */
describe('title bar launch cluster', () => {
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const launch = readRepoFile('src/desktop-alt/components/TitleBarLaunch.svelte');

  it('is mounted in the title bar actions with the HQ folder', () => {
    expect(titleBar).toContain(
      "import TitleBarLaunch from '../components/TitleBarLaunch.svelte';",
    );
    expect(titleBar).toContain('<TitleBarLaunch folder={hqFolderPath ?? \'\'} />');
  });

  it('offers both launch buttons with stable testids', () => {
    expect(launch).toContain('data-testid="titlebar-open-claude"');
    expect(launch).toContain('Open in Claude Code');
    expect(launch).toContain('data-testid="titlebar-open-codex"');
    expect(launch).toContain('Open in Codex');
  });

  it('reuses the installer launch commands rather than reimplementing them', () => {
    expect(launch).toContain("invoke('open_claude_code_link'");
    expect(launch).toContain("invoke('launch_claude_code'");
    expect(launch).toContain("invoke('launch_codex_desktop')");
    expect(launch).toContain("invoke('launch_cli_in_terminal'");
    expect(launch).toContain('buildClaudeCodeUrl');
  });

  it('renders only detected tools and never launches without a folder', () => {
    // A configured machine's title bar is a launch surface, not an install
    // advert — undetected tools stay hidden (unlike the onboarding Ready
    // screen, which always offers both).
    expect(launch).toContain('claude_desktop || tools.claude_cli');
    expect(launch).toContain('codex_desktop || tools.codex_cli');
    expect(launch).toContain('if (!folder || launching) return;');
    expect(launch).toContain('{#if folder && (claudeAvailable || codexAvailable)}');
  });

  it('keeps the cluster out of the window-drag region', () => {
    expect(launch).toContain('data-tauri-drag-region="false"');
  });
});

describe('work-happens explainer', () => {
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const explainer = readRepoFile(
    'src/desktop-alt/components/WorkHappensExplainer.svelte',
  );

  it('mounts above the router so every landing route teaches', () => {
    // The landing route is a company page whenever any company exists
    // (getDesktopLandingRoute) — a home-only mount would show to almost
    // nobody. Anchored in DesktopApp so a tree revert fails loudly.
    const scroll = desktopApp.indexOf('class="desktop-main-scroll"');
    const mount = desktopApp.indexOf('<WorkHappensExplainer');
    const router = desktopApp.indexOf('{#key routeKey}');
    expect(scroll).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(scroll);
    expect(mount).toBeLessThan(router);
  });

  it('states the positioning and offers both launch doors', () => {
    expect(explainer).toContain("This window is your team's shared memory");
    expect(explainer).toContain('data-testid="explainer-open-claude"');
    expect(explainer).toContain('data-testid="explainer-open-codex"');
    expect(explainer).toContain('data-testid="explainer-dismiss"');
  });

  it('shows once per device and goes quiet after any launch or dismissal', () => {
    expect(explainer).toContain("localStorage.getItem(DISMISS_KEY) === '1'");
    // Launching a tool IS the lesson landing — both paths dismiss.
    expect(explainer.match(/dismiss\(\);/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('empty states point at the tools', () => {
  it('every dead end names where the making happens', () => {
    const board = readRepoFile('src/desktop-alt/panels/CompanyBoardPanel.svelte');
    const goals = readRepoFile('src/desktop-alt/pages/CompanyGoalsPage.svelte');
    const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');

    expect(board).toContain(
      'Nothing in flight — start a project in Claude Code or Codex and it appears here',
    );
    expect(board).toContain('Ask your agent to set goals in Claude Code or Codex');
    expect(goals).toContain('Ask your agent to set goals in Claude Code or Codex');
    expect(projects).toContain('Start a project in Claude Code or Codex');
  });
});
