<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import type { Workspace } from '../../lib/workspaces';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { hqSkillMarkdownLink } from '../../lib/hq-skill-link';
  import { companyInviteUrl, companySettingsUrl } from '../lib/hq-console';
  import { openAgentWorkflow } from '../lib/agent-workflow';
  import ActivityPanel from '../panels/ActivityPanel.svelte';
  import CompanyBoardPanel from '../panels/CompanyBoardPanel.svelte';
  import CompanyGoalsPage from './CompanyGoalsPage.svelte';
  import CompanyProjectsPage from './CompanyProjectsPage.svelte';
  import DeploymentsPanel from '../panels/DeploymentsPanel.svelte';
  import SecretsPanel from '../panels/SecretsPanel.svelte';
  import CompanyLibraryPanel from '../panels/CompanyLibraryPanel.svelte';
  import CompanyKnowledgePanel from '../panels/CompanyKnowledgePanel.svelte';
  import TeamPanel from '../panels/TeamPanel.svelte';
  import { DEFAULT_COMPANY_TAB, type CompanyTab } from '../route';

  interface Props {
    company: Workspace;
    /**
     * Which of the eight company sections to show — driven by the V4 secondary
     * sidebar (US-002); the in-page segmented control is gone. Defaults to
     * Overview.
     */
    tab?: CompanyTab;
    /** Switch to the Projects section before handing project creation to HQ. */
    onopenprojects?: () => void;
    /** Called after a successful Connect so the parent re-fetches workspaces. */
    onworkspaceschanged?: () => void;
    /** Vault reachability — while offline, Connect is disabled (it can only
     *  fail), matching the old WorkspaceList/Companies-page guard. */
    cloudReachable?: boolean;
  }

  let {
    company,
    tab = DEFAULT_COMPANY_TAB,
    onopenprojects,
    onworkspaceschanged,
    cloudReachable = true,
  }: Props = $props();

  interface SettingsWire {
    hqPath?: string | null;
  }

  let actionError = $state<string | null>(null);
  let actionNotice = $state<string | null>(null);
  let newProjectBusy = $state(false);
  let connectBusy = $state(false);
  let inviteBusy = $state(false);

  const cloudBacked = $derived(
    company.state === 'synced' ||
      company.state === 'cloud-only' ||
      (company.kind === 'company' && Boolean(company.cloudUid)),
  );

  const connectable = $derived(company.state === 'local-only' || company.state === 'broken');
  const pendingInvite = $derived(
    company.membershipStatus === 'pending' && company.state === 'cloud-only',
  );

  function openInvite() {
    void openExternal(companyInviteUrl(company.slug));
  }

  // Company settings (sync rules, members, roles) live in the HQ web console,
  // not the in-app Settings route — open the company's console page in the
  // system browser.
  function openCompanySettings() {
    actionError = null;
    actionNotice = null;
    void openExternal(companySettingsUrl(company.slug));
  }

  async function handleConnect() {
    if (connectBusy || !connectable || !cloudReachable) return;
    actionError = null;
    actionNotice = null;
    connectBusy = true;
    try {
      await invoke('connect_workspace_to_cloud', { slug: company.slug });
      onworkspaceschanged?.();
    } catch (err) {
      console.error(`connect_workspace_to_cloud(${company.slug}) failed:`, err);
      actionError = `Connect failed: ${String(err)}`;
    } finally {
      connectBusy = false;
    }
  }

  // Pending invites are accepted from the emailed magic link. The desktop
  // membership row carries inviter/time metadata but not the one-time token, so
  // this opens the real /accept workflow and asks the user for the link/token.
  // Routes through openAgentWorkflow (the centralized get_config →
  // buildClaudeCodeUrl → open_claude_code_link → clipboard-fallback sequence);
  // the extra get_config here only feeds the skill-link path in the prompt.
  async function handleOpenPendingInvite() {
    if (inviteBusy) return;
    actionError = null;
    actionNotice = null;
    inviteBusy = true;
    const config = await invoke<{ hqFolderPath?: string }>('get_config').catch(() => ({
      hqFolderPath: '',
    }));
    const prompt = [
      hqSkillMarkdownLink('accept', config.hqFolderPath),
      '',
      `Help me accept the pending HQ company invite for ${company.displayName}.`,
      `Company slug shown in HQ: ${company.slug}.`,
      'The desktop app does not have the magic-link token. Ask me to paste the invite link or raw token, then complete the HQ accept flow.',
    ].join('\n');

    try {
      const result = await openAgentWorkflow(prompt, 'invite acceptance');
      // The clipboard fallback is still a usable path — only a total failure
      // (no deep link AND no clipboard) styles as an error.
      if (result.ok || result.message.includes('copied')) {
        actionNotice = result.message;
      } else {
        actionError = result.message;
      }
    } finally {
      inviteBusy = false;
    }
  }

  async function startNewProject() {
    if (newProjectBusy) return;
    actionError = null;
    actionNotice = null;
    newProjectBusy = true;
    onopenprojects?.();

    const prompt = [
      `/plan ${company.slug} new project`,
      '',
      `Start a new HQ project for ${company.displayName}.`,
      `Use company slug: ${company.slug}.`,
      'Interview me only for the missing product decisions, then create the project PRD under this company and make sure it appears in the HQ desktop Projects screen.',
    ].join('\n');

    try {
      const settings = await invoke<SettingsWire>('get_settings').catch(() => ({ hqPath: null }));
      const folder = settings.hqPath ?? company.localPath ?? '';
      const url = buildClaudeCodeUrl({ folder, prompt });
      await invoke('open_claude_code_link', { url });
    } catch (err) {
      console.error('open_claude_code_link for new project failed:', err);
      try {
        await navigator.clipboard.writeText(prompt);
        actionError = 'Project prompt copied. Paste it into Claude Code to continue.';
      } catch {
        actionError = 'Could not open Claude Code. The Projects screen is open.';
      }
    } finally {
      newProjectBusy = false;
    }
  }
</script>

<section class="company-page" aria-labelledby="company-page-title">
  <h1 id="company-page-title" class="visually-hidden">{company.displayName}</h1>

  <header class="company-actions-row">
    <div></div>
    <div class="company-actions" aria-label="Company actions">
      {#if connectable}
        <button
          type="button"
          data-testid="company-connect"
          title={!cloudReachable
            ? 'Cloud unreachable — connecting is paused until it\u2019s back'
            : company.state === 'broken'
              ? (company.brokenReason ?? 'Retry connecting this company to the cloud')
              : "Create this company's cloud vault and start syncing it"}
          disabled={connectBusy || !cloudReachable}
          onclick={() => void handleConnect()}
        >
          {#if connectBusy}
            Connecting…
          {:else if company.state === 'broken'}
            Retry connect
          {:else}
            Connect to cloud
          {/if}
        </button>
      {/if}
      {#if pendingInvite}
        <button
          type="button"
          data-testid="company-open-invite"
          disabled={inviteBusy}
          onclick={() => void handleOpenPendingInvite()}
        >
          {inviteBusy ? 'Opening…' : 'Open invite'}
        </button>
      {/if}
      <button type="button" onclick={openInvite}>Invite</button>
      <button type="button" onclick={openCompanySettings}>Settings</button>
      <button type="button" class="primary" onclick={() => void startNewProject()} disabled={newProjectBusy}>
        {newProjectBusy ? 'Opening…' : 'New project'}
      </button>
    </div>
  </header>

  {#if actionError}
    <p class="company-action-error" role="status">{actionError}</p>
  {/if}
  {#if actionNotice}
    <p class="company-action-notice" role="status">{actionNotice}</p>
  {/if}

  {#key `${company.slug}:${tab}`}
    <div class="company-panel">
      {#if tab === 'overview'}
        <CompanyBoardPanel slug={company.slug} {cloudBacked} />
      {:else if tab === 'goals'}
        <CompanyGoalsPage slug={company.slug} />
      {:else if tab === 'projects'}
        <CompanyProjectsPage slug={company.slug} onnewproject={startNewProject} />
      {:else if tab === 'skills'}
        <CompanyLibraryPanel slug={company.slug} forcedFilter="skills" />
      {:else if tab === 'workers'}
        <CompanyLibraryPanel slug={company.slug} forcedFilter="workers" />
      {:else if tab === 'knowledge'}
        <CompanyKnowledgePanel slug={company.slug} />
      {:else if tab === 'team'}
        <TeamPanel slug={company.slug} />
      {:else if tab === 'activity'}
        <ActivityPanel slug={company.slug} {cloudBacked} />
      {:else if tab === 'deployments'}
        <DeploymentsPanel slug={company.slug} {cloudBacked} />
      {:else if tab === 'secrets'}
        <SecretsPanel slug={company.slug} {cloudBacked} />
      {/if}
    </div>
  {/key}
</section>

<style>
  .company-page {
    display: grid;
    gap: var(--v4-space-5);
    font-family: var(--font-sans);
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .company-actions-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 30px;
    min-width: 0;
  }

  .company-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 8px;
  }

  .company-actions button {
    max-width: 160px;
    height: 30px;
    overflow: hidden;
    padding: 0 11px;
    border: 1px solid var(--v4-control-border);
    border-radius: var(--v4-radius-button);
    background: var(--v4-secondary-bg);
    color: var(--v4-secondary-fg);
    font: inherit;
    font-size: var(--text-base);
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.33, 1, 0.68, 1),
      transform 120ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  .company-actions button:hover {
    border-color: var(--v4-hairline);
    background: var(--v4-active-row);
    transform: translateY(-1px);
  }

  .company-actions button.primary {
    border-color: transparent;
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .company-actions button:active {
    transform: translateY(0);
    opacity: 0.72;
  }

  .company-actions button:disabled {
    transform: none;
    opacity: 0.58;
    cursor: default;
  }

  .company-action-error {
    margin: -10px 0 0;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 1.3;
  }

  .company-action-notice {
    margin: -10px 0 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    line-height: 1.3;
  }

  .company-panel {
    min-width: 0;
    animation: panel-enter 220ms cubic-bezier(0.33, 1, 0.68, 1);
  }

  @keyframes panel-enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }

    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @media (max-width: 720px) {
    .company-actions {
      width: 100%;
    }

    .company-actions button {
      min-width: 0;
      max-width: none;
      flex: 1 1 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .company-actions button {
      transition: none;
    }

    .company-actions button:hover,
    .company-actions button:active {
      transform: none;
    }

    .company-panel {
      animation: none;
      will-change: auto;
    }
  }
</style>
