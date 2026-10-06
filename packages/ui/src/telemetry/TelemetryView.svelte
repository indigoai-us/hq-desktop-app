<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import { compactNumber } from "../common/compact-number.js";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  import ReadLoader from "../common/ReadLoader.svelte";
  /**
   * My Telemetry (US-032, OWNER-R35): one scrolling page, no side nav.
   * Header holds Range, the privacy line and Export CSV. Sections in order:
   * Totals, Tokens per day, Models, Skills, Sessions. Sessions come from the
   * HQ workspace folder on this Mac (OWNER-R27) and are absent when there are
   * none (OWNER-R31). Outcomes is not mounted until real per-session outcomes
   * exist (OWNER-R30). Paints the cached snapshot first, then refreshes.
   */
  import { onMount, tick, untrack } from "svelte";
  import "../chat/scroll-perf.css";
  import "../common/button/rail-type.css";
  import "../common/viz-tokens.css";
  import { mixParts, modelShadeOpacity, vizColor } from "./telemetry-colors.js";
  import type { TelemetryCache } from "./telemetry-cache.js";
  import {
    LIST_RATE_LABEL,
    bandPercent,
    chartBandLabels,
    dayBands,
    dayTooltip,
    hasNoTelemetryActivity,
    TELEMETRY_EMPTY_COPY,
    sharePercent,
    snapshotForRange,
    stackMax,
    type TelemetryRange,
    type TelemetrySnapshot,
  } from "./telemetry-model.js";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { LIST_PAGE_SIZE, pageRows } from "../shell/list-paging.js";
  import {
    LOCAL_SESSIONS_NOTE,
    formatGap,
    type LocalSessionRow,
    type LocalSessionsReader,
  } from "./telemetry-local-sessions.js";
  import { formatMoney } from "./telemetry-models.js";
  import {
    RECENT_SESSIONS,
    TOP_SKILLS,
    familiesFor,
    familyNote,
    flatModels,
    pageCsv,
    sectionForOldPage,
    tokenTypes,
    type TelemetrySection,
  } from "./telemetry-page.js";

  interface Props {
    cache: TelemetryCache;
    /** Local session list (native hosts); null hides the Sessions section. */
    localSessions?: LocalSessionsReader | null;
    /** Opens a session's handoff or checkpoint record (HQ-relative path) in Files. */
    onopenthread?: (path: string) => void;
    /** Old sub-page id or section id to scroll to on open. */
    section?: string | null;
  }

  let { cache, localSessions = null, onopenthread, section = null }: Props = $props();

  let base = $state<TelemetrySnapshot | null>(untrack(() => cache.cached()));
  let refreshing = $state(false);
  // Plain reason from the last failed load; the raw error goes to the console.
  let loadError = $state("");
  let range = $state<TelemetryRange>("30d");
  // Every figure on screen reads the snapshot recomputed for the chosen range.
  const snapshot = $derived(base ? snapshotForRange(base, range) : null);

  const maxStack = $derived(snapshot ? stackMax(snapshot.days) : 0);
  // Chart bands are the By-model rows plus Other, in table order.
  const bandLabels = $derived(snapshot ? chartBandLabels(snapshot) : []);

  // Models (OWNER-R29): families expand to exact models; or one flat list.
  const families = $derived(snapshot ? familiesFor(snapshot) : []);
  const flat = $derived(flatModels(families));
  // By model: a model's shade is its family color, lighter for each smaller
  // model inside the same family.
  const modelRank = $derived(
    new Map(families.flatMap((f) => f.models.map((m, i) => [m.id, i] as const))),
  );
  let modelView = $state<"family" | "model">("family");
  const OPEN_KEY = "hq.telemetry.openFamilies";
  let openFamilies = $state<string[]>(readOpen());
  function readOpen(): string[] {
    try {
      const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(OPEN_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch (err) {
      console.warn("[telemetry] could not read open model families", err);
      return [];
    }
  }
  function toggleFamily(family: string): void {
    openFamilies = openFamilies.includes(family) ? openFamilies.filter((f) => f !== family) : [...openFamilies, family];
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(openFamilies));
    } catch (err) {
      console.warn("[telemetry] could not save open model families", err);
    }
  }
  // Family rows plus the no-model remainder, so the table total matches the headline.
  const tokenTotal = $derived(families.reduce((sum, f) => sum + f.total, 0) + (snapshot?.unattributed?.tokens ?? 0));
  const costTotal = $derived.by(() => {
    const priced = families.filter((f) => f.costUsd != null);
    return priced.length ? priced.reduce((sum, f) => sum + (f.costUsd ?? 0), 0) : null;
  });
  const anyUnpriced = $derived(families.some((f) => f.costUsd == null));

  // Skills: top 10, Show all expands in place.
  let allSkills = $state(false);
  const skillMax = $derived(snapshot?.skills[0]?.count ?? 1);
  const skillRows = $derived(snapshot ? (allSkills ? snapshot.skills : pageRows(snapshot.skills, 1, TOP_SKILLS).rows) : []);

  // Sessions (OWNER-R27): this Mac only. Cached per range, refreshed behind.
  type SessionsState = { total: number; rows: LocalSessionRow[]; medianGap: number | null };
  const sessionCache = new Map<TelemetryRange, SessionsState>();
  let sessions = $state<SessionsState | null>(null);
  let sessionsLoading = $state(false);
  let sessionsFailed = $state(false);
  let allSessions = $state(false);
  let sessionsSeq = 0;

  async function loadSessions(next: TelemetryRange, limit = RECENT_SESSIONS): Promise<void> {
    if (!localSessions) return;
    const seq = ++sessionsSeq;
    const cached = sessionCache.get(next);
    sessions = cached ?? null;
    sessionsLoading = true;
    sessionsFailed = false;
    try {
      const page = await localSessions(next, { offset: 0, limit: Math.max(limit, cached?.rows.length ?? 0) });
      if (seq !== sessionsSeq) return;
      const state = { total: page.total, rows: page.rows, medianGap: page.medianGapMinutes };
      sessionCache.set(next, state);
      sessions = state;
    } catch (err) {
      if (seq !== sessionsSeq) return;
      console.warn("[telemetry] local sessions failed", err);
      sessionsFailed = true;
    } finally {
      if (seq === sessionsSeq) sessionsLoading = false;
    }
  }

  async function moreSessions(): Promise<void> {
    if (!localSessions || !sessions) return;
    const seq = sessionsSeq;
    const shown = sessions.rows.length;
    try {
      const page = await localSessions(range, { offset: shown, limit: LIST_PAGE_SIZE });
      if (seq !== sessionsSeq || !sessions) return;
      const state = { ...sessions, total: page.total, rows: [...sessions.rows, ...page.rows] };
      sessionCache.set(range, state);
      sessions = state;
    } catch (err) {
      console.warn("[telemetry] more local sessions failed", err);
    }
  }

  async function showAllSessions(): Promise<void> {
    allSessions = true;
    if (sessions && sessions.rows.length < Math.min(sessions.total, LIST_PAGE_SIZE)) await moreSessions();
  }

  const visibleSessions = $derived(sessions ? (allSessions ? sessions.rows : pageRows(sessions.rows, 1, RECENT_SESSIONS).rows) : []);
  // Absent (no gap) when the host has no local list or it found nothing.
  const showSessions = $derived(
    !!localSessions && (sessions ? sessions.total > 0 : sessionsLoading || sessionsFailed),
  );
  const medianGap = $derived(formatGap(sessions?.medianGap ?? null));

  function refresh(next: TelemetryRange = range): void {
    refreshing = true;
    cache
      .refresh(next)
      .then((loaded) => {
        // A source without endDate (the real one) is fetched per range;
        // the fixture carries endDate and is recomputed by snapshotForRange.
        base = loaded;
        loadError = "";
      })
      .catch((err) => {
        console.warn("[telemetry] refresh failed", err);
        loadError =
          err && typeof err === "object" && "reason" in err && typeof err.reason === "string"
            ? err.reason
            : "Could not load your telemetry. Check your connection and retry.";
      })
      .finally(() => {
        refreshing = false;
      });
  }

  function pickRange(next: TelemetryRange): void {
    range = next;
    allSessions = false;
    refresh(next);
    void loadSessions(next);
  }

  let root = $state<HTMLElement | null>(null);
  async function scrollToSection(id: TelemetrySection): Promise<void> {
    await tick();
    const el = root?.querySelector<HTMLElement>(`[data-section='${id}']`);
    el?.scrollIntoView({ block: "start" });
    el?.focus({ preventScroll: true });
  }

  onMount(() => {
    if (!base && cache.fallback) base = cache.fallback;
    if (base && !base.endDate) range = base.range;
    refresh(range);
    void loadSessions(range);
    if (section) void scrollToSection(sectionForOldPage(section));
  });

  function exportCsv(): void {
    if (!snapshot) return;
    const blob = new Blob([pageCsv(snapshot, families, sessions?.rows ?? [])], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "telemetry.csv";
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="telemetry" data-testid="telemetry-view" data-refreshing={refreshing ? "true" : "false"} bind:this={root}>
  <div class="toolbar">
    <h1>My Telemetry</h1>
    <span class="sub meta-line" data-meta-line>{snapshot?.rangeLabel ?? ""}</span>
    <div class="tabs" role="tablist" aria-label="Range" data-testid="telemetry-range">
      {#each ["7d", "30d", "90d"] as id (id)}
        <button class="tab" role="tab" aria-selected={range === id} onclick={() => pickRange(id as TelemetryRange)}>{id}</button>
      {/each}
    </div>
    <span class="grow"></span>
    <span class="sub meta-line" data-meta-line>Only you can see this</span>
    <RailButton icon="download" onclick={exportCsv}>Export CSV</RailButton>
  </div>

  <main class="canvas">
    {#if snapshot && loadError}
      <p class="foot" data-testid="telemetry-stale">Showing saved numbers. {loadError} <button class="lnk" onclick={() => refresh()}><RailIcon name="refresh" />Retry</button></p>
    {/if}
    {#if snapshot?.optedOut}
      <p class="foot" data-testid="telemetry-opted-out">Personal telemetry is off for your account, so HQ has nothing recorded. Turn it on in Settings to start counting sessions.</p>
    {:else if snapshot?.notice}
      <p class="foot" data-testid="telemetry-notice">{snapshot.notice}</p>
    {/if}
    {#if !snapshot && loadError}
      <div role="alert" data-testid="telemetry-error">
        <p>{loadError}</p>
        <RailButton icon="refresh" data-testid="telemetry-retry" onclick={() => refresh()}>Retry</RailButton>
      </div>
    {:else if !snapshot}
      <div aria-busy="true">
        <ReadLoader testid="telemetry-loading" onretry={() => refresh()} />
      </div>
    {:else if !snapshot.optedOut && hasNoTelemetryActivity(snapshot)}
      <p class="empty-line" data-testid="telemetry-empty">{TELEMETRY_EMPTY_COPY}</p>
    {:else}
      <section data-section="totals" tabindex="-1" aria-label="Totals">
        <div class="statline">
          <div class="stat"><div class="n" title={String(snapshot.sessions)}>{compactNumber(snapshot.sessions)}{#if snapshot.sessionsDelta}<small>{snapshot.sessionsDelta}</small>{/if}</div><div class="l">sessions</div></div>
          <div class="stat"><div class="n">{snapshot.tokensLabel}</div><div class="l">tokens</div></div>
          <div class="stat"><div class="n">{compactNumber(snapshot.storiesShipped)}</div><div class="l">stories shipped</div></div>
          <div class="stat"><div class="n">{compactNumber(snapshot.deploys)}</div><div class="l">deploys</div></div>
          <div class="stat"><div class="n">{compactNumber(snapshot.distinctSkills)}</div><div class="l">distinct skills</div></div>
          {#if medianGap}
            <div class="stat" data-testid="telemetry-median-gap"><div class="n">{medianGap}</div><div class="l" title="Median gap between sessions on this Mac">median gap on this Mac</div></div>
          {/if}
        </div>
        {#if snapshot.modelMix}
          <div class="mix" data-testid="telemetry-model-mix">
            {#each mixParts(snapshot.modelMix) as part (part.label)}
              <span class="mx"><i class="dot" style:background={vizColor(part.label)}></i>{part.label}<span class="pc">{part.share}</span></span>
            {/each}
          </div>
        {/if}
      </section>

      <section data-section="tokens-per-day" tabindex="-1">
        <div class="sech">Tokens per day · stacked by model <span class="grow"></span>
          <span class="lg" data-testid="telemetry-legend">{#each bandLabels as label (label)}<span class="lgi"><i data-legend={label} style:background={vizColor(label)}></i>{label}</span>{/each}</span>
        </div>
        <div class="chart" data-testid="telemetry-bars">
          <span class="pk">{snapshot.peakLabel}</span>
          {#each snapshot.days as day, i (i)}
            <div class="d" class:today={day.today} title={dayTooltip(day, bandLabels)}>
              {#each dayBands(day, bandLabels) as band (band.label)}
                <i data-band={band.label} data-tokens={band.tokens} style:background={band.color} style:height="{bandPercent(band.tokens, maxStack)}%"></i>
              {/each}
            </div>
          {/each}
        </div>
        <div class="spark-lb">{#each snapshot.dayLabels as label (label)}<span>{label}</span>{/each}</div>
      </section>

      <div class="two">
        <section data-section="models" tabindex="-1" data-testid="telemetry-models">
          <div class="sech">Models
            <div class="tabs" role="tablist" aria-label="Group models">
              <button class="tab" role="tab" aria-selected={modelView === "family"} onclick={() => (modelView = "family")}>By family</button>
              <button class="tab" role="tab" aria-selected={modelView === "model"} onclick={() => (modelView = "model")}>By model</button>
            </div>
          </div>
          <div class="trow hd"><span>Model</span><span class="n">Tokens</span><span>Share</span><span class="n">%</span><span class="n">Cost</span></div>
          {#if modelView === "family"}
            {#each families as f (f.family)}
              {@const open = openFamilies.includes(f.family)}
              {#if f.models.length}
                <button class="trow fam" aria-expanded={open} data-family={f.family} title={tokenTypes(f)} onclick={() => toggleFamily(f.family)}>
                  <span class="nm"><span class="chev" class:open aria-hidden="true">›</span><i class="dot" style:background={vizColor(f.family)}></i>{f.family}<span class="m">{familyNote(f.family) || `${f.models.length} ${f.models.length === 1 ? "model" : "models"}`}</span></span>
                  <span class="n" title={f.total.toLocaleString("en-US")}>{compactNumber(f.total)}</span>
                  <span class="bar"><i style:width="{sharePercent(f.total, tokenTotal)}%" style:background={vizColor(f.family)}></i></span>
                  <span class="n">{sharePercent(f.total, tokenTotal)}%</span>
                  <span class="n">{formatMoney(f.costUsd)}</span>
                </button>
              {:else}
                <div class="trow" data-family={f.family} title={tokenTypes(f)}>
                  <span class="nm"><i class="dot" style:background={vizColor(f.family)}></i>{f.family}</span>
                  <span class="n">{compactNumber(f.total)}</span>
                  <span class="bar"><i style:width="{sharePercent(f.total, tokenTotal)}%" style:background={vizColor(f.family)}></i></span>
                  <span class="n">{sharePercent(f.total, tokenTotal)}%</span>
                  <span class="n">{formatMoney(f.costUsd)}</span>
                </div>
              {/if}
              {#if open}
                {#each f.models as m (m.id)}
                  <div class="trow sub-row" data-model={m.id} title={tokenTypes(m)}>
                    <span class="nm"><i class="dot" style:background={vizColor(f.family)} style:opacity={modelShadeOpacity(modelRank.get(m.id) ?? 0)}></i>{m.name}<span class="m mono">{m.id}</span></span>
                    <span class="n" title={m.total.toLocaleString("en-US")}>{compactNumber(m.total)}</span>
                    <span class="bar"><i style:width="{sharePercent(m.total, tokenTotal)}%" style:background={vizColor(f.family)} style:opacity={modelShadeOpacity(modelRank.get(m.id) ?? 0)}></i></span>
                    <span class="n">{sharePercent(m.total, tokenTotal)}%</span>
                    <span class="n">{formatMoney(m.costUsd)}</span>
                  </div>
                {/each}
              {/if}
            {/each}
          {:else}
            {#each flat as m (m.id)}
              <div class="trow" data-model={m.id} title={tokenTypes(m)}>
                <span class="nm"><i class="dot" style:background={vizColor(m.family)} style:opacity={modelShadeOpacity(modelRank.get(m.id) ?? 0)}></i>{m.name}<span class="m">{m.provider || "Other"}</span></span>
                <span class="n" title={m.total.toLocaleString("en-US")}>{compactNumber(m.total)}</span>
                <span class="bar"><i style:width="{sharePercent(m.total, tokenTotal)}%" style:background={vizColor(m.family)} style:opacity={modelShadeOpacity(modelRank.get(m.id) ?? 0)}></i></span>
                <span class="n">{sharePercent(m.total, tokenTotal)}%</span>
                <span class="n">{formatMoney(m.costUsd)}</span>
              </div>
            {/each}
          {/if}
          {#if snapshot.unattributed}
            <div class="trow" data-testid="telemetry-model-other">
              <span class="nm"><i class="dot" style:background={vizColor("Other")}></i>Other / unattributed</span>
              <span class="n">{compactNumber(snapshot.unattributed.tokens)}</span>
              <span class="bar"><i style:background={vizColor("Other")} style:width="{sharePercent(snapshot.unattributed.tokens, tokenTotal)}%"></i></span>
              <span class="n">{sharePercent(snapshot.unattributed.tokens, tokenTotal)}%</span>
              <span class="n"></span>
            </div>
          {/if}
          <div class="trow tot" data-testid="telemetry-model-total"><span>Total</span><span class="n">{compactNumber(tokenTotal)}</span><span></span><span class="n">100%</span><span class="n">{formatMoney(costTotal)}</span></div>
          {#if snapshot.unattributed?.note}<p class="foot" data-testid="telemetry-model-other-note">{snapshot.unattributed.note}</p>{/if}
          <p class="foot dim" data-testid="telemetry-cost-note">Cost is an estimate for Claude models at list price with cache discounts applied ({LIST_RATE_LABEL}).{#if anyUnpriced}{" "}Models without a cost run on subscription plans, so HQ has no price for them.{/if}</p>
          <div class="statline io">
            <div class="stat"><div class="n">{snapshot.io.input}</div><div class="l">input</div></div>
            <div class="stat"><div class="n">{snapshot.io.output}</div><div class="l">output</div></div>
            <div class="stat"><div class="n">{snapshot.io.cacheWrite}</div><div class="l">cache write</div></div>
            <div class="stat"><div class="n">{snapshot.io.cacheRead}</div><div class="l">cache read</div></div>
          </div>
        </section>

        <section data-section="skills" tabindex="-1" data-testid="telemetry-top-skills">
          <div class="sech">Skills <span class="grow"></span>
            {#if !allSkills && snapshot.skills.length > TOP_SKILLS}
              <button class="lnk" onclick={() => (allSkills = true)}><RailIcon name="chevron-down" />Show all {snapshot.skills.length}</button>
            {/if}
          </div>
          {#each skillRows as skill (skill.name)}
            <div class="sk">
              <span class="nm">{skill.name}</span>
              <span class="n">{compactNumber(skill.count)}</span>
              <span class="bar quiet"><i style:width="{Math.round((skill.count / skillMax) * 100)}%"></i></span>
            </div>
          {/each}
        </section>
      </div>

      {#if showSessions}
        <section data-section="sessions" tabindex="-1" data-testid="telemetry-sessions">
          <div class="sech">Sessions on this Mac
            {#if sessions}<span class="meta" data-testid="telemetry-sessions-count">{sessions.total.toLocaleString("en-US")}</span>{/if}
            <span class="grow"></span>
            {#if sessions && !allSessions && sessions.total > RECENT_SESSIONS}
              <button class="lnk" onclick={() => void showAllSessions()}><RailIcon name="chevron-down" />Show all {sessions.total.toLocaleString("en-US")}</button>
            {/if}
          </div>
          {#if !sessions && sessionsLoading}
            <ReadLoader testid="telemetry-sessions-loading" onretry={() => void loadSessions(range)} />
          {:else if !sessions && sessionsFailed}
            <p class="foot">Could not read the sessions on this Mac. <button class="lnk" onclick={() => void loadSessions(range)}><RailIcon name="refresh" />Tap to retry</button></p>
          {:else if sessions}
            <div class="srow hd"><span>When</span><span>Company</span><span>Project</span><span>Title</span><span class="n">Length</span></div>
            {#each visibleSessions as row (row.id)}
              <button
                class="srow hq-contain-row"
                data-session={row.id}
                disabled={!row.threadPath}
                title={row.threadPath ? "Open the session record in Files" : undefined}
                onclick={() => row.threadPath && onopenthread?.(row.threadPath)}
              >
                <span>{row.when}</span>
                <span class="co">{#if row.company}<CompanyLabel name={row.company} />{:else}<span class="unbound" title="This session was not bound to a company">No company</span>{/if}</span>
                <span title={row.project || undefined}>{row.project}</span>
                <span class="pr" title={row.title || undefined}>{row.title}</span>
                <span class="n">{row.length}</span>
              </button>
            {/each}
            {#if allSessions && sessions.rows.length < sessions.total}
              <ShowMoreRow
                shown={sessions.rows.length}
                total={sessions.total}
                next={Math.min(LIST_PAGE_SIZE, sessions.total - sessions.rows.length)}
                noun="sessions"
                testid="telemetry-sessions-show-more"
                onmore={() => void moreSessions()}
              />
            {/if}
            <p class="foot" data-testid="telemetry-sessions-note">{LOCAL_SESSIONS_NOTE} Nothing here is sent anywhere.</p>
          {/if}
        </section>
      {/if}
    {/if}
  </main>
</div>

<style>
  /* Console-rail chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px Geist everywhere else, numbers in tabular sans,
     mono only for model ids, 31px rows. */
  .telemetry {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--t1, var(--v4-text-1));
    font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif);
    background: var(--v4-ground, transparent);
  }
  .tab, .lnk { font: inherit; font-size: 13px; color: inherit; background: transparent; border: 0; cursor: pointer; }
  .srow:hover:not(:disabled), .trow.fam:hover, .lnk:hover, .tab:hover { background: var(--hover, var(--v4-hover)); }
  .meta, .sub, .l, .m, .foot, .pk, .spark-lb, .unbound { color: var(--t3, var(--v4-text-3)); }
  .meta { font-weight: 400; font-variant-numeric: tabular-nums; }
  .tabs { display: inline-flex; gap: 2px; padding: 2px; width: max-content; border: 1px solid var(--panel-border, var(--v4-control-border)); border-radius: 6px; background: var(--hover, var(--v4-hover)); }
  .tab { padding: 4px 8px; border-radius: 4px; color: var(--t2, var(--v4-text-2)); }
  .tab[aria-selected="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .toolbar { display: flex; align-items: center; gap: 8px; min-height: 52px; flex: none; flex-wrap: wrap; box-sizing: border-box; padding: 8px 20px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .toolbar h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; white-space: nowrap; }
  .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grow { flex: 1; }
  .canvas { flex: 1; min-height: 0; padding: 16px 20px 20px; overflow: auto; display: flex; flex-direction: column; gap: 24px; }
  section:focus { outline: none; }
  /* Totals: one tier. Numbers at the canvas's second size (20px, regular so
     the page title stays the only 500 at 20px), quiet labels, even columns. */
  .statline { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 12px 24px; align-items: start; }
  .statline.io { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 12px; padding: 0 8px; }
  .stat { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .stat .n { font-size: var(--type-title, 20px); line-height: var(--type-title-line, 1.25); font-weight: 400; text-align: left; color: var(--t1, var(--v4-text-1)); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .stat .n small { font-size: 13px; font-weight: 400; color: var(--t3, var(--v4-text-3)); margin-left: 4px; }
  .statline.io .stat .n { font-size: 13px; line-height: 1.45; font-weight: 500; }
  .mix { display: flex; flex-wrap: wrap; gap: 4px 16px; margin-top: 10px; color: var(--t2, var(--v4-text-2)); }
  .mx { display: inline-flex; align-items: center; gap: 6px; }
  .mx .pc { color: var(--t3, var(--v4-text-3)); font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--viz-neutral); }
  .sech { display: flex; align-items: center; gap: 8px; min-height: 28px; margin: 0 0 4px; font-weight: 500; color: var(--t2, var(--v4-text-2)); }
  .lnk { height: 26px; padding: 0 8px; border-radius: 6px; font-weight: 400; color: var(--t2, var(--v4-text-2)); }
  .lg { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 4px 12px; font-weight: 400; color: var(--t3, var(--v4-text-3)); }
  .lgi { display: inline-flex; align-items: center; gap: 6px; }
  .lg i, .chart i, .bar i { background: var(--viz-neutral); }
  .lg i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  /* The top padding keeps the peak label clear of the tallest stack. */
  .chart { position: relative; height: 116px; box-sizing: border-box; padding-top: 20px; display: flex; align-items: flex-end; gap: 3px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  /* First legend entry sits on the baseline: stacks build upward in legend order. */
  .chart .d { flex: 1; height: 100%; display: flex; flex-direction: column-reverse; justify-content: flex-start; min-width: 0; }
  /* 1px surface gap between stacked segments, inside each segment's height
     so a full stack never exceeds the plot. */
  .chart .d i { display: block; width: 100%; box-sizing: border-box; border-top: 1px solid transparent; background-clip: padding-box; }
  .pk { position: absolute; right: 0; top: 0; }
  .spark-lb { display: flex; justify-content: space-between; margin-top: 4px; }
  .two { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 28px; }
  .srow, .trow {
    display: grid; gap: 10px; align-items: center; width: 100%; height: 31px; box-sizing: border-box;
    padding: 0 8px; border: 0; border-radius: 8px;
    background: transparent; color: var(--t2, var(--v4-text-2)); font: inherit; font-size: 13px; text-align: left;
  }
  .srow { grid-template-columns: 96px 120px 140px minmax(0, 1fr) 64px; cursor: pointer; }
  .srow:disabled { cursor: default; color: var(--t2, var(--v4-text-2)); }
  .trow { grid-template-columns: minmax(0, 1.6fr) 64px minmax(48px, 1fr) 40px 88px; }
  .trow.fam { cursor: pointer; }
  .sub-row .nm { padding-left: 18px; color: var(--t2, var(--v4-text-2)); }
  .srow > *, .trow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hd { color: var(--t3, var(--v4-text-3)); font-weight: 400; cursor: default; }
  .hd .n { color: inherit; }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .n { font-variant-numeric: tabular-nums; text-align: right; color: var(--t1, var(--v4-text-1)); }
  .pr, .m { color: var(--t3, var(--v4-text-3)); }
  .m { margin-left: 6px; }
  .chev { display: inline-block; width: 12px; color: var(--t3, var(--v4-text-3)); transition: transform 120ms ease; }
  .chev.open { transform: rotate(90deg); }
  .sk { display: grid; align-items: center; gap: 10px; height: 31px; padding: 0 8px; grid-template-columns: minmax(0, 1fr) 44px 90px; }
  .sk > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 3px; background: var(--btn-bg, var(--v4-control-faint)); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; }
  .bar.quiet i { background: var(--viz-quiet); }
  .foot { margin: 8px 0 0; padding: 0 8px; }
  .foot.dim { opacity: 0.72; }
  .empty-line { margin: 0; padding: 48px 16px; text-align: center; font-size: 13px; color: var(--t3); }
  .co { display: flex; align-items: center; gap: 6px; }
  .nm { display: flex; align-items: center; gap: 6px; color: var(--t1, var(--v4-text-1)); }
  /* One column under ~1100px; nothing scrolls sideways at 1000x700. */
  @media (max-width: 1100px) {
    .two { grid-template-columns: minmax(0, 1fr); }
  }
</style>
