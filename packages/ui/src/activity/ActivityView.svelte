<script lang="ts">
  /**
   * Company Activity (US-026). Team, Tokens, and Live tabs with a range
   * and Export. The token chart loads only after Tokens is selected.
   * First paint uses the session cache or a shimmer, then a background
   * refresh. There is no live token feed in the desktop adapter yet, so
   * refresh keeps the cached snapshot and records that the read finished.
   */
  import { onMount } from "svelte";
  import "../home/tokens.css";
  import "../chat/scroll-perf.css";
  import { loadTokenDayStrip } from "./activity-chart.js";
  import {
    ACTIVITY_RANGES,
    activityToCsv,
    dayBars,
    EMPTY_ACTIVITY,
    formatTokens,
    readActivityCache,
    saveCsvViaDialog,
    writeActivityCache,
    type ActivityRange,
    type ActivitySnapshot,
    type ActivityTab,
    type DayBar,
  } from "./activity-model.js";

  interface Props {
    slug: string;
    companyLabel: string;
  }

  let { slug, companyLabel }: Props = $props();

  const storage = typeof localStorage === "undefined" ? null : localStorage;

  let tab = $state<ActivityTab>("team");
  let range = $state<ActivityRange>("30d");
  let snapshot = $state<ActivitySnapshot | null>(null);
  let refreshing = $state(false);
  let exportNote = $state("");
  let chart = $state<Awaited<ReturnType<typeof loadTokenDayStrip>> | null>(null);

  const bars = $derived<DayBar[]>(
    dayBars(range, snapshot?.dayWeights ?? []),
  );
  const weekendCount = $derived(bars.filter((bar) => bar.weekend).length);
  const liveCount = $derived(snapshot?.live.filter((row) => row.live).length ?? 0);

  function paintCache(activeSlug: string): void {
    snapshot = readActivityCache(storage, activeSlug) ?? EMPTY_ACTIVITY;
  }

  function refresh(activeSlug: string): void {
    refreshing = true;
    queueMicrotask(() => {
      if (slug !== activeSlug) return;
      const next = readActivityCache(storage, activeSlug) ?? EMPTY_ACTIVITY;
      snapshot = { ...next, updatedLabel: next.updatedLabel || "no token feed yet" };
      writeActivityCache(storage, activeSlug, snapshot);
      refreshing = false;
    });
  }

  $effect(() => {
    const active = slug;
    paintCache(active);
    refresh(active);
  });

  $effect(() => {
    if (tab !== "tokens" || chart) return;
    void loadTokenDayStrip().then((loaded) => {
      chart = loaded;
    });
  });

  onMount(() => {
    if (!snapshot) paintCache(slug);
  });

  async function exportCsv(): Promise<void> {
    const current = snapshot ?? EMPTY_ACTIVITY;
    const csv = activityToCsv(current, range);
    const result = await saveCsvViaDialog(`activity-${slug || "company"}-${range}.csv`, csv);
    exportNote = result === "saved" ? "Saved CSV" : "Export cancelled";
  }
</script>

<div class="activity" data-testid="activity-view" data-refreshing={refreshing ? "true" : "false"}>
  <header class="toolbar">
    <h1>Activity</h1>
    <div class="tabs seg" role="tablist" aria-label="Activity views">
      {#each [["team", "Team"], ["tokens", "Tokens"], ["live", "Live"]] as item (item[0])}
        <button
          class="tab"
          role="tab"
          aria-selected={tab === item[0]}
          onclick={() => (tab = item[0] as ActivityTab)}
        >{item[1]}</button>
      {/each}
    </div>
    <div class="tabs seg" role="tablist" aria-label="Range">
      {#each ACTIVITY_RANGES as id (id)}
        <button class="tab" role="tab" aria-selected={range === id} onclick={() => (range = id)}>{id}</button>
      {/each}
    </div>
    <span class="grow"></span>
    {#if liveCount > 0}<span class="chip live">{liveCount} live</span>{/if}
    {#if snapshot?.attributedPct != null}
      <span class="chip">{snapshot.attributedPct}% attributed</span>
    {/if}
    <button class="btn" type="button" onclick={() => void exportCsv()}>Export</button>
  </header>

  {#if !snapshot}
    <div class="canvas" data-testid="activity-skeleton" aria-busy="true">
      {#each [0, 1, 2, 3] as i (i)}<div class="shimmer row"></div>{/each}
    </div>
  {:else if tab === "team"}
    <div class="canvas">
      <div class="sech">Team · last {range} <span class="grow"></span><span class="plain">{companyLabel}</span></div>
      {#if snapshot.members.length === 0}
        <p class="empty" data-testid="activity-empty">No team activity in this range yet.</p>
      {:else}
        <div class="scroll">
          <table class="tbl">
            <thead>
              <tr>
                <th>Member</th><th class="r">Tokens</th><th class="r">Sessions</th>
                <th class="r">Stories</th><th class="r">Deploys</th><th>Top skill</th><th class="r">Outcomes/1M</th>
              </tr>
            </thead>
            <tbody>
              {#each snapshot.members as member (member.id)}
                <tr class="hq-contain-row">
                  <td>{member.name}</td>
                  <td class="r">{formatTokens(member.tokens)}</td>
                  <td class="r">{member.sessions}</td>
                  <td class="r">{member.stories}</td>
                  <td class="r">{member.deploys}</td>
                  <td class="sk">{member.topSkill}</td>
                  <td class="r">{member.outcomesPerMillion ?? "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
      {#if snapshot.pulse.length > 0}
        <div class="sech">Pulse · last hour</div>
        {#each snapshot.pulse as event, i (i)}
          <div class="ev hq-contain-row"><span class="tm">{event.at}</span><span><b>{event.name}</b> {event.text}</span></div>
        {/each}
      {/if}
    </div>
  {:else if tab === "tokens"}
    <div class="canvas" data-testid="activity-tokens">
      <div class="sech">Tokens by day <span class="grow"></span><span class="plain">weekends dimmed · {bars.length} days</span></div>
      {#if chart}
        <chart.default bars={bars} />
      {:else}
        <div class="at-days shimmer" data-testid="token-day-skeleton" aria-busy="true"></div>
      {/if}
      <div class="axis" data-testid="token-axis">
        <span>{bars[0]?.label ?? ""}</span>
        <span>{bars[Math.floor(bars.length / 2)]?.label ?? ""}</span>
        <span>{bars[bars.length - 1]?.label ?? ""}</span>
      </div>
      <p class="foot" data-weekend-count={weekendCount}>
        {snapshot.dayWeights.length === 0
          ? "No token series for this company yet. The strip still marks every day in the range, with weekends dimmed."
          : `${snapshot.updatedLabel || "Cached series"}. Weekends use a lower text opacity.`}
      </p>
      {#if snapshot.members.length > 0}
        <div class="sech">By person</div>
        {#each snapshot.members as member (member.id)}
          <div class="who hq-contain-row">
            <span>{member.name}</span>
            <span class="r">{formatTokens(member.tokens)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="canvas" data-testid="activity-live">
      <div class="sech">Live now <span class="grow"></span><span class="plain">{snapshot.updatedLabel || "Work Mesh"}</span></div>
      {#if snapshot.live.length === 0}
        <p class="empty">No live sessions right now.</p>
      {:else}
        <table class="tbl">
          <thead><tr><th>Who</th><th>Signal</th><th>Project</th><th class="r">Elapsed</th></tr></thead>
          <tbody>
            {#each snapshot.live as row (row.id)}
              <tr class="hq-contain-row" data-live={row.live ? "true" : "false"}>
                <td>{row.name}</td>
                <td>{row.signal || row.what}</td>
                <td class="sk">{row.project}</td>
                <td class="r">{row.elapsed}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>
  {/if}
  {#if exportNote}<p class="toast" data-testid="export-note">{exportNote}</p>{/if}
</div>

<style>
  .activity {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--v4-text-1);
    font-family: var(--font-sans, Geist, sans-serif);
    background: transparent;
  }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; flex: none; }
  .toolbar h1 { margin: 0; font-size: var(--type-section); font-weight: 600; }
  .tabs { display: flex; gap: 0; background: var(--v4-control-faint); border: 1px solid var(--v4-control-border); border-radius: 6px; padding: 2px; }
  .seg { margin-left: 12px; }
  .tab, .btn { font: inherit; color: var(--v4-text-2); background: transparent; border: 0; }
  .tab { padding: 3px 8px; font-size: var(--type-metadata); border-radius: 4px; }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .grow { flex: 1; }
  .btn { border: 1px solid var(--v4-rowline); border-radius: 6px; padding: 4px 10px; color: var(--v4-text-1); }
  .chip { font-size: var(--type-metadata); color: var(--v4-text-2); border: 1px solid var(--v4-rowline); border-radius: 980px; padding: 1px 8px; }
  .chip.live { color: var(--v4-ok); }
  .canvas { padding: 0 16px 16px; overflow: auto; min-height: 0; }
  .scroll { overflow: auto; }
  .sech {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v4-text-3);
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
  }
  .plain { letter-spacing: 0; text-transform: none; font-family: var(--font-sans, Geist, sans-serif); font-size: 12px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: var(--type-secondary); }
  .tbl th {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 400;
    color: var(--v4-text-3);
    text-align: left;
    padding: 0 12px 6px 0;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .tbl td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--v4-rowline); color: var(--v4-text-2); }
  .tbl tr[data-live="true"] td { background: var(--v4-active-row); color: var(--v4-text-1); }
  .r { text-align: right; font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
  .sk { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--v4-text-3); }
  .empty, .foot, .toast { font-size: var(--type-metadata); color: var(--v4-text-3); }
  .axis { display: flex; justify-content: space-between; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; color: var(--v4-text-3); margin-bottom: 16px; }
  .who { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid var(--v4-rowline); color: var(--v4-text-2); }
  .ev { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 5px 0; font-size: var(--type-metadata); color: var(--v4-text-2); }
  .ev b { font-weight: 500; color: var(--v4-text-1); }
  .tm { font-family: var(--font-mono, ui-monospace, monospace); color: var(--v4-text-3); }
  .shimmer, .at-days.shimmer {
    height: 28px;
    margin-bottom: 8px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
  }
  .at-days.shimmer { height: 48px; }
</style>
