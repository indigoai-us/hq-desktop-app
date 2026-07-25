import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop-alt company work actions are functional', () => {
  const projects = readRepoFile('src/desktop-alt/pages/CompanyProjectsPage.svelte');
  const projectDetail = readRepoFile('src/desktop-alt/pages/ProjectDetailView.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const storyPanel = readRepoFile('src/desktop-alt/v4/StoryPanel.svelte');
  const companyBoardStore = readRepoFile('src/desktop-alt/lib/company-board.svelte.ts');
  const messages = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const deployments = readRepoFile('src/desktop-alt/panels/DeploymentsPanel.svelte');
  const secrets = readRepoFile('src/desktop-alt/panels/SecretsPanel.svelte');
  const agentWorkflow = readRepoFile('src/desktop-alt/lib/agent-workflow.ts');

  it('wires Projects filtering and unlinked-project Link handoff', () => {
    // DESKTOP-004 keeps the legacy needs-link cycle alongside portfolio state/owner filters.
    expect(projects).toContain("type ProjectFilter = 'all' | 'active' | 'needs-link'");
    expect(projects).toContain('function cycleFilter()');
    expect(projects).toContain('matchesProjectFilter(project, projectFilter)');
    expect(projects).toContain('onclick={cycleFilter}');
    expect(projects).toContain('void requestLinkProject(project)');
    expect(projects).toContain("invoke('open_claude_code_link', { url })");
    expect(projects).toContain('data-testid="filtered-projects-empty-state"');
    expect(projects).toContain('data-testid="portfolio-state-filter"');
    expect(projects).toContain('data-testid="portfolio-owner-filter"');
  });

  it('absorbs Tasks into Projects (no separate company Tasks tab/page)', () => {
    // company-detail-desktop-ia: CompanyTasksPage removed; stories open from Projects.
    expect(companyPage).not.toContain('CompanyTasksPage');
    expect(projects).toContain('<ProjectDetailView');
    expect(projects).toContain('onselectStory={openStory}');
    // DESKTOP-005: Tasks is the primary/default project surface (was "board").
    expect(projectDetail).toContain("tab = $state<Tab>('tasks')");
  });

  it('wires project story selection into the in-workspace story detail panel', () => {
    // DESKTOP-005: StoryPanel is embedded inside ProjectDetailView (no modal sibling).
    expect(projectDetail).toContain('<StoryPanel');
    expect(projects).toContain('selectedStory={selectedStory}');
    expect(projects).toContain('onselectDependency={selectStoryById}');
    expect(projects).toContain('{onStoryPassesChange}');
  });

  it('keeps Projects responsive inside the narrow V4 shell panes', () => {
    expect(projects).toContain('container: company-projects / inline-size');
    expect(projects).toContain('@container company-projects');
    expect(projects).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  it('keeps story details legible inside the project workspace (no modal backdrop)', () => {
    // DESKTOP-006: naked main canvas (transparent), not a raised chrome card.
    expect(storyPanel).toContain('background: transparent');
    expect(storyPanel).toContain('data-testid="v4-story-panel"');
    // DESKTOP-005/006: docked panel — no dimmed backdrop; fixed overlay is non-embedded only.
    expect(storyPanel).not.toContain('class="story-backdrop"');
    expect(storyPanel).toContain('is-embedded');
    expect(storyPanel).toContain('@media (max-width: 520px)');
    expect(companyPage).not.toContain('will-change: opacity, transform');
  });

  it('treats null local bridge payloads as empty data', () => {
    expect(companyBoardStore).toContain('function shapeBoard(raw: CompanyBoard | null | undefined)');
    expect(companyBoardStore).toContain('raw?.inbox ?? []');
    expect(messages).toContain("invoke<ChannelsResponse | null>('list_channels')");
    expect(messages).toContain('channels = resp?.channels ?? []');
  });

  it('wires Deployments find and deploy workflow controls', () => {
    expect(deployments).toContain('bind:value={deploymentQuery}');
    expect(deployments).toContain('matchesDeploymentQuery(deployment, deploymentQuery)');
    expect(deployments).toContain("onclick={() => void openDeployWorkflow()}");
    // Deploy now routes through the shared agent-handoff helper rather than
    // re-inlining the link build; the helper preserves the buildClaudeCodeUrl +
    // open_claude_code_link contract (asserted below).
    expect(deployments).toContain("import { openAgentWorkflow } from '../lib/agent-workflow'");
    expect(deployments).toContain("openAgentWorkflow(prompt, 'deploy workflow')");
    expect(deployments).toContain('data-testid="filtered-deployments-empty-state"');
    expect(deployments).not.toContain('title="Deploy from terminal: /deploy"');
  });

  it('centralizes the agent-handoff in one helper (buildClaudeCodeUrl + open_claude_code_link + clipboard fallback)', () => {
    // The single desktop-side "hand this to an agent" path. Reuses the shared
    // claude-code-link util + the dedicated Tauri command (NOT plugin-shell),
    // and never dead-ends — it copies the prompt when the deep-link can't open.
    expect(agentWorkflow).toContain(
      "import { buildClaudeCodeUrl } from '../../lib/claude-code-link'",
    );
    expect(agentWorkflow).toContain("buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt })");
    expect(agentWorkflow).toContain("invoke('open_claude_code_link', { url })");
    expect(agentWorkflow).toContain('navigator.clipboard.writeText(prompt)');
    expect(agentWorkflow).not.toContain("from '@tauri-apps/plugin-shell'");
  });

  it('wires Secrets export and new-key controls to the HQ secrets workflow', () => {
    expect(secrets).toContain("onclick={() => void openSecretsPrompt('export')}");
    expect(secrets).toContain("onclick={() => void openSecretsPrompt('new')}");
    expect(secrets).toContain('/hq-secrets ${slug}');
    expect(secrets).toContain("buildClaudeCodeUrl({ folder: config.hqFolderPath ?? '', prompt })");
    expect(secrets).toContain("invoke('open_claude_code_link', { url })");
    expect(secrets).not.toContain('Export not available');
    expect(secrets).not.toContain('Create from CLI');
  });
});
