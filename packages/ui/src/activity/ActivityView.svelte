<script lang="ts">
  import { compactNumber, exactNumber } from "../common/compact-number.js";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * Company Activity (US-026). Team, Tokens, and Live tabs with a range
   * and Export. The token chart loads only after Tokens is selected.
   * BLANK-1-31: Team and Tokens read company telemetry (hq-pro
   * `GET /v1/telemetry/company`, the web Activity read) for the chosen range.
   * The cached snapshot paints first and stays while a refresh runs; with no
   * cache the shared loader shows; a failed read with nothing cached shows a
   * plain line with Try again. Live has no feed in that response yet.
   */
  import { onMount } from "svelte";
  import type { PlatformAdapter } from "@hq/platform";
  import ReadLoader from "../common/ReadLoader.svelte";
  import { pushToast } from "../shell/toast-stack.svelte.js";
  import { publishCompanyPageCount } from "../shell/company-page-counts.svelte.js";
  import "../home/tokens.css";
  import "../common/button/rail-type.css";
  import "../chat/scroll-perf.css";
  import { loadTokenDayStrip } from "./activity-chart.js";
  import {
    ACTIVITY_RANGES,
    activityToCsv,
    dayBars,
    EMPTY_ACTIVITY,
    formatEfficiency,
    activityFromCompanyTelemetry,
    rangeDays,
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
    adapter?: Pick<PlatformAdapter, "company"> | null;
  }

  let { slug, companyLabel, adapter = null }: Props = $props();

  const storage = typeof localStorage === "undefined" ? null : localStorage;

  let tab = $state<ActivityTab>("team");
  // OWNER-R31: Live shows only when the read carries live sessions; this app's
  // read has none today, so the tab is not offered (and falls back to Team).
  const hasLive = $derived((snapshot?.live.length ?? 0) > 0);
  const shownTab = $derived(tab === "live" && !hasLive ? "team" : tab);
  let range = $state<ActivityRange>("30d");
  let snapshot = $state<ActivitySnapshot | null>(null);
  let refreshing = $state(false);
  let readError = $state<string | null>(null);
  let readNonce = $state(0);
  let selectedId = $state<string | null>(null);
  const selected = $derived(snapshot?.members.find((m) => m.id === selectedId) ?? null);

  /** Sparkline path for a member's per-day tokens (OWNER-R7, web Trend column). */
  function sparkPath(values: number[] | undefined, w: number, h: number): string {
    if (!values || values.length < 2) return "";
    const max = Math.max(...values, 1);
    return values
      .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
      .join(" ");
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && selectedId) {
      selectedId = null;
      event.stopPropagation();
    }
  }

  let chart = $state<Awaited<ReturnType<typeof loadTokenDayStrip>> | null>(null);

  const bars = $derived<DayBar[]>(
    dayBars(range, snapshot?.dayWeights ?? []),
  );
  const weekendCount = $derived(bars.filter((bar) => bar.weekend).length);
  const liveCount = $derived(snapshot?.live.filter((row) => row.live).length ?? 0);
  // The sidepane Activity row shows the team rows this page lists (QA-014).
  $effect(() => {
    if (snapshot) publishCompanyPageCount(slug, "activity", snapshot.members.length);
  });

  const read = $derived(adapter?.company?.getTeamTelemetry ?? null);
  const cacheKey = (activeSlug: string, activeRange: ActivityRange) => `${activeSlug}:${activeRange}`;

  function paintCache(activeSlug: string, activeRange: ActivityRange): void {
    // With a read to run, no cache means the loader until it answers.
    snapshot = readActivityCache(storage, cacheKey(activeSlug, activeRange)) ?? (read ? null : EMPTY_ACTIVITY);
  }

  function isoDay(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  async function refresh(activeSlug: string, activeRange: ActivityRange): Promise<void> {
    const alive = () => slug === activeSlug && range === activeRange;
    if (!read || !activeSlug) {
      readError = null;
      return;
    }
    refreshing = true;
    try {
      const now = Date.now();
      const res = await read(activeSlug, { from: isoDay(now - (rangeDays(activeRange) - 1) * 86_400_000), to: isoDay(now) });
      if (!res.ok) throw new Error(res.message ?? res.reason);
      const next = activityFromCompanyTelemetry(res.value);
      if (!alive()) return;
      snapshot = next;
      readError = null;
      writeActivityCache(storage, cacheKey(activeSlug, activeRange), next);
    } catch (err) {
      console.error("activity read failed:", err);
      if (!alive()) return;
      readError = "Could not load activity.";
    } finally {
      if (alive()) refreshing = false;
    }
  }

  $effect(() => {
    const active = slug;
    const activeRange = range;
    void readNonce;
    readError = null;
    paintCache(active, activeRange);
    void refresh(active, activeRange);
  });

  $effect(() => {
    if (tab !== "tokens" || chart) return;
    void loadTokenDayStrip().then((loaded) => {
      chart = loaded;
    });
  });

  onMount(() => {
    if (!snapshot) paintCache(slug, range);
  });

  async function exportCsv(): Promise<void> {
    const current = snapshot ?? EMPTY_ACTIVITY;
    const csv = activityToCsv(current, range);
    const result = await saveCsvViaDialog(`activity-${slug || "company"}-${range}.csv`, csv);
    // OWNER-003: a quiet confirmation on the shared toast layer.
    pushToast({
      key: "activity-export",
      testId: "export-note",
      title: result === "saved" ? "Saved CSV" : "Export cancelled",
      detail: "",
      tone: result === "saved" ? "ok" : "neutral",
    });
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="activity" data-testid="activity-view" data-refreshing={refreshing ? "true" : "false"}>
  <header class="toolbar">
    <h1>Activity</h1>
    <div class="tabs seg" role="tablist" aria-label="Activity views">
      {#each [["team", "Team"], ["tokens", "Tokens"], ...(hasLive ? [["live", "Live"]] : [])] as item (item[0])}
        <button
          class="tab"
          role="tab"
          aria-selected={shownTab === item[0]}
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
    {#if liveCount > 0}<span class="meta-line" data-meta-line><span class="meta-dot ok"></span>{liveCount} live</span>{/if}
    {#if snapshot?.attributedPct != null}
      <span class="meta-line" data-meta-line><span class="meta-dot"></span>{snapshot.attributedPct}% attributed</span>
    {/if}
    <RailButton icon="download" onclick={() => void exportCsv()}>Export</RailButton>
  </header>

  {#if !snapshot && readError}
    <div class="canvas" role="alert" data-testid="activity-failed">
      <p class="empty">{readError}</p>
      <RailButton icon="refresh" data-testid="activity-retry" onclick={() => (readNonce += 1)}>Try again</RailButton>
    </div>
  {:else if !snapshot}
    <div class="canvas" data-testid="activity-loading" aria-busy="true">
      <ReadLoader testid="activity-loader" onretry={() => (readNonce += 1)} />
    </div>
  {:else if shownTab === "team"}
    <div class="split">
    <div class="canvas">
      <div class="sech">Team · last {range} <span class="grow"></span><span class="plain"><CompanyLabel name={companyLabel} companyUid={slug} /></span></div>
      {#if snapshot.members.length === 0}
        <p class="empty" data-testid="activity-empty">No team activity in this range yet.</p>
      {:else}
        <div class="scroll">
          <table class="tbl">
            <thead>
              <tr>
                <th>Member</th><th>Trend</th><th class="r">Tokens</th><th class="r">Sessions</th>
                <th class="r">Stories</th><th class="r">PRs</th><th class="r">Deploys</th><th>Top skill</th><th class="r">Outcomes/1M</th>
              </tr>
            </thead>
            <tbody>
              {#each snapshot.members as member (member.id)}
                <tr
                  class="hq-contain-row pick"
                  data-testid="activity-member-row"
                  aria-selected={selectedId === member.id}
                  tabindex="0"
                  onclick={() => (selectedId = selectedId === member.id ? null : member.id)}
                  onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); selectedId = member.id; } }}
                >
                  <td>{member.name}</td>
                  <td><svg class="spark" width="56" height="14" viewBox="0 0 56 14" aria-hidden="true"><path d={sparkPath(member.trend, 56, 14)} /></svg></td>
                  <td class="r" title={exactNumber(member.tokens)}>{compactNumber(member.tokens)}</td>
                  <td class="r">{member.sessions}</td>
                  <td class="r">{member.stories}</td>
                  <td class="r">{member.prs ?? "—"}</td>
                  <td class="r">{member.deploys}</td>
                  <td class="sk">{member.topSkill || "—"}</td>
                  <td class="r">{formatEfficiency(member.outcomesPerMillion)}</td>
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
    {#if selected}
      <aside class="pane" data-testid="activity-member-pane" aria-label={selected.name}>
        <div class="ph">
          <div class="pn">
            <b>{selected.name}</b>
            {#if selected.email}<span class="plain">{selected.email}</span>{/if}
            <span class="plain">{selected.bot ? "Agent" : "Member"}</span>
          </div>
          <button class="x" aria-label="Close" data-testid="activity-member-close" onclick={() => (selectedId = null)}>×</button>
        </div>
        <dl class="tot">
          <div><dt>Tokens</dt><dd>{compactNumber(selected.tokens)}</dd></div>
          <div><dt>Sessions</dt><dd>{selected.sessions}</dd></div>
          <div><dt>Stories</dt><dd>{selected.stories}</dd></div>
          <div><dt>PRs</dt><dd>{selected.prs ?? "—"}</dd></div>
          <div><dt>Deploys</dt><dd>{selected.deploys}</dd></div>
          <div><dt>Outcomes/1M</dt><dd>{formatEfficiency(selected.outcomesPerMillion)}</dd></div>
        </dl>
        <div class="sech">Daily tokens</div>
        {#if selected.trend && selected.trend.some((v) => v > 0)}
          <svg class="spark big" width="100%" height="40" viewBox="0 0 240 40" preserveAspectRatio="none" aria-hidden="true"><path d={sparkPath(selected.trend, 240, 40)} /></svg>
        {:else}
          <p class="empty">No tokens in this range.</p>
        {/if}
        <div class="sech">Tokens by model</div>
        {#each selected.tokensByModel ?? [] as row (row.model)}
          <div class="who"><span>{row.model}</span><span class="r">{compactNumber(row.total)}</span></div>
        {:else}<p class="empty">None in this range.</p>{/each}
        <div class="sech">Top skills</div>
        {#each selected.skills ?? [] as row (row.skill)}
          <div class="who"><span class="sk">{row.skill}</span><span class="r">{row.count}</span></div>
        {:else}<p class="empty">None in this range.</p>{/each}
        <div class="sech">Recent tools</div>
        {#each selected.services ?? [] as row (row.service)}
          <div class="who"><span>{row.service}</span><span class="r">{row.count}</span></div>
        {:else}<p class="empty">None in this range.</p>{/each}
        <div class="sech">Projects, repos and key files</div>
        <p class="empty" data-testid="activity-member-work">Shown in the web console. The desktop app does not read the work map yet.</p>
      </aside>
    {/if}
    </div>
  {:else if shownTab === "tokens"}
    <div class="canvas" data-testid="activity-tokens">
      <div class="sech">Tokens by day <span class="grow"></span><span class="plain">weekends dimmed · {bars.length} days</span></div>
      {#if chart}
        <chart.default bars={bars} />
      {:else}
        <div class="at-days" aria-busy="true"><ReadLoader testid="token-day-loading" /></div>
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
            <span class="r">{compactNumber(member.tokens)}</span>
          </div>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="canvas" data-testid="activity-live">
      <div class="sech">Live now <span class="grow"></span><span class="plain">{snapshot.updatedLabel || "Work Mesh"}</span></div>
      {#if snapshot.live.length > 0}
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
</div>

<style>
  /* Segmented controls size to their tabs; nothing stretches or centres them. */
  .tabs, .seg { width: max-content; flex: none; justify-content: flex-start; }
  .activity {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    color: var(--v4-text-1);
    font-family: var(--font-sans, Geist, sans-serif);
    background: transparent;
  }
  .split { flex: 1; min-height: 0; display: flex; }
  .split > .canvas { flex: 1; min-width: 0; }
  .pane { width: 300px; flex: none; overflow-y: auto; padding: 12px 16px; border-left: 1px solid var(--line); box-sizing: border-box; }
  .ph { display: flex; align-items: flex-start; gap: 8px; }
  .pn { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .x { background: none; border: 0; color: var(--t2); cursor: pointer; font: inherit; min-width: 28px; min-height: 28px; }
  .tot { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
  .tot dt { color: var(--t2); }
  .tot dd { margin: 0; }
  tr.pick { cursor: pointer; }
  tr.pick[aria-selected="true"] { background: var(--sel); }
  .spark path { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.7; }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; box-sizing: border-box; padding: 0 20px; flex: none; border-bottom: 1px solid var(--line); }
  .toolbar h1 { margin: 0 8px 0 0; font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); }
  .tabs { display: flex; gap: 2px; background: var(--hover); border: 1px solid var(--panel-border); border-radius: 6px; padding: 2px; }
  .seg { margin-left: 12px; }
  .tab { font: inherit; color: var(--v4-text-2); background: transparent; border: 0; }
  .tab { padding: 4px 8px; font-size: 13px; border-radius: 4px; cursor: pointer; }
  .tab[aria-selected="true"] { background: var(--sel); color: var(--t1); }
  .grow { flex: 1; }
  .meta-line { font-variant-numeric: tabular-nums; }
  .meta-dot.ok { background: var(--ok); }
  .canvas { padding: 16px 20px 24px; overflow: auto; min-height: 0; font-size: 13px; }
  .scroll { overflow: auto; }
  .sech {
    font-size: 13px;
    font-weight: 500;
    color: var(--t2);
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
  }
  .plain { font-weight: 400; color: var(--t3); font-size: 13px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th {
    font-size: 13px;
    font-weight: 400;
    color: var(--t3);
    text-align: left;
    padding: 0 12px 6px 0;
    border-bottom: 1px solid var(--v4-rowline);
  }
  .tbl td { height: 31px; box-sizing: border-box; padding: 7px 12px 7px 0; line-height: 17px; border-bottom: 1px solid var(--line); color: var(--t2); }
  .tbl tr[data-live="true"] td { color: var(--t1); }
  .r { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  .sk { font-size: 13px; color: var(--t3); }
  .empty, .foot { font-size: 13px; color: var(--t3); }
  .axis { display: flex; justify-content: space-between; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--t3); margin-bottom: 16px; }
  .who { display: flex; justify-content: space-between; height: 31px; box-sizing: border-box; padding: 7px 0; line-height: 17px; border-bottom: 1px solid var(--line); color: var(--t2); }
  .ev { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 7px 0; line-height: 17px; font-size: 13px; color: var(--t2); }
  .ev b { font-weight: 500; color: var(--t1); }
  .tm { font-variant-numeric: tabular-nums; color: var(--t3); }
</style>
