<script lang="ts">
  import ReadLoader from "../common/ReadLoader.svelte";
  import ListEmptyState from "../common/ListEmptyState.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company Bots page (console-rail US-027).
   *
   * Local rows come from the shell's already-loaded bot list (the same
   * records BotsSettingsPane reads). Cloud rows use adapter.agents
   * listMobileRoster, the BotsSettingsPane source, refreshed after first
   * paint. The detail is the shared bot profile pane (the Messages one):
   * Open session, Edit bot, Pause and scheduled jobs all live there.
   */
  import { onMount } from "svelte";
  import { publishCompanyPageCount } from "../shell/company-page-counts.svelte.js";
  import type { LocalBotRow, PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import LazyDoor from "../shell/LazyDoor.svelte";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { profilePaneDoor } from "../shell/lazy-doors.js";
  import { dismissable } from "../common/dismissable.js";
  import { pageRows } from "../shell/list-paging.js";
  import { cloudBotsFromRoster } from "../settings/cloud-bots.js";
  import { localBotsForCompany } from "../chat/local-bots.js";
  import { BOT_FILTERS, filterBots, metadata, type BotFilter } from "./team-bots-pages.js";
  import Avatar from "../common/avatar/Avatar.svelte";
  import {
    BOT_COLUMN_GAP,
    BOT_STATUS_LABEL,
    cloudRosterExtras,
    cloudTableRow,
    gridTemplate,
    lastSeenLabel,
    localTableRow,
    sortBotRows,
    visibleBotColumns,
    type BotSortKey,
    type BotTableRow,
    type SortDir,
  } from "./bots-table.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/chat-tokens.css";

  interface Props {
    companyUid?: string | null;
    adapter?: PlatformAdapter | null;
    companies?: Workspace[] | null;
    localBots?: ReadonlyArray<LocalBotRow> | null;
    companyLabel?: string | null;
    ownerName?: string | null;
    onmessage?: (uid: string, name?: string) => void;
    /** Opens the shared 3-step New bot sheet. */
    onaddbot?: () => void;
  }

  let {
    companyUid = null,
    adapter = null,
    companies = null,
    localBots = null,
    companyLabel = null,
    ownerName = null,
    onmessage,
    onaddbot,
  }: Props = $props();

  let cloud = $state<BotTableRow[]>([]);
  let cloudPhase = $state<"shimmer" | "ready">("shimmer");
  let filter = $state<BotFilter>("all");
  let selected = $state<string | null>(null);
  // QA-093: Close profile and Escape hide the inspector until a row is picked.
  // Clearing `selected` alone let the first-row fallback reopen it at once.
  let dismissed = $state(false);
  let pages = $state(1);
  let cloudFailed = $state(false);
  let sortKey = $state<BotSortKey>("status");
  let sortDir = $state<SortDir>("asc");
  let tableWidth = $state(0);
  // Last-seen labels are relative; one clock per minute is enough.
  let now = $state(Date.now());

  function localRows(): BotTableRow[] {
    // OWNER-014: only bots that are members of (or moving to) this company.
    // A personal bot stays in Personal.
    return localBotsForCompany(localBots, companyUid, companies).map((bot) => localTableRow(bot, ownerName));
  }

  const rows = $derived(
    sortBotRows(filterBots([...localRows(), ...cloud], filter), sortKey, sortDir, { liveFirst: filter === "live" }),
  );
  // Row padding is 8px a side; before the first measure assume a wide table.
  const columns = $derived(visibleBotColumns(tableWidth > 0 ? tableWidth - 16 : 1200, rows));
  const template = $derived(gridTemplate(columns));
  // QA-106: the company total, so a filter that hides every bot can say so.
  const totalBots = $derived(localRows().length + cloud.length);
  const filteredOut = $derived(filter !== "all" && rows.length === 0 && totalBots > 0);
  // The sidepane Bots row shows this same total, before the filter (QA-014).
  $effect(() => {
    if (cloudPhase === "ready" && !cloudFailed) publishCompanyPageCount(companyUid, "bots", localRows().length + cloud.length);
  });
  const page = $derived(pageRows(rows, pages));
  const current = $derived(
    dismissed ? null : (rows.find((row) => row.uid === selected) ?? rows[0] ?? null),
  );
  const empty = $derived(cloudPhase === "ready" && !cloudFailed && localRows().length === 0 && cloud.length === 0);

  // AUDIT-3-17: a failed cloud read shows the failed-read line and Try again,
  // never "No bots in this company yet."; local rows stay visible.
  let cancelled = false;

  async function loadCloud(): Promise<void> {
    const agents = adapter?.agents;
    if (!agents?.listMobileRoster) {
      cloudPhase = "ready";
      return;
    }
    cloudFailed = false;
    cloudPhase = "shimmer";
    try {
      const result = await agents.listMobileRoster(companyUid);
      if (cancelled) return;
      if (result.ok) {
        const extras = cloudRosterExtras(result.value);
        const at = Date.now();
        cloud = cloudBotsFromRoster(result.value, { companies }).map((bot) => cloudTableRow(bot, extras.get(bot.uid), at));
      } else {
        console.error("[bots] cloud roster read failed", result.reason);
        cloudFailed = true;
      }
    } catch (err) {
      console.error("[bots] cloud roster read failed", err);
      if (!cancelled) cloudFailed = true;
    } finally {
      if (!cancelled) cloudPhase = "ready";
    }
  }

  onMount(() => {
    void loadCloud();
    const tick = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  });

  /** First click on a column sorts its natural way; a second click flips it. */
  function sortBy(key: BotSortKey): void {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
      return;
    }
    sortKey = key;
    sortDir = key === "lastSeen" ? "desc" : "asc";
  }

  function ariaSort(key: BotSortKey | undefined): "ascending" | "descending" | "none" | undefined {
    if (!key) return undefined;
    if (sortKey !== key) return "none";
    return sortDir === "asc" ? "ascending" : "descending";
  }

  $effect(() => {
    if (current && selected !== current.uid) selected = current.uid;
  });

  function selectRow(uid: string): void {
    selected = uid;
    dismissed = false;
  }

  function closeProfile(): void {
    selected = null;
    dismissed = true;
  }

  function kindLabel(row: BotTableRow): string {
    return row.kind === "local" ? "Local" : "Cloud";
  }
</script>

<section
  class="bots-page"
  data-testid="bots-page"
  data-scene={empty ? "bots-empty" : "bots"}
  data-scroll-budget={metadata.performanceBudget.scrollDroppedFramesPct}
>
  <div class="toolbar">
    <h1>Bots</h1>
    <div class="tabs" role="tablist">
      {#each BOT_FILTERS as id (id)}
        <button
          type="button"
          class="tab"
          role="tab"
          aria-selected={filter === id}
          data-testid={`bots-filter-${id}`}
          onclick={() => (filter = id)}
        >{id === "all" ? "All" : id === "local" ? "Local" : id === "cloud" ? "Cloud" : "Live"}</button>
      {/each}
    </div>
    <span class="grow"></span>
    <!-- BLANK-2: no "0 bots" next to a failed read with nothing loaded.
         BLANK-3: nor while the first read is still loading. -->
    {#if !(cloudFailed && rows.length === 0) && !(cloudPhase === "shimmer" && rows.length === 0)}
      <span class="meta-line" data-meta-line data-testid="bots-count">{rows.length === totalBots ? (rows.length === 1 ? "1 bot" : `${rows.length} bots`) : `${rows.length} of ${totalBots} bots`}</span>
    {/if}
    <RailButton icon="plus" variant="primary" type="button" data-testid="bots-new" onclick={() => onaddbot?.()}>New bot</RailButton>
  </div>

  {#if cloudFailed}
    <div class="load-error" role="alert" data-testid="bots-load-error">
      <p>Couldn't read this company's cloud bots.</p>
      <RailButton icon="refresh" data-testid="bots-retry" onclick={() => void loadCloud()}>Try again</RailButton>
    </div>
  {/if}
  {#if empty}
    <p class="empty-state" data-testid="bots-empty">No bots in this company yet.</p>
  {:else}
    <div class="split">
      <div class="roster" role="table" aria-label="Bots" bind:clientWidth={tableWidth}>
        {#if cloudPhase === "shimmer"}<ReadLoader testid="bots-loader" onretry={() => void loadCloud()} />{/if}
        {#if filteredOut}
          <ListEmptyState total={totalBots} shown={0} filtered noun={["bot", "bots"]} scope="in this company" clearLabel="Show all bots" onclear={() => (filter = "all")} testid="bots-filter-empty" />
        {/if}
        {#if page.rows.length > 0}
          <div class="thead" role="row" data-testid="bots-head" style:grid-template-columns={template} style:column-gap="{BOT_COLUMN_GAP}px">
            {#each columns as col (col.key)}
              {#if col.sortable}
                <button
                  type="button"
                  class="th sort"
                  role="columnheader"
                  aria-sort={ariaSort(col.sortable)}
                  data-testid={`bots-sort-${col.sortable}`}
                  onclick={() => col.sortable && sortBy(col.sortable)}
                >{col.label}<span class="arrow" aria-hidden="true">{sortKey === col.sortable ? (sortDir === "asc" ? "↑" : "↓") : ""}</span></button>
              {:else}
                <span class="th" role="columnheader">{col.label}</span>
              {/if}
            {/each}
          </div>
        {/if}
        {#each page.rows as row (row.uid)}
          <button
            type="button"
            class="bot-row"
            class:is-selected={current?.uid === row.uid}
            aria-current={current?.uid === row.uid}
            data-testid="bot-row"
            data-status={row.status}
            style:grid-template-columns={template}
            style:column-gap="{BOT_COLUMN_GAP}px"
            onclick={() => selectRow(row.uid)}
          >
            {#each columns as col (col.key)}
              {#if col.key === "avatar"}
                <span class="av"><Avatar kind="bot" name={row.name} id={row.uid} photo={row.avatarUrl} size={20} testid="bot-avatar" /></span>
              {:else if col.key === "name"}
                <span class="who"><span class="nm">{row.name}</span>{#if row.handle}<span class="handle">@{row.handle}</span>{/if}</span>
              {:else if col.key === "kind"}
                <span class="meta">{kindLabel(row)}</span>
              {:else if col.key === "host"}
                <span class="meta">{row.host}</span>
              {:else if col.key === "engine"}
                <span class="meta" data-col="engine">{row.engine ?? ""}</span>
              {:else if col.key === "owner"}
                <span class="meta">{row.owner ?? ""}</span>
              {:else if col.key === "role"}
                <span class="meta">{row.role ?? ""}</span>
              {:else if col.key === "activity"}
                <span class="meta">{row.activity ?? ""}</span>
              {:else if col.key === "presence"}
                <span class="meta" data-col="presence">{row.live ? "Live" : "Away"}</span>
              {:else if col.key === "lastSeen"}
                <span class="meta num" data-col="last-seen">{lastSeenLabel(row.lastSeenAt, now)}</span>
              {:else if col.key === "status"}
                <span class="state" data-col="status"><i class="dot {row.status}" aria-hidden="true"></i>{BOT_STATUS_LABEL[row.status]}</span>
              {/if}
            {/each}
          </button>
        {/each}
        {#if page.remaining > 0}
          <ShowMoreRow shown={page.rows.length} total={page.total} next={page.next} noun="bots" onmore={() => (pages += 1)} testid="bots-more" />
        {/if}
      </div>
      {#if current}
        <aside
          class="inspector"
          data-testid="bot-inspector"
          use:dismissable={{ onclose: closeProfile, trap: false, autofocus: false }}
        >
          {#key current.uid}
            <LazyDoor
              door={profilePaneDoor}
              props={{
                kind: "bot",
                name: current.name,
                owner: ownerName,
                company: companyLabel,
                live: current.live,
                agentUid: current.uid,
                runtimeKind: current.kind,
                companyUid,
                agents: adapter?.agents ?? null,
                onclose: closeProfile,
                onmessage: () => onmessage?.(current.uid, current.name),
              }}
            >
              {#snippet skeleton()}
                <div class="profile-loading"><ReadLoader testid="bot-profile-loading" /></div>
              {/snippet}
            </LazyDoor>
          {/key}
        </aside>
      {/if}
    </div>
  {/if}
</section>

<style>
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .bots-page {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1;
    color: var(--t1);
    font-size: 13px;
  }
  /* Console-rail page chrome, measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px everywhere else, 31px rows, background-only selection. */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 52px;
    flex: none;
    box-sizing: border-box;
    padding: 0 20px;
    border-bottom: 1px solid var(--line);
  }
  h1 {
    margin: 0 8px 0 0;
    font-size: var(--type-title, 20px);
    font-weight: var(--type-title-weight, 500);
    line-height: var(--type-title-line, 1.25);
    color: var(--t1);
  }
  .grow { flex: 1; }
  .tabs, .seg { display: inline-flex; gap: 2px; }
  .seg { padding: 2px; border: 1px solid var(--panel-border); border-radius: 6px; background: var(--hover); }
  .tab {
    height: 26px;
    border: 0;
    border-radius: 6px;
    padding: 0 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .seg .tab { height: auto; padding: 4px 8px; border-radius: 4px; }
  .tab:hover { background: var(--hover); color: var(--t1); }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .icon {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t2);
    cursor: pointer;
  }
  .icon:hover { background: var(--hover); color: var(--t1); }
  .meta-line { white-space: nowrap; font-variant-numeric: tabular-nums; }
  /* Status ladder: ready, waiting, error, offline. */
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex: none; }
  .dot.ready { background: var(--ok); }
  .dot.waiting { background: var(--warn); }
  .dot.error { background: var(--red); }
  .dot.offline { background: transparent; box-shadow: inset 0 0 0 1px var(--t3); }
  .sech { margin: 20px 0 4px; padding: 0 8px; color: var(--t2); font-size: 13px; font-weight: 500; }
  .sech:first-child { margin-top: 0; }
  .meta { color: var(--t3); font-size: 13px; }
  .empty { margin: 0; padding: 7px 8px; color: var(--t3); font-size: 13px; line-height: 17px; }
  .note { margin: 16px 8px 0; color: var(--t3); font-size: 13px; }
  .scrim { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(0, 0, 0, 0.45); z-index: 20; }
  .sheet {
    width: 480px;
    max-width: calc(100% - 32px);
    background: var(--overlay-bg, var(--panel-bg));
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    box-shadow: var(--panel-shadow);
    color: var(--t1);
  }
  .sh { display: flex; align-items: center; gap: 8px; height: 52px; padding: 0 10px 0 20px; border-bottom: 1px solid var(--line); }
  .sh-title { flex: 1; font-size: 13px; font-weight: 500; }
  .sf { display: flex; align-items: center; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--line); }
  .fr { display: grid; grid-template-columns: 120px 1fr; gap: 12px; padding: 10px 20px; align-items: center; font-size: 13px; color: var(--t2); }
  .fld {
    width: 100%;
    box-sizing: border-box;
    min-height: 28px;
    border-radius: 6px;
    border: 1px solid var(--line2);
    background: var(--btn-bg);
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    padding: 4px 8px;
  }
  .empty-state { margin: 0; padding: 48px 16px; text-align: center; color: var(--t3); font-size: 13px; }
  .load-error { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 16px; }
  .load-error p { margin: 0; }
  .split { display: flex; min-height: 0; flex: 1; }
  .roster { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 12px; display: flex; flex-direction: column; }
  .inspector { flex: 0 0 340px; width: 340px; min-height: 0; border-left: 1px solid var(--line); display: flex; flex-direction: column; }
  .profile-loading { height: 100%; padding: 12px; box-sizing: border-box; }
  .thead {
    display: grid;
    align-items: center;
    height: 28px;
    flex: none;
    padding: 0 8px;
    color: var(--t3);
    font-size: 13px;
    line-height: 17px;
  }
  .th { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; text-align: left; }
  .th.sort {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .th.sort:hover, .th.sort[aria-sort="ascending"], .th.sort[aria-sort="descending"] { color: var(--t1); }
  .arrow { width: 10px; }
  .bot-row {
    display: grid;
    align-items: center;
    width: 100%;
    height: 31px;
    flex: none;
    box-sizing: border-box;
    text-align: left;
    padding: 7px 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    line-height: 17px;
    cursor: pointer;
  }
  .bot-row > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bot-row:hover { background: var(--hover); }
  .bot-row.is-selected { background: var(--sel); }
  .av { display: grid; place-items: center; overflow: visible; }
  .who { display: flex; align-items: baseline; gap: 6px; }
  .nm { color: var(--t1); overflow: hidden; text-overflow: ellipsis; }
  .handle { color: var(--t3); overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; }
  .num { font-variant-numeric: tabular-nums; }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--t2); }
</style>
