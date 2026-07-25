<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { openAgentWorkflow } from '../lib/agent-workflow';
  import { companyStore } from '../lib/company-store.svelte';
  import DeploymentRow, {
    type DeploymentEntry,
    type DeploymentState,
  } from '../components/DeploymentRow.svelte';

  interface Props {
    slug: string;
    cloudBacked?: boolean;
  }

  let { slug, cloudBacked = true }: Props = $props();

  let deployments = $state<DeploymentEntry[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);
  let deploymentQuery = $state('');
  let deployBusy = $state(false);
  let actionMessage = $state<string | null>(null);

  const activeCount = $derived(countByState('active'));
  const deployingCount = $derived(countByState('deploying'));
  const pausedCount = $derived(countByState('paused'));
  const filteredDeployments = $derived(
    deployments.filter((deployment) => matchesDeploymentQuery(deployment, deploymentQuery)),
  );

  $effect(() => {
    reloadToken;
    deployments = [];
    error = null;

    if (!slug || !cloudBacked) {
      loading = false;
      return;
    }

    let cancelled = false;

    const warm = companyStore.deployments(slug);
    deployments = warm ? warm.map(normalizeDeployment) : [];
    loading = warm === null;

    void invoke<Partial<DeploymentEntry>[]>('get_company_deployments', { slug })
      .then((result) => {
        if (!cancelled) {
          deployments = Array.isArray(result) ? result.map(normalizeDeployment) : [];
          companyStore.setDeployments(slug, Array.isArray(result) ? result : []);
        }
      })
      .catch((err) => {
        console.error('get_company_deployments failed:', err);
        if (!cancelled) {
          error = String(err);
          deployments = [];
        }
      })
      .finally(() => {
        if (!cancelled) {
          loading = false;
        }
      });

    return () => {
      cancelled = true;
    };
  });

  function normalizeDeployment(entry: Partial<DeploymentEntry>): DeploymentEntry {
    return {
      sub: stringOrFallback(entry.sub, 'Untitled'),
      url: stringOrFallback(entry.url, ''),
      state: normalizeState(entry.state),
      lastDeploy: stringOrFallback(entry.lastDeploy, '-'),
      size: stringOrFallback(entry.size, '-'),
      ver: stringOrFallback(entry.ver, '-'),
      pwd: entry.pwd === true,
    };
  }

  function stringOrFallback(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value : fallback;
  }

  function normalizeState(value: unknown): DeploymentState {
    return value === 'deploying' || value === 'paused' ? value : 'active';
  }

  function countByState(state: DeploymentState): number {
    return deployments.filter((deployment) => deployment.state === state).length;
  }

  function matchesDeploymentQuery(deployment: DeploymentEntry, query: string): boolean {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [deployment.sub, deployment.url, deployment.state, deployment.lastDeploy, deployment.ver]
      .join(' ')
      .toLowerCase()
      .includes(q);
  }

  function retry() {
    reloadToken += 1;
  }

  async function openDeployWorkflow(): Promise<void> {
    if (deployBusy) return;
    deployBusy = true;
    actionMessage = null;

    const prompt = [
      `/deploy ${slug}`,
      '',
      `Help me deploy a result for company ${slug}.`,
      'Confirm the artifact or path, then use the HQ deploy workflow and return the preview/share URL when it is ready.',
    ].join('\n');

    // Single shared agent-handoff path (get_config → buildClaudeCodeUrl →
    // open_claude_code_link → clipboard fallback) used by every hq-* desktop
    // action; surfaces the plain-language result inline.
    const result = await openAgentWorkflow(prompt, 'deploy workflow');
    actionMessage = result.message;
    deployBusy = false;
  }
</script>

<section class="deployments-panel" aria-labelledby="deployments-panel-title" data-testid="company-deployments-panel">
  <header class="deployments-toolbar">
    <div class="deployments-title title-stack">
      <h2 id="deployments-panel-title">Deployments</h2>
      <span>{loading ? 'Loading deployments' : error ? "Couldn't load" : `${deployments.length} subdomains`}</span>
    </div>

    <div class="deployments-controls detail-primary-actions primary-actions" aria-label="Deployment controls">
      <!-- On a load error `deployments` is cleared, so the counts would read
           "0 active / 0 deploying / 0 paused" — indistinguishable from "no
           deployments". Show em-dashes instead so the header reflects "unknown,
           load failed" rather than fabricating an empty state. -->
      <div class="counts" aria-label="Deployment state counts">
        <span><strong>{error ? '—' : activeCount}</strong> active</span>
        <span><strong>{error ? '—' : deployingCount}</strong> deploying</span>
        <span><strong>{error ? '—' : pausedCount}</strong> paused</span>
      </div>
      <input
        class="deploy-search"
        bind:value={deploymentQuery}
        type="search"
        placeholder="Find"
        aria-label="Find deployments"
      />
      <button
        class="toolbar-button"
        type="button"
        onclick={() => void openDeployWorkflow()}
        disabled={deployBusy || !cloudBacked}
        title="Deploy with HQ"
      >
        {deployBusy ? 'Opening…' : 'Deploy'}
      </button>
    </div>
  </header>

  {#if actionMessage}
    <p class="action-status" role="status">{actionMessage}</p>
  {/if}

  {#if !cloudBacked}
    <div class="deployments-error deployments-note" role="status">
      <div>
        <strong>Connect this company to deploy</strong>
        <span>Local-only companies can be opened and planned, but deploy targets need a cloud-backed company.</span>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="deployments-error" role="alert">
      <div>
        <strong>Deployments unavailable</strong>
        <span>{error}</span>
      </div>
      <button type="button" onclick={retry}>Retry</button>
    </div>
  {/if}

  <section class="deployments-card" aria-labelledby="deployments-list-title" aria-busy={loading}>
    <header class="card-header">
      <h3 id="deployments-list-title">Subdomains</h3>
      <span>{loading ? 'Loading' : `${deployments.length} total`}</span>
    </header>

      <div class="deployment-table">
      <div class="table-head" aria-hidden="true">
        <span>Status</span>
        <span>Subdomain</span>
        <span>Last deploy</span>
        <span>Size</span>
        <span>Version</span>
        <span></span>
      </div>

      {#if loading}
        <div class="deployment-skeleton" aria-label="Loading deployments">
          {#each Array(4) as _, index (index)}
            <span style={`width: ${92 - index * 9}%`}></span>
          {/each}
        </div>
      {:else if filteredDeployments.length > 0}
        <div class="deployment-list">
          {#each filteredDeployments as deployment, index (`${deployment.url}:${index}`)}
            <DeploymentRow {deployment} />
          {/each}
        </div>
      {:else if deployments.length > 0}
        <div class="empty-state" data-testid="filtered-deployments-empty-state">
          No deployments match that search.
        </div>
      {:else}
        <div class="empty-state">No provisioned subdomains for this company.</div>
      {/if}
    </div>
  </section>
</section>

<style>
  .deployments-panel {
    display: grid;
    gap: 14px;
    min-width: 0;
    background: transparent;
  }

  .deployments-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    min-width: 0;
  }

  .deployments-title {
    min-width: 0;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .deployments-title h2 {
    margin: 0;
    color: var(--v4-text-1);
    font-size: var(--type-section, 14px);
    font-weight: 600;
    line-height: 1.2;
  }

  .deployments-title span,
  .card-header span,
  .empty-state,
  .counts {
    color: var(--v4-text-3);
    font-size: var(--type-secondary, 11px);
    line-height: 1.3;
  }

  .deployments-title span {
    display: block;
  }

  .deployments-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .counts {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding-right: 4px;
    white-space: nowrap;
  }

  .counts strong {
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .toolbar-button,
  .deploy-search,
  .deployments-error button {
    height: 30px;
    min-width: 0;
    padding: 0 11px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 600;
    white-space: nowrap;
  }

  .toolbar-button:focus-visible,
  .deploy-search:focus-visible,
  .deployments-error button:focus-visible {
    outline: 2px solid var(--v4-text-1);
    outline-offset: 2px;
  }

  .toolbar-button,
  .deployments-error button {
    cursor: pointer;
  }

  .deploy-search {
    width: 116px;
    color: var(--v4-text-1);
    outline: none;
  }

  .toolbar-button:disabled {
    color: var(--v4-text-3);
    background: var(--v4-active-row);
    cursor: default;
  }

  .toolbar-button:hover:not(:disabled),
  .deploy-search:focus {
    border-color: var(--v4-control-border);
    background: var(--v4-active-row);
  }

  .action-status {
    margin: -8px 0 0;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 16px;
  }

  .deployments-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    min-width: 0;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--v4-warn) 32%, var(--v4-hairline));
    border-radius: var(--v4-radius-field);
    background: color-mix(in srgb, var(--v4-warn) 10%, var(--v4-raised));
    color: var(--v4-warn);
  }

  .deployments-note {
    border-color: var(--v4-hairline);
    background: var(--v4-raised);
    color: var(--v4-text-3);
  }

  .deployments-error div {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .deployments-error strong,
  .deployments-error span {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .deployments-error strong {
    font-size: var(--text-base);
    line-height: 18px;
  }

  .deployments-error span {
    font-size: var(--text-base);
    line-height: 16px;
  }

  .deployments-card {
    min-width: 0;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    overflow: hidden;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
    padding: 11px 13px;
    border-bottom: 1px solid var(--v4-hairline);
  }

  .card-header h3 {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .deployment-table {
    min-width: 0;
  }

  .table-head {
    display: grid;
    grid-template-columns: 14px 1.4fr 1fr auto auto auto;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px 13px;
    border-bottom: 1px solid var(--v4-hairline);
    color: var(--v4-text-3);
    font-size: var(--text-micro);
    font-weight: 600;
    line-height: 15px;
    text-transform: uppercase;
  }

  .deployment-list {
    display: grid;
  }

  .deployment-skeleton {
    display: grid;
    gap: 10px;
    padding: 14px 13px;
  }

  .deployment-skeleton span {
    height: 18px;
    border-radius: var(--v4-radius-button);
    background: linear-gradient(
      90deg,
      var(--v4-control-faint),
      var(--v4-hairline),
      var(--v4-control-faint)
    );
    background-size: 200% 100%;
    animation: skeleton 1.2s ease-in-out infinite;
  }

  .empty-state {
    padding: 26px 13px;
    text-align: center;
  }

  @keyframes skeleton {
    from {
      background-position: 0 0;
    }

    to {
      background-position: -200% 0;
    }
  }

  @media (max-width: 760px) {
    .deployments-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .deployments-controls {
      flex-wrap: wrap;
    }

    .counts {
      width: 100%;
    }

    .table-head {
      grid-template-columns: 14px minmax(0, 1fr) auto;
    }

    .table-head span:nth-child(3),
    .table-head span:nth-child(4),
    .table-head span:nth-child(5) {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .deployment-skeleton span {
      animation: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .deployments-panel,
    .deployments-card {
      background: var(--v4-ground);
    }
  }
</style>
