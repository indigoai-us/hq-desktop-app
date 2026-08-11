<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import type { Workspace } from '../../lib/workspaces';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import { companyInviteUrl, companyConsoleUrl } from '../lib/hq-console';
  import CompanyBoardPanel from '../panels/CompanyBoardPanel.svelte';
  import CompanyGoalsPage from './CompanyGoalsPage.svelte';
  import CompanyProjectsPage from './CompanyProjectsPage.svelte';
  import CompanySkillsPage from './CompanySkillsPage.svelte';
  import CompanyWorkersPage from './CompanyWorkersPage.svelte';
  import CompanyKnowledgePanel from '../panels/CompanyKnowledgePanel.svelte';
  import TeamPanel from '../panels/TeamPanel.svelte';
  import { DEFAULT_COMPANY_TAB, type CompanyTab } from '../route';

  interface Props {
    company: Workspace;
    /**
     * Which company section to show — driven by the primary sidebar children
     * (DESKTOP-001). Defaults to Overview.
     */
    tab?: CompanyTab;
    /** Switch to the Projects section before handing project creation to HQ. */
    onopenprojects?: () => void;
    /** Switch to the Goals section (overview “View all” / Connect). */
    onopengoals?: () => void;
    /** Open the global Inbox (overview recent activity). */
    onopeninbox?: () => void;
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
    onopengoals,
    onopeninbox,
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
  let inviteOpening = $state(false);

  // Connectivity (vault/membership) — independent of the local Off toggle.
  const cloudBacked = $derived(
    company.state === 'synced' ||
      (company.state === 'cloud-only' && company.membershipStatus !== 'pending'),
  );
  const connectionIssue = $derived(company.state === 'broken');
  // Local runner pause — suppress resource polling without rewriting connectivity.
  const syncEnabled = $derived(company.syncEnabled !== false);

  const connectable = $derived(company.state === 'local-only' || company.state === 'broken');
  const pendingInvite = $derived(company.membershipStatus === 'pending');

  function inviteAge(value: string | null): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed);
  }

  async function openInvite(): Promise<void> {
    if (inviteOpening) return;
    inviteOpening = true;
    actionError = null;
    actionNotice = null;
    try {
      await openExternal(companyInviteUrl(company.slug));
    } catch (err) {
      console.error('Open company invite failed:', err);
      actionError = 'Could not open invitations in the HQ console.';
    } finally {
      inviteOpening = false;
    }
  }

  // Deeper company ops (settings, activity, secrets, …) live in the HQ web
  // console (US-021) — desktop keeps local work surfaces only.
  function openInHqConsole() {
    actionError = null;
    actionNotice = null;
    void openExternal(companyConsoleUrl(company.slug));
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

  // Modern invites are email-keyed + tokenless — Accept runs claim-by-email.
  async function handleAcceptPendingInvite() {
    if (inviteBusy) return;
    actionError = null;
    actionNotice = null;
    inviteBusy = true;
    try {
      const result = await invoke<{
        ok: boolean;
        claimedSlugs: string[];
        message: string;
      }>('claim_pending_company_invite', { companySlug: company.slug });
      actionNotice = result.message || 'Invite accepted. Sync to pull the company.';
      onworkspaceschanged?.();
      if (result.claimedSlugs?.length) {
        void invoke('start_sync', { companySlug: company.slug }).catch((err) => {
          console.warn('post-claim sync failed (non-fatal):', err);
        });
      }
    } catch (err) {
      console.error(`claim_pending_company_invite(${company.slug}) failed:`, err);
      actionError =
        err instanceof Error
          ? err.message
          : String(err) || 'Could not accept invite. Try again or run Sync.';
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
      {#if pendingInvite}
        <button
          type="button"
          onclick={openInvite}
          disabled={inviteOpening}
          aria-busy={inviteOpening}
        >
          {inviteOpening ? 'Opening…' : 'Review or decline'}
        </button>
        <button
          type="button"
          class="primary"
          data-testid="company-accept-invite"
          disabled={inviteBusy}
          onclick={() => void handleAcceptPendingInvite()}
          aria-busy={inviteBusy}
        >
          {inviteBusy ? 'Accepting…' : 'Accept invite'}
        </button>
      {:else if connectable}
        <button
          type="button"
          data-testid="company-connect"
          title={!cloudReachable
            ? 'Cloud unreachable — connecting is paused until it\u2019s back'
            : company.state === 'broken'
              ? `Retry connecting ${company.displayName} to the cloud`
              : "Create this company's cloud vault and start syncing it"}
          disabled={connectBusy || !cloudReachable}
          onclick={() => void handleConnect()}
          aria-busy={connectBusy}
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
      {#if !pendingInvite}
        <!-- DESKTOP-003 + US-021: Invite + New project; ops live in HQ Console. -->
        <button
          type="button"
          onclick={openInvite}
          disabled={inviteOpening}
          aria-busy={inviteOpening}
        >
          {inviteOpening ? 'Opening…' : 'Invite'}
        </button>
        <button
          type="button"
          title="Open this company in the HQ web console"
          onclick={openInHqConsole}
        >
          Open in HQ Console
        </button>
        <button
          type="button"
          class="primary"
          onclick={() => void startNewProject()}
          disabled={newProjectBusy}
          aria-busy={newProjectBusy}
        >
          {newProjectBusy ? 'Opening…' : 'New project'}
        </button>
      {/if}
    </div>
  </header>

  {#if actionError}
    <p class="company-action-error" role="status">{actionError}</p>
  {/if}
  {#if actionNotice}
    <p class="company-action-notice" role="status">{actionNotice}</p>
  {/if}

  {#if pendingInvite}
    <section class="invite-gate" aria-labelledby="pending-invite-title" data-testid="company-invite-gate">
      <span class="invite-eyebrow">Pending invitation</span>
      <h2 id="pending-invite-title">Join {company.displayName}</h2>
      <p>
        Accept before HQ loads this company’s projects, goals, files, activity, members, or
        settings on this Mac.
      </p>
      <dl>
        {#if company.invitedBy}
          <div>
            <dt>Invited by</dt>
            <dd>{company.invitedBy}</dd>
          </div>
        {/if}
        {#if inviteAge(company.invitedAt)}
          <div>
            <dt>Received</dt>
            <dd>{inviteAge(company.invitedAt)}</dd>
          </div>
        {/if}
      </dl>
    </section>
  {:else}
    {#key `${company.slug}:${tab}`}
      <div class="company-panel">
        {#if tab === 'overview'}
          <CompanyBoardPanel
            slug={company.slug}
            {cloudBacked}
            {connectionIssue}
            {syncEnabled}
            {onopenprojects}
            {onopengoals}
            {onopeninbox}
          />
        {:else if tab === 'goals'}
          <CompanyGoalsPage slug={company.slug} />
        {:else if tab === 'projects'}
          <CompanyProjectsPage slug={company.slug} />
        {:else if tab === 'skills'}
          <!-- hq-desktop-v2 US-009: first-class Skills/Workers company pages. -->
          <CompanySkillsPage slug={company.slug} />
        {:else if tab === 'workers'}
          <CompanyWorkersPage slug={company.slug} />
        {:else if tab === 'knowledge'}
          <CompanyKnowledgePanel slug={company.slug} />
        {:else if tab === 'team'}
          <TeamPanel slug={company.slug} companyUid={company.cloudUid} />
        {/if}
      </div>
    {/key}
  {/if}
</section>

<style>
  .company-page {
    container: company-page / inline-size;
    display: grid;
    gap: var(--v4-space-5);
    min-width: 0;
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

  @media (hover: hover) and (pointer: fine) {
    .company-actions button:hover {
      border-color: var(--v4-hairline);
      background: var(--v4-active-row);
      transform: translateY(-1px);
    }
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

  .invite-gate {
    display: grid;
    align-content: start;
    gap: var(--v4-space-3);
    max-width: 680px;
    padding: var(--v4-space-6) 0 0;
    border-top: 1px solid var(--v4-rowline);
  }

  .invite-eyebrow {
    color: var(--v4-text-3);
    font-size: var(--type-metadata);
    font-weight: 650;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  .invite-gate h2,
  .invite-gate p,
  .invite-gate dl,
  .invite-gate dd {
    margin: 0;
  }

  .invite-gate h2 {
    color: var(--v4-text-1);
    font-size: var(--type-detail);
    font-weight: 650;
    letter-spacing: -0.02em;
  }

  .invite-gate p {
    color: var(--v4-text-2);
    font-size: var(--type-body);
    line-height: 1.5;
  }

  .invite-gate dl {
    display: grid;
    gap: var(--v4-space-2);
    padding-top: var(--v4-space-3);
    border-top: 1px solid var(--v4-rowline);
  }

  .invite-gate dl div {
    display: grid;
    grid-template-columns: 100px minmax(0, 1fr);
    gap: var(--v4-space-3);
  }

  .invite-gate dt,
  .invite-gate dd {
    font-size: var(--type-secondary);
  }

  .invite-gate dt {
    color: var(--v4-text-3);
  }

  .invite-gate dd {
    color: var(--v4-text-2);
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

  /* The persistent navigation rail means a 1040px native window can deliver
     less than 800px here. Query the actual company canvas, not the viewport. */
  @container company-page (max-width: 900px) {
    .company-actions-row {
      justify-content: flex-end;
    }

    .company-actions {
      flex-wrap: wrap;
      justify-content: flex-end;
      width: 100%;
    }

    .company-actions button {
      min-width: 0;
      max-width: 180px;
      flex: 0 1 auto;
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
