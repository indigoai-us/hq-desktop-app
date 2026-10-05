<script lang="ts" module>
  import { DEFAULT_DEPLOY_PILLS as DEFAULTS, type DeployFilterPills as Pills } from "./personal-deployments.js";
  /** OWNER-R34: filter state survives leaving and coming back in a session. */
  let sessionPills: Pills = { ...DEFAULTS };
  let sessionSort: import("./personal-deployments.js").DeploySort | null = null;
  export function resetDeployPillsForTests(): void {
    sessionPills = { ...DEFAULTS };
    sessionSort = null;
  }
</script>

<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import Dropdown from "../common/LazyDropdown.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Personal Deployments (US-031). Real hq-deploy apps across the personal
   * scope and every cloud company. Paints the cached list first (loader on
   * the first ever load), then refreshes. A deploying row keeps its previous
   * build serving until swap.
   */
  import ListEmptyState from "../common/ListEmptyState.svelte";
  import { startNowTicker } from "../common/now-ticker.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/chat-tokens.css";
  import type { AdapterPromise, Json } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import { DEPLOY_STEP_LABELS } from "../company/deploy-progress.js";
  import {
    filterDeploymentsBy,
    pillsAreDefault,
    DEFAULT_DEPLOY_PILLS,
    type DeployFilterPills,
    type DeploySort,
    type DeploySortKey,
    formatViews,
    loadDeployments,
    progressFor,
    readPersonalDeploymentsCache,
    relativeAge,
    statusLabel,
    sortDeployments,
    writePersonalDeploymentsCache,
    type DeployAppsPage,
    type DeployScope,
    type PersonalDeployment,
    type PersonalDeploymentsCache,
  } from "./personal-deployments.js";

  interface Props {
    accountId?: string;
    listDeployApps?: (scope: string) => AdapterPromise<Json>;
    companies?: Pick<Workspace, "slug" | "displayName" | "kind" | "state">[];
    openExternal?: (url: string) => void;    /** RELEASE-001 gate: false hides Redeploy and the "Your bots" filter. */
    actions?: boolean;
    /**
     * Embed the selected site as a live iframe preview. Off by default: in the
     * desktop shell every non-app navigation, including an iframe's, is handed to
     * the system browser by the webview navigation hook, so an embedded preview
     * opens the site in the browser as soon as a row is selected.
     */
    livePreview?: boolean;
  }

  let { accountId = "local", listDeployApps, companies = [], openExternal, actions = true, livePreview = false }: Props = $props();

  /** Rows painted per step; the rest arrive on "Show more". */
  const PAGE = 200;

  let cache = $state<PersonalDeploymentsCache | null>(null);
  let refreshing = $state(false);
  let failedScopes = $state<string[]>([]);
  let unavailable = $state(false);
  // OWNER-R34: two header pills (status, scope) plus "Deployed by you" and
  // "Deployed by your bots" toggles. Kept for the session across visits.
  let pills = $state<DeployFilterPills>({ ...sessionPills });
  let sort = $state<DeploySort | null>(sessionSort);
  let query = $state("");
  let selectedId = $state<string | null>(null);
  let selectionCleared = $state(false);
  let limit = $state(PAGE);
  let notice = $state("");
  // AUDIT-3: a read that loaded nothing shows the failed-read line, not "No deployments yet."
  let loadFailed = $state(false);
  let loadAttempt = $state(0);
  // A selected company can only be absent after the current scope reads finish.
  // While they are pending, or when a scope failed, its missing rows are unknown.
  let rowsFinishedLoading = $state(false);

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
    void loadAttempt;
    const wanted = scopes;
    cache = readPersonalDeploymentsCache(account);
    rowsFinishedLoading = false;
    failedScopes = [];
    if (!list) {
      unavailable = true;
      return;
    }
    unavailable = false;
    let live = true;
    refreshing = true;
    loadFailed = false;
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
        rowsFinishedLoading = true;
        if (next.failed.length > 0 && next.failed.length === wanted.length) {
          // Keep the cached list when every scope failed (offline, signed out).
          if (cache) return;
          loadFailed = true;
          return;
        }
        cache = next.cache;
        writePersonalDeploymentsCache(account, next.cache);
      },
      (err) => {
        console.error("[deployments] refresh failed", err);
        if (!live) return;
        refreshing = false;
        failedScopes = wanted.map((scope) => scope.id);
        rowsFinishedLoading = true;
        if (!cache) loadFailed = true;
      },
    );
    return () => {
      live = false;
    };
  });

  // QA-069: "Last visit" re-renders from the absolute time every 30 s.
  let now = $state(Date.now());
  $effect(() => startNowTicker((t) => (now = t)));
  const lastVisitLabel = (row: { lastVisit: string; lastVisitAt?: string }): string =>
    (row.lastVisitAt ? relativeAge(row.lastVisitAt, now) : "") || row.lastVisit;

  const allRows = $derived(cache?.rows ?? []);
  const companyOptions = $derived([
    { value: "all", label: "All companies" },
    ...Array.from(new Map(allRows.map((row) => [row.scopeId ?? row.scopeLabel, row.scopeLabel])).entries())
      .sort(([, left], [, right]) => left.localeCompare(right, undefined, { sensitivity: "base" }))
      .map(([value, label]) => ({ value, label })),
  ]);
  const filteredRows = $derived(filterDeploymentsBy(allRows, pills, query));
  const rows = $derived(sortDeployments(filteredRows, sort));
  $effect(() => {
    sessionPills = { ...pills };
    sessionSort = sort ? { ...sort } : null;
  });
  $effect(() => {
    if (
      rowsFinishedLoading
      && pills.company !== "all"
      && !failedScopes.includes(pills.company)
      && !companyOptions.some((option) => option.value === pills.company)
    ) {
      setPills({ company: "all" });
    }
  });
  const statusCounts = $derived({
    active: allRows.filter((r) => r.status === "active" || r.status === "deploying" || r.status === "building").length,
    sleeping: allRows.filter((r) => r.status === "sleeping").length,
    deactivated: allRows.filter((r) => r.status === "deactivated").length,
  });
  const scopeCounts = $derived({
    personal: allRows.filter((r) => r.scope === "personal").length,
    company: allRows.filter((r) => r.scope === "company").length,
  });
  const shown = $derived(rows.slice(0, limit));
  const selectedRowId = $derived(selectedId ?? (selectionCleared ? null : rows[0]?.id ?? null));
  const selected = $derived(rows.find((row) => row.id === selectedRowId) ?? null);
  $effect(() => {
    if (selectedId && !rows.some((row) => row.id === selectedId)) {
      selectedId = null;
      selectionCleared = true;
    }
  });
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

  function setPills(next: Partial<DeployFilterPills>): void {
    pills = { ...pills, ...next };
    limit = PAGE;
  }

  function toggleSort(key: DeploySortKey): void {
    const initial = key === "lastVisit" ? "descending" : "ascending";
    if (sort?.key !== key) sort = { key, direction: initial };
    else if (sort.direction === initial) sort = { key, direction: initial === "ascending" ? "descending" : "ascending" };
    else sort = null;
    limit = PAGE;
  }

  function sortState(key: DeploySortKey): "ascending" | "descending" | "none" {
    return sort?.key === key ? sort.direction : "none";
  }

  function sortMark(key: DeploySortKey): string {
    const state = sortState(key);
    return state === "ascending" ? "↑" : state === "descending" ? "↓" : "";
  }

  /** Desktop width the preview page lays out at before it is scaled into the card. */
  const PREVIEW_WIDTH = 1280;
  const previewUrl = $derived(livePreview && selected?.status === "active" && selected.url ? selected.url : null);
  let previewCardWidth = $state(0);
  let previewLoaded = $state(false);
  $effect(() => {
    void previewUrl;
    previewLoaded = false;
  });

  function redeploy(): void {
    notice = "Redeploy from the desktop isn't wired up yet. Run /deploy from the project for now.";
  }

  function select(row: PersonalDeployment): void {
    selectedId = row.id;
    selectionCleared = false;
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
  <main>
    <div class="toolbar">
      <h1>Deployments</h1>
      {#if cache}
        <span class="meta-line" data-meta-line data-testid="deploy-count">{countLabel}</span>
        <span class="meta-line" data-meta-line data-testid="deploy-active-count"><span class="meta-dot dot live"></span>{activeCount.toLocaleString()} active</span>
        {#if deployingCount > 0}<span class="meta-line" data-meta-line>{deployingCount} deploying</span>{/if}
        <span class="pills" data-testid="deploy-pills">
          <Dropdown
            pill
            active={pills.status !== "all"}
            testid="deploy-status-pill"
            label="Status"
            value={pills.status}
            onchange={(v) => setPills({ status: v as DeployFilterPills["status"] })}
            options={[
              { value: "all", label: "All statuses" },
              { value: "active", label: "Active", detail: statusCounts.active.toLocaleString() },
              { value: "sleeping", label: "Sleeping", detail: statusCounts.sleeping.toLocaleString() },
              { value: "deactivated", label: "Deactivated", detail: statusCounts.deactivated.toLocaleString() },
            ]}
          />
          <Dropdown
            pill
            active={pills.company !== "all"}
            testid="deploy-company-pill"
            label="Company"
            value={pills.company}
            onchange={(v) => setPills({ company: v })}
            options={companyOptions}
          />
          <Dropdown
            pill
            active={pills.scope !== "all"}
            testid="deploy-scope-pill"
            label="Scope"
            value={pills.scope}
            onchange={(v) => setPills({ scope: v as DeployFilterPills["scope"] })}
            options={[
              { value: "all", label: "All scopes" },
              { value: "personal", label: "Personal", detail: scopeCounts.personal.toLocaleString() },
              { value: "company", label: "Company", detail: scopeCounts.company.toLocaleString() },
            ]}
          />
          <button type="button" class="toggle-pill" class:sel={pills.byYou} aria-pressed={pills.byYou} data-testid="deploy-by-you" onclick={() => setPills({ byYou: !pills.byYou })}>Deployed by you</button>
          {#if actions}
            <button type="button" class="toggle-pill" class:sel={pills.byBots} aria-pressed={pills.byBots} data-testid="deploy-by-bots" onclick={() => setPills({ byBots: !pills.byBots })}>Deployed by your bots</button>
          {/if}
          {#if !pillsAreDefault(pills)}
            <button type="button" class="clear-pills" data-testid="deploy-clear-filters" onclick={() => setPills({ ...DEFAULT_DEPLOY_PILLS })}><RailIcon name="x" />Clear</button>
          {/if}
        </span>
      {/if}
      {#if refreshing}<span class="meta-line" data-meta-line aria-live="polite">Refreshing…</span>{/if}
      <span class="grow"></span>
      <input class="search" type="search" placeholder="Search subdomains" aria-label="Search subdomains" bind:value={query} oninput={() => (limit = PAGE)} />
    </div>
    {#if failedLabels && !loadFailed}
      <p class="warn" data-testid="deploy-failed-scopes">Couldn't load {failedLabels} right now. Showing the rest.</p>
    {/if}
    <div class="deploys">
      <div class="table" role="table" aria-label="Deployments">
        <div class="drow hd" role="row">
          {#each [
            ["app", "App"], ["scope", "Scope"], ["status", "Status"], ["access", "Access"], ["views", "30d views"], ["lastVisit", "Last visit"],
          ] as [key, label] (key)}
            <span role="columnheader" aria-sort={sortState(key as DeploySortKey)}><button type="button" class="sort-header" data-testid={`deploy-sort-${key}`} onclick={() => toggleSort(key as DeploySortKey)}>{label}<span class="sort-mark" aria-hidden="true">{sortMark(key as DeploySortKey)}</span></button></span>
          {/each}
        </div>
        {#if !cache}
          {#if loadFailed}
            <div class="load-error" role="alert" data-testid="deploy-load-error">
              <p>Couldn't read your deployments.</p>
              <RailButton icon="refresh" data-testid="deploy-retry" onclick={() => (loadAttempt += 1)}>Try again</RailButton>
            </div>
          {:else if unavailable}
            <p class="empty" data-testid="deploy-unavailable">Deployments load in the desktop app once you're signed in.</p>
          {:else}
            <div aria-busy="true">
              <ReadLoader testid="deploy-loader" onretry={() => (loadAttempt += 1)} />
            </div>
          {/if}
        {:else if rows.length === 0}
          <ListEmptyState
            total={allRows.length}
            shown={0}
            {query}
            filtered={!pillsAreDefault(pills)}
            noun={["deployment", "deployments"]}
            emptyCopy="No deployments yet."
            onclear={() => {
              // QA-091: "Clear search" clears only the query and keeps the
              // scope; "Clear filters" (no query) resets the filter.
              if (query.trim()) query = "";
              else pills = { ...DEFAULT_DEPLOY_PILLS };
              limit = PAGE;
            }}
            testid="personal-deploy-empty"
          />
        {:else}
          {#each shown as row (row.id)}
            <button
              type="button"
              class="drow"
              class:active={selectedRowId === row.id}
              data-testid="deploy-row"
              aria-current={selectedRowId === row.id ? "true" : undefined}
              onclick={() => select(row)}
            >
              <span class="nm"><span class="t">{row.name}</span>{#if row.detail}<small>{row.detail}</small>{/if}</span>
              <span class="sub">{#if row.scope === "company"}<CompanyLabel name={row.scopeLabel} companyUid={row.scopeId} />{:else}{row.scopeLabel}{/if}</span>
              <span class="st {tone(row)}">{statusLabel(row)}</span>
              <span class="sub">{row.access}</span>
              <span class="n">{formatViews(row.views30d)}</span>
              <span class="sub">{lastVisitLabel(row)}</span>
            </button>
          {/each}
          {#if rows.length > shown.length}
            <button type="button" class="more" onclick={() => (limit += PAGE)}><RailIcon name="chevron-down" />
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
          {#if previewUrl}
            {#key selected.id}
              <button
                type="button"
                class="preview"
                bind:clientWidth={previewCardWidth}
                aria-label={`Open ${selected.name}`}
                data-testid="deploy-preview"
                onclick={() => previewUrl && openExternal?.(previewUrl)}
              >
                {#if !previewLoaded}<span class="preview-wait" aria-hidden="true">Loading preview</span>{/if}
                <iframe
                  src={previewUrl}
                  title={`Preview of ${selected.name}`}
                  loading="lazy"
                  sandbox="allow-scripts allow-same-origin"
                  referrerpolicy="no-referrer"
                  tabindex="-1"
                  class:ready={previewLoaded}
                  style="width: {PREVIEW_WIDTH}px; height: {PREVIEW_WIDTH * 10 / 16}px; transform: scale({previewCardWidth / PREVIEW_WIDTH});"
                  onload={() => (previewLoaded = true)}
                ></iframe>
              </button>
            {/key}
            <p class="preview-note">Preview may be blank for protected pages</p>
          {:else if livePreview}
            <p class="preview-note" data-testid="deploy-no-preview">No preview</p>
          {/if}
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
            <RailButton icon="external" disabled={!selected.url} onclick={() => selected?.url && openExternal?.(selected.url)}>Visit</RailButton>
            {#if actions}<RailButton icon="upload" onclick={redeploy} data-testid="deploy-redeploy">Redeploy</RailButton>{/if}
          </div>
          {#if notice}<p class="notice" role="status" data-testid="deploy-redeploy-notice">{notice}</p>{/if}
          <dl>
            <dt>Access</dt><dd>{selected.access}</dd>
            <dt>Scope</dt><dd>{selected.scopeLabel}</dd>
            {#if selected.project}<dt>Project</dt><dd>{selected.project}</dd>{/if}
            {#if progress || selected.liveVersion}<dt>Serving</dt><dd>{progress ? progress.serving : selected.liveVersion}</dd>{/if}
            <dt>30d views</dt><dd>{formatViews(selected.views30d)}</dd>
            {#if selected.lastVisit}<dt>Last visit</dt><dd>{lastVisitLabel(selected)}</dd>{/if}
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
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    color: var(--t1);
    font-family: var(--font-ui);
    font-size: 13px;
    line-height: 17px;
  }
  .pills { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .toggle-pill, .clear-pills {
    min-height: 28px;
    padding: 0 12px;
    border: 1px solid var(--v4-hairline, var(--line));
    border-radius: 999px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    cursor: pointer;
  }
  .toggle-pill.sel { background: var(--sel); border-color: transparent; }
  .clear-pills { border-color: transparent; color: var(--t2); }
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
  .sort-header { display: inline-flex; align-items: center; gap: 3px; min-width: 0; border: 0; padding: 0; background: transparent; color: inherit; font: inherit; text-align: inherit; cursor: pointer; }
  .sort-header:focus-visible { outline: 2px solid var(--v4-focus, currentColor); outline-offset: 2px; border-radius: 3px; }
  .sort-mark { width: 10px; color: var(--t2); }
  .nm { display: flex; flex-direction: column; min-width: 0; }
  .nm .t { color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nm small, .sub, .foot, .url { color: var(--t3); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { padding: 8px; white-space: normal; }
  .n { font-variant-numeric: tabular-nums; color: var(--t2); text-align: right; }
  .st.live { color: var(--ok-ink); }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 0; }
  .load-error p { margin: 0; }
  .st.err { color: var(--v4-error); }
  .st.off { color: var(--t3); }
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
  .preview {
    position: relative; display: block; width: 100%; aspect-ratio: 16 / 10; padding: 0;
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden;
    background: var(--raised); cursor: pointer; font: inherit;
  }
  .preview iframe {
    position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0;
    pointer-events: none; background: transparent; visibility: hidden;
  }
  .preview iframe.ready { visibility: visible; }
  .preview-wait { position: absolute; inset: 0; display: grid; place-items: center; color: var(--t3); font-size: 13px; }
  .preview-note { margin: -6px 0 0; color: var(--t3); font-size: 13px; }
  .prog { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; background: var(--raised); }
  .phd { display: flex; font-weight: 500; }
  .phd span { margin-left: auto; color: var(--t3); font-weight: 400; font-size: 13px; }
  .bar { height: 3px; background: var(--btn-bg); border-radius: 2px; margin: 8px 0; overflow: hidden; }
  .bar i { display: block; height: 100%; background: var(--t1); }
  .steps { display: flex; gap: 10px; font-size: 13px; color: var(--t3); }
  .steps .done { color: var(--t2); }
  .steps .now { color: var(--t1); }
  .prog p { margin: 8px 0 0; color: var(--t2); font-size: 13px; }
  dl { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 6px 10px; margin: 0; }
  dt { color: var(--t3); }
  dd { margin: 0; color: var(--t2); overflow-wrap: anywhere; }
</style>
