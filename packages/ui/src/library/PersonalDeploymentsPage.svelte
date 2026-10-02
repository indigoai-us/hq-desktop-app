<script lang="ts">
  /**
   * Personal Deployments (US-031). Paints from cache, then refreshes.
   * Deploying shows step progress. The previous build stays live until swap.
   */
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import { DEPLOY_STEP_LABELS } from "../company/deploy-progress.js";
  import {
    beginRedeploy,
    filterDeployments,
    personalDeploymentsFixture,
    progressFor,
    readPersonalDeploymentsCache,
    statusLabel,
    writePersonalDeploymentsCache,
    type PersonalDeployFilter,
    type PersonalDeployment,
    type PersonalDeploymentsCache,
  } from "./personal-deployments.js";

  interface Props {
    accountId?: string;
    openExternal?: (url: string) => void;
  }

  let { accountId = "local", openExternal }: Props = $props();

  let cache = $state<PersonalDeploymentsCache>(personalDeploymentsFixture());
  let filter = $state<PersonalDeployFilter>("all");
  let query = $state("");
  let selectedId = $state("storyboard");

  $effect(() => {
    const warm = readPersonalDeploymentsCache(accountId);
    cache = warm ?? personalDeploymentsFixture();
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      const next = personalDeploymentsFixture();
      cache = warm ?? next;
      writePersonalDeploymentsCache(accountId, cache);
    });
    return () => {
      live = false;
    };
  });

  const rows = $derived(filterDeployments(cache.rows, filter, query));
  const selected = $derived(cache.rows.find((row) => row.id === selectedId) ?? rows[0] ?? null);
  const progress = $derived(selected && (selected.status === "deploying" || selected.status === "building")
    ? progressFor(selected)
    : null);
  const activeCount = $derived(cache.rows.filter((row) => row.status === "active").length);
  const deployingCount = $derived(cache.rows.filter((row) => row.status === "deploying" || row.status === "building").length);

  const filters: { id: PersonalDeployFilter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "sleeping", label: "Sleeping" },
    { id: "deactivated", label: "Deactivated" },
    { id: "scope-personal", label: "Personal" },
    { id: "scope-company", label: "Company" },
    { id: "by-you", label: "You" },
    { id: "by-bots", label: "Your bots" },
  ];

  function redeploy(): void {
    if (!selected || selected.status === "deploying") return;
    const next = beginRedeploy(selected);
    cache = { rows: cache.rows.map((row) => (row.id === next.id ? next : row)) };
    writePersonalDeploymentsCache(accountId, cache);
  }

  function tone(row: PersonalDeployment): string {
    if (row.status === "active") return "live";
    if (row.status === "failed") return "err";
    if (row.status === "deploying" || row.status === "building") return "dep";
    return "off";
  }
</script>

<div class="page" data-testid="personal-deployments">
  <aside class="pane" aria-label="Deployments">
    <div class="pane-head">Deployments</div>
    {#each filters as item (item.id)}
      <button type="button" class="row" aria-current={filter === item.id ? "true" : undefined} onclick={() => (filter = item.id)}>
        {item.label}
      </button>
    {/each}
  </aside>
  <main>
    <div class="toolbar">
      <h1>Deployments</h1>
      <span class="chip">{cache.rows.length} apps</span>
      <span class="chip live">{activeCount} active</span>
      {#if deployingCount > 0}<span class="chip">{deployingCount} deploying</span>{/if}
      <span class="grow"></span>
      <input class="search" type="search" placeholder="Search subdomains" aria-label="Search subdomains" bind:value={query} />
    </div>
    <div class="deploys">
      <div class="table">
        <div class="drow hd"><span>App</span><span>Scope</span><span>Status</span><span>Access</span><span>30d</span><span>Visit</span></div>
        {#each rows as row (row.id)}
          <button
            type="button"
            class="drow"
            data-testid="deploy-row"
            aria-current={selected?.id === row.id ? "true" : undefined}
            onclick={() => (selectedId = row.id)}
          >
            <span class="nm">{row.name}<span>{row.host}</span><small>{row.detail}</small></span>
            <span>{row.scopeMark} {row.scopeLabel}</span>
            <span class="st {tone(row)}">{statusLabel(row)}</span>
            <span>{row.access}</span>
            <span class="n">{row.views30d.toLocaleString()}</span>
            <span class="mono">{row.lastVisit}</span>
          </button>
        {/each}
        <p class="foot">Your deploys across every company you belong to, plus your personal scope.</p>
      </div>
      {#if selected}
        <aside class="inspector" aria-label="Deployment detail" data-testid="deploy-inspector">
          <div class="kind">Deployment</div>
          <div class="title">{selected.name}</div>
          <div class="url">https://{selected.name}{selected.host}</div>
          {#if progress}
            <div class="prog" role="status" data-testid="deploy-progress">
              <div class="hd">{statusLabel(selected)} <span>{progress.percent}%</span></div>
              <div class="bar" aria-valuenow={progress.percent} aria-valuemin="0" aria-valuemax="100"><i style="width: {progress.percent}%"></i></div>
              <div class="steps">
                {#each DEPLOY_STEP_LABELS as label, index (label)}
                  <span class:now={index + 1 === progress.step} class:done={index + 1 < progress.step}>{label}</span>
                {/each}
              </div>
              <p data-testid="deploy-live-until-swap">{progress.serving} serves until swap.</p>
              <pre>{selected.log.join("\n")}</pre>
            </div>
          {/if}
          <div class="act">
            <button type="button" class="btn" onclick={() => openExternal?.(`https://${selected.name}${selected.host}`)}>Visit</button>
            <button type="button" class="btn" onclick={redeploy} disabled={selected.status === "deploying"} data-testid="deploy-redeploy">Redeploy</button>
          </div>
          <dl>
            <dt>Access</dt><dd>{selected.access}</dd>
            <dt>Scope</dt><dd>{selected.scopeLabel}</dd>
            <dt>Project</dt><dd>{selected.project}</dd>
            <dt>Serving</dt><dd>{progress ? progress.serving : selected.liveVersion}</dd>
          </dl>
        </aside>
      {/if}
    </div>
  </main>
</div>

<style>
  .page {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--v4-text-1);
  }
  .pane { border-right: 1px solid var(--v4-rowline); overflow: auto; }
  .pane-head { padding: 12px 14px; font-weight: 600; }
  .row, .drow {
    display: flex;
    width: 100%;
    text-align: left;
    border: 0;
    background: transparent;
    color: var(--v4-text-2);
    padding: 7px 10px;
    border-radius: 6px;
    cursor: pointer;
  }
  .row:hover, .drow:hover { background: var(--v4-hover); }
  .row[aria-current="true"], .drow[aria-current="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .toolbar, .act { display: flex; align-items: center; gap: 8px; padding: 10px 16px; }
  h1 { font-size: 16px; margin: 0; font-weight: 600; }
  .grow { flex: 1; }
  .chip { font-size: 12px; color: var(--v4-text-3); }
  .chip.live { color: var(--v4-ok); }
  .search {
    width: 180px; height: 26px; border: 1px solid var(--v4-rowline); border-radius: 6px;
    background: var(--v4-control-bg); color: var(--v4-text-1); padding: 0 8px;
  }
  .deploys { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; flex: 1; }
  .table { overflow: auto; padding: 8px 12px 16px; }
  .drow, .hd {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 92px 110px 80px 48px 64px;
    gap: 8px;
    align-items: center;
  }
  .hd { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .hd:hover { background: transparent; }
  .nm { display: flex; flex-direction: column; min-width: 0; color: var(--v4-text-1); font-weight: 500; }
  .nm span, .nm small, .url, .foot, .mono { color: var(--v4-text-3); font-weight: 400; font-size: 12px; }
  .n, .mono, .url, pre, .steps { font-family: var(--font-mono); }
  .st.live { color: var(--v4-ok); }
  .st.err { color: var(--v4-error); }
  .st.off { color: var(--v4-text-3); }
  .inspector {
    border-left: 1px solid var(--v4-rowline);
    background: var(--v4-secondary-sidebar);
    padding: 16px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .kind { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .title { font-weight: 600; }
  .url { overflow-wrap: anywhere; }
  .prog { border: 1px solid var(--v4-hairline, var(--v4-rowline)); border-radius: 6px; padding: 10px 12px; background: var(--v4-control-faint); }
  .prog .hd { display: flex; font-size: 13px; font-weight: 500; }
  .prog .hd span { margin-left: auto; font-family: var(--font-mono); font-size: 11px; color: var(--v4-text-3); font-weight: 400; }
  .bar { height: 3px; background: var(--v4-control-bg); border-radius: 2px; margin: 8px 0; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--v4-text-1); }
  .steps { display: flex; gap: 10px; font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--v4-text-3); }
  .steps .done { color: var(--v4-text-2); }
  .steps .now { color: var(--v4-text-1); }
  pre { white-space: pre-wrap; font-size: 11px; color: var(--v4-text-2); margin: 8px 0 0; }
  .btn {
    border: 1px solid var(--v4-rowline);
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    border-radius: 6px;
    padding: 4px 8px;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.5; }
  dl { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 4px 10px; font-size: 12px; margin: 0; }
  dt { color: var(--v4-text-3); }
  dd { margin: 0; }
</style>
