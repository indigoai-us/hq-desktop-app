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
  import {
    BOT_FILTERS,
    filterBots,
    metadata,
    type BotFilter,
    type BotListRow,
  } from "./team-bots-pages.js";
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

  let cloud = $state<BotListRow[]>([]);
  let cloudPhase = $state<"shimmer" | "ready">("shimmer");
  let filter = $state<BotFilter>("all");
  let selected = $state<string | null>(null);
  // QA-093: Close profile and Escape hide the inspector until a row is picked.
  // Clearing `selected` alone let the first-row fallback reopen it at once.
  let dismissed = $state(false);
  let pages = $state(1);
  let cloudFailed = $state(false);

  function localRows(): BotListRow[] {
    // OWNER-014: only bots that are members of (or moving to) this company.
    // A personal bot stays in Personal.
    return localBotsForCompany(localBots, companyUid, companies)
      .map((bot) => ({
        uid: bot.agentUid,
        name: bot.displayName?.trim() || bot.name,
        kind: "local" as const,
        live: bot.state === "running" || bot.online === true || bot.busy === true,
        status: bot.state || "idle",
        detail: bot.runtime,
        canPause: true,
      }));
  }

  const rows = $derived(filterBots([...localRows(), ...cloud], filter));
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
        cloud = cloudBotsFromRoster(result.value, { companies }).map((bot) => ({
          uid: bot.uid,
          name: bot.displayName,
          kind: "cloud" as const,
          live: bot.status === "WORKING",
          status: bot.phase || bot.status,
          detail: bot.companyLabel ?? "Cloud",
          canPause: bot.canManage,
        }));
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
    return () => {
      cancelled = true;
    };
  });

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

  function kindLabel(row: BotListRow): string {
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
      <div class="roster" role="list">
        {#if cloudPhase === "shimmer" && rows.length === 0}
          <div class="shimmer" data-testid="bots-shimmer" aria-hidden="true">
            {#each [0, 1, 2] as i (i)}<div class="shimmer-row"><span class="sk sk-av"></span><span class="sk"></span></div>{/each}
          </div>
        {/if}
        {#if cloudPhase === "shimmer"}<ReadLoader testid="bots-loader" onretry={() => void loadCloud()} />{/if}
        {#if filteredOut}
          <ListEmptyState total={totalBots} shown={0} filtered noun={["bot", "bots"]} scope="in this company" clearLabel="Show all bots" onclear={() => (filter = "all")} testid="bots-filter-empty" />
        {/if}
        {#each page.rows as row (row.uid)}
          <button
            type="button"
            class="bot-row"
            class:is-selected={current?.uid === row.uid}
            aria-current={current?.uid === row.uid}
            data-testid="bot-row"
            onclick={() => selectRow(row.uid)}
          >
            <span class="sq" aria-hidden="true">
              <svg viewBox="0 0 14 14" width="12" height="12"><rect x="2.5" y="4" width="9" height="7" rx="2" stroke="currentColor" stroke-width="1.3" fill="none" /><path d="M7 2v2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
            </span>
            <span class="nm">{row.name}</span>
            <span class="meta">{kindLabel(row)}</span>
            <span class="meta detail">{row.detail}</span>
            <span class="state"><i class="dot" class:live={row.live}></i>{row.live ? "Live" : row.status}</span>
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
                <div class="profile-skeleton" data-testid="bot-profile-skeleton" aria-busy="true"></div>
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
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3); flex: none; }
  .dot.live { background: var(--ok); }
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
  .profile-skeleton { height: 100%; }
  .bot-row {
    display: grid;
    grid-template-columns: 20px minmax(120px, 2fr) 56px minmax(80px, 2fr) minmax(70px, 1fr);
    gap: 8px;
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
  .sq {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 5px;
    background: var(--line2);
    color: var(--t2);
  }
  .nm { color: var(--t1); }
  .state { display: inline-flex; align-items: center; gap: 6px; color: var(--t2); justify-content: flex-end; }
  .shimmer-row { display: flex; align-items: center; gap: 8px; height: 31px; padding: 0 8px; }
  .sk { display: inline-block; width: 160px; height: 10px; border-radius: 4px; background: var(--line); }
  .sk-av { width: 20px; height: 20px; border-radius: 5px; }
</style>
