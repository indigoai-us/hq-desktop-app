<script lang="ts">
  /**
   * Personal Deployments (US-031). Real hq-deploy apps across the personal
   * scope and every cloud company. Paints the cached list first (skeleton on
   * the first ever load), then refreshes. A deploying row keeps its previous
   * build serving until swap.
   */
  import "../home/tokens.css";
  import "../chat/chat-tokens.css";
  import type { AdapterPromise, Json } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import { DEPLOY_STEP_LABELS } from "../company/deploy-progress.js";
  import {
    filterDeployments,
    formatViews,
    loadDeployments,
    progressFor,
    readPersonalDeploymentsCache,
    statusLabel,
    writePersonalDeploymentsCache,
    type DeployAppsPage,
    type DeployScope,
    type PersonalDeployFilter,
    type PersonalDeployment,
    type PersonalDeploymentsCache,
  } from "./personal-deployments.js";

  interface Props {
    accountId?: string;
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    companies?: Pick<Workspace, "slug" | "displayName" | "kind" | "state">[];
    openExternal?: (url: string) => void;
  }

  let { accountId = "local", listDeployApps, companies = [], openExternal }: Props = $props();

  /** Rows painted per step; the rest arrive on "Show more". */
  const PAGE = 200;

  let cache = $state<PersonalDeploymentsCache | null>(null);
  let refreshing = $state(false);
  let failedScopes = $state<string[]>([]);
  let unavailable = $state(false);
  let filter = $state<PersonalDeployFilter>("all");
  let query = $state("");
  let selectedId = $state<string | null>(null);
  let limit = $state(PAGE);
  let notice = $state("");

  const scopes = $derived<DeployScope[]>([
    { id: "personal", label: "Personal" },
    ...companies
      .filter((c) => c.kind === "company" && c.state !== "local-only" && c.slug)
      .map((c) => ({ id: c.slug, label: c.displayName || c.slug })),
  ]);
  const scopeKey = $derived(scopes.map((s) => s.id).join(","));

  $effect(() => {
    const account = accountId;
    const list = listDeployApps;
    void scopeKey;
    const wanted = scopes;
    cache = readPersonalDeploymentsCache(account);
    if (!list) {
      unavailable = true;
      return;
    }
    unavailable = false;
    let live = true;
    refreshing = true;
    const fetchScope = async (scope: string): Promise<DeployAppsPage> => {
      const result = await list(scope);
      if (!result.ok) throw new Error(`deploy apps ${scope} ${result.reason}`);
      return result.value as DeployAppsPage;
    };
    void loadDeployments(fetchScope, wanted).then(
      (next) => {
        if (!live) return;
        refreshing = false;
        failedScopes = next.failed;
        // Keep the cached list when every scope failed (offline, signed out).
        if (next.failed.length === wanted.length && cache) return;
        cache = next.cache;
        writePersonalDeploymentsCache(account, next.cache);
      },
      (err) => {
        console.error("[deployments] refresh failed", err);
        if (live) refreshing = false;
      },
    );
    return () => {
      live = false;
    };
  });

  const allRows = $derived(cache?.rows ?? []);
  const rows = $derived(filterDeployments(allRows, filter, query));
  const shown = $derived(rows.slice(0, limit));
  const selected = $derived(allRows.find((row) => row.id === selectedId) ?? rows[0] ?? null);
  const progress = $derived(selected && (selected.status === "deploying" || selected.status === "building")
    ? progressFor(selected)
    : null);
  // The header counts what the list shows: "N of M apps" while a filter or search narrows it.
  const countLabel = $derived(
    rows.length === allRows.length
      ? `${allRows.length.toLocaleString()} apps`
      : `${rows.length.toLocaleString()} of ${allRows.length.toLocaleString()} apps`,
  );
  const activeCount = $derived(rows.filter((row) => row.status === "active").length);
  const deployingCount = $derived(allRows.filter((row) => row.status === "deploying" || row.status === "building").length);
  const failedLabels = $derived(
    failedScopes.map((id) => scopes.find((s) => s.id === id)?.label ?? id).join(", "),
  );

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

  function pick(next: PersonalDeployFilter): void {
    filter = next;
    limit = PAGE;
  }

  function redeploy(): void {
    notice = "Redeploy from the desktop isn't wired up yet. Run /deploy from the project for now.";
  }

  function select(row: PersonalDeployment): void {
    selectedId = row.id;
    notice = "";
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
    {#each filters as item (item.id)}
      <button type="button" class="row" class:active={filter === item.id} aria-current={filter === item.id ? "true" : undefined} onclick={() => pick(item.id)}>
        {item.label}
      </button>
    {/each}
  </aside>
  <main>
    <div class="toolbar">
      <h1>Deployments</h1>
      {#if cache}
        <span class="chip" data-testid="deploy-count">{countLabel}</span>
        <span class="chip status"><span class="dot live"></span>{activeCount.toLocaleString()} active</span>
        {#if deployingCount > 0}<span class="chip">{deployingCount} deploying</span>{/if}
      {/if}
      {#if refreshing}<span class="chip" aria-live="polite">Refreshing…</span>{/if}
      <span class="grow"></span>
      <input class="search" type="search" placeholder="Search subdomains" aria-label="Search subdomains" bind:value={query} oninput={() => (limit = PAGE)} />
    </div>
    {#if failedLabels}
      <p class="warn" data-testid="deploy-failed-scopes">Couldn't load {failedLabels} right now. Showing the rest.</p>
    {/if}
    <div class="deploys">
      <div class="table">
        <div class="drow hd"><span>App</span><span>Scope</span><span>Status</span><span>Access</span><span>30d views</span><span>Last visit</span></div>
        {#if !cache}
          {#if unavailable}
            <p class="empty" data-testid="deploy-unavailable">Deployments load in the desktop app once you're signed in.</p>
          {:else}
            <div data-testid="deploy-skeleton" aria-busy="true">
              {#each [0, 1, 2, 3, 4, 5] as i (i)}<div class="skel"></div>{/each}
            </div>
          {/if}
        {:else if rows.length === 0}
          <p class="empty">No deployments match.</p>
        {:else}
          {#each shown as row (row.id)}
            <button
              type="button"
              class="drow"
              class:active={selected?.id === row.id}
              data-testid="deploy-row"
              aria-current={selected?.id === row.id ? "true" : undefined}
              onclick={() => select(row)}
            >
              <span class="nm"><span class="t">{row.name}</span>{#if row.detail}<small>{row.detail}</small>{/if}</span>
              <span class="sub">{row.scopeLabel}</span>
              <span class="st {tone(row)}">{statusLabel(row)}</span>
              <span class="sub">{row.access}</span>
              <span class="n">{formatViews(row.views30d)}</span>
              <span class="sub">{row.lastVisit}</span>
            </button>
          {/each}
          {#if rows.length > shown.length}
            <button type="button" class="more" onclick={() => (limit += PAGE)}>
              Show more ({(rows.length - shown.length).toLocaleString()} left)
            </button>
          {/if}
        {/if}
        <p class="foot">Your deploys across every company you belong to, plus your personal scope.</p>
      </div>
      {#if selected}
        <aside class="inspector" aria-label="Deployment detail" data-testid="deploy-inspector">
          <div class="title">{selected.name}</div>
          {#if selected.url}<div class="url">{selected.url}</div>{/if}
          {#if progress}
            <div class="prog" role="status" data-testid="deploy-progress">
              <div class="phd">{statusLabel(selected)} <span>{progress.percent}%</span></div>
              <div class="bar" aria-valuenow={progress.percent} aria-valuemin="0" aria-valuemax="100"><i style="width: {progress.percent}%"></i></div>
              <div class="steps">
                {#each DEPLOY_STEP_LABELS as label, index (label)}
                  <span class:now={index + 1 === progress.step} class:done={index + 1 < progress.step}>{label}</span>
                {/each}
              </div>
              <p data-testid="deploy-live-until-swap">{progress.serving} serves until swap.</p>
            </div>
          {/if}
          <div class="act">
            <button type="button" class="btn" disabled={!selected.url} onclick={() => selected?.url && openExternal?.(selected.url)}>Visit</button>
            <button type="button" class="btn" onclick={redeploy} data-testid="deploy-redeploy">Redeploy</button>
          </div>
          {#if notice}<p class="notice" role="status" data-testid="deploy-redeploy-notice">{notice}</p>{/if}
          <dl>
            <dt>Access</dt><dd>{selected.access}</dd>
            <dt>Scope</dt><dd>{selected.scopeLabel}</dd>
            {#if selected.project}<dt>Project</dt><dd>{selected.project}</dd>{/if}
            {#if progress || selected.liveVersion}<dt>Serving</dt><dd>{progress ? progress.serving : selected.liveVersion}</dd>{/if}
            <dt>30d views</dt><dd>{formatViews(selected.views30d)}</dd>
            {#if selected.lastVisit}<dt>Last visit</dt><dd>{selected.lastVisit}</dd>{/if}
          </dl>
        </aside>
      {/if}
    </div>
  </main>
</div>

<style>
  /* Messages grammar: 13px/17px rows, 7px 8px padding, 8px radius,
     --hover / --sel fills, --t1/--t2/--t3 ink. No mono outside code. */
  .page {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--t1);
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 17px;
  }
  .pane {
    border-right: 1px solid var(--line);
    background: var(--side-bg);
    overflow: auto;
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .pane-head { height: 28px; display: flex; align-items: center; padding: 0 8px; font-weight: 500; }
  .row, .drow {
    display: flex;
    align-items: center;
    width: 100%;
    box-sizing: border-box;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--t2);
    font: inherit;
    padding: 7px 8px;
    border-radius: 8px;
    cursor: pointer;
  }
  .row:hover, .drow:hover { background: var(--hover); color: var(--t1); }
  .row.active, .drow.active { background: var(--sel); color: var(--t1); }
  main { min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .toolbar, .act { display: flex; align-items: center; gap: 8px; }
  .toolbar { padding: 12px 16px 8px; }
  h1 { font-size: var(--type-title, 20px); line-height: var(--type-title-line, 1.25); margin: 0; font-weight: var(--type-title-weight, 500); }
  .grow { flex: 1; }
  .chip { color: var(--t3); }
  .status { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex: none; }
  .dot.live { background: var(--ok, var(--ok-ink)); }
  .search {
    width: 200px; height: 28px; box-sizing: border-box; border: 1px solid var(--line2); border-radius: 8px;
    background: var(--btn-bg); color: var(--t1); padding: 0 10px; font: inherit;
  }
  .warn, .notice, .empty { margin: 0; color: var(--t3); }
  .warn { padding: 0 16px 8px; }
  .empty { padding: 12px 8px; }
  .deploys { display: grid; grid-template-columns: minmax(0, 1fr) 320px; min-height: 0; flex: 1; }
  /* QA-055: the table scrolls sideways once the columns reach their minimums,
     so no column is ever clipped. Rows are at least the pane width and grow
     to the sum of the column minimums; the name column shrinks first. */
  .table { overflow-x: auto; overflow-y: auto; min-width: 0; padding: 0 8px 16px; }
  .drow, .hd {
    display: grid;
    grid-template-columns: minmax(140px, 1fr) 96px 96px 104px 80px minmax(88px, max-content);
    gap: 8px;
    min-width: 100%;
    width: max-content;
    box-sizing: border-box;
  }
  /* Narrow windows drop the lesser columns first; the app name never collapses. */
  @media (max-width: 1180px) {
    .drow, .hd { grid-template-columns: minmax(140px, 1fr) 96px minmax(96px, max-content); }
    .drow > :nth-child(n + 4), .hd > :nth-child(n + 4) { display: none; }
  }
  /* Layout/style containment only: paint containment would clip cells that
     extend past the row box. */
  .drow { contain: layout style; content-visibility: auto; contain-intrinsic-size: auto 48px; }
  .hd > :nth-child(n + 5), .drow > :nth-child(n + 5) { text-align: right; white-space: nowrap; }
  .hd { padding: 4px 8px; color: var(--t3); font-size: 13px; }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .nm .t { color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm small, .sub, .foot, .url { color: var(--t3); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { padding: 8px; white-space: normal; }
  .n { font-variant-numeric: tabular-nums; color: var(--t2); text-align: right; }
  .st.live { color: var(--ok-ink); }
  .st.err { color: var(--v4-error); }
  .st.off { color: var(--t3); }
  .skel { height: 31px; margin: 1px 0; border-radius: 8px; background: var(--raised); }
  .more {
    margin: 8px; height: 28px; padding: 0 10px; border: none; border-radius: 8px;
    background: var(--btn-bg); color: var(--t2); font: inherit; cursor: pointer;
  }
  .inspector {
    border-left: 1px solid var(--line);
    padding: 16px;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .title { font-weight: 500; overflow-wrap: anywhere; }
  .url { white-space: normal; overflow-wrap: anywhere; }
  .prog { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--raised); }
  .phd { display: flex; font-weight: 500; }
  .phd span { margin-left: auto; color: var(--t3); font-weight: 400; font-size: 13px; }
  .bar { height: 3px; background: var(--btn-bg); border-radius: 2px; margin: 8px 0; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--t1); }
  .steps { display: flex; gap: 10px; font-size: 13px; color: var(--t3); }
  .steps .done { color: var(--t2); }
  .steps .now { color: var(--t1); }
  .prog p { margin: 8px 0 0; color: var(--t2); font-size: 13px; }
  .btn {
    height: 28px; padding: 0 12px; border: none; border-radius: 8px;
    background: var(--btn-bg); color: var(--t1); font: inherit; cursor: pointer;
  }
  .btn:hover { background: var(--sel); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  dl { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 10px; margin: 0; }
  dt { color: var(--t3); }
  dd { margin: 0; color: var(--t2); overflow-wrap: anywhere; }
</style>
