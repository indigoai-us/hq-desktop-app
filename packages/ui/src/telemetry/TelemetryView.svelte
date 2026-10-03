<script lang="ts">
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
  /**
   * My Telemetry (US-032). Paints the cached snapshot on the first frame,
   * then refreshes in the background. Charts are CSS bars in text-1 opacities.
   */
  import { onMount, tick, untrack } from "svelte";
  import "../chat/scroll-perf.css";
  import "../common/button/rail-type.css";
  import type { TelemetryCache } from "./telemetry-cache.js";
  import {
    LIST_RATE_LABEL,
    bandOpacity,
    bandPercent,
    chartBandLabels,
    dayBands,
    dayTooltip,
    formatTokens,
    formatUsd,
    hasListRate,
    hasNoTelemetryActivity,
    TELEMETRY_EMPTY_COPY,
    listRateUsd,
    outcomesForFilter,
    sessionsForFilter,
    sharePercent,
    snapshotForRange,
    stackMax,
    toCsv,
    type OutcomeFilter,
    type SessionFilter,
    type TelemetryPage,
    type TelemetryRange,
    type TelemetrySession,
    type TelemetrySnapshot,
    type TokenStack,
  } from "./telemetry-model.js";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { pageRows } from "../shell/list-paging.js";

  interface Props {
    cache: TelemetryCache;
    scope?: string;
    onskills?: () => void;
    onopen?: (session: TelemetrySession, label: string) => void;
  }

  let { cache, scope = "all", onskills, onopen }: Props = $props();

  let base = $state<TelemetrySnapshot | null>(untrack(() => cache.cached()));
  let refreshing = $state(false);
  // Plain reason from the last failed load; the raw error goes to the console.
  let loadError = $state("");
  let page = $state<TelemetryPage>("overview");
  let range = $state<TelemetryRange>("30d");
  // Every figure on screen reads the snapshot recomputed for the chosen range.
  const snapshot = $derived(base ? snapshotForRange(base, range) : null);
  let activeScope = $state(untrack(() => scope));
  let sessionFilter = $state<SessionFilter>("all");
  let outcomeFilter = $state<OutcomeFilter>("all");
  let tokenStack = $state<TokenStack>("model");
  let selectedId = $state<string | null>(null);
  let transcriptFor = $state<string | null>(null);

  const selected = $derived(
    snapshot?.sessionsRows.find((row) => row.id === selectedId) ??
      snapshot?.sessionsRows[0] ??
      null,
  );
  const sessionRows = $derived(
    snapshot ? sessionsForFilter(snapshot.sessionsRows, sessionFilter) : [],
  );
  const outcomeRows = $derived(
    snapshot ? outcomesForFilter(snapshot.sessionsRows, outcomeFilter) : [],
  );
  const maxStack = $derived(snapshot ? stackMax(snapshot.days) : 0);
  // Chart bands are the By-model rows plus Other, in table order.
  const bandLabels = $derived(snapshot ? chartBandLabels(snapshot) : []);
  const skillMax = $derived(snapshot?.skills[0]?.count ?? 1);
  let skillsSection = $state<HTMLElement | null>(null);

  // QA-068: no host passes onskills, so both Skills controls fell through to
  // a no-op. Without a host handler they open Overview and bring the Top
  // skills breakdown into view.
  async function showSkills(): Promise<void> {
    if (onskills) {
      onskills();
      return;
    }
    page = "overview";
    await tick();
    skillsSection?.scrollIntoView({ block: "start" });
    skillsSection?.focus({ preventScroll: true });
  }
  // Family rows plus the remainder row, so the table total matches the headline.
  const tokenTotal = $derived(
    (snapshot?.models.reduce(
      (sum, row) => sum + row.input + row.output + row.cacheWrite + row.cacheRead,
      0,
    ) ?? 0) + (snapshot?.unattributed?.tokens ?? 0),
  );
  // No telemetry endpoint returns tokens per day by company or actor yet, so
  // those tabs say so instead of redrawing the model bars under a new title.
  const stackUnavailable = $derived(tokenStack !== "model");

  const pages: { id: TelemetryPage; label: string; meta?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "sessions", label: "Sessions", meta: "…" },
    { id: "tokens", label: "Tokens" },
    { id: "outcomes", label: "Outcomes" },
  ];

  // The source has no per-company split yet, so the only scope is all work.
  const scopes = [{ id: "all", label: "All my work", mark: "", count: 0 }];

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
    refresh(next);
  }

  onMount(() => {
    if (!base && cache.fallback) base = cache.fallback;
    if (base && !base.endDate) range = base.range;
    refresh(range);
  });

  function exportCsv(): void {
    if (!snapshot) return;
    const blob = new Blob([toCsv(snapshot)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "telemetry.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  function selectSession(row: TelemetrySession): void {
    selectedId = row.id;
    if (page === "overview") page = "sessions";
  }

  // Sessions show every row, in pages of 50 with a Show more row.
  let sessionPages = $state(1);
  $effect(() => {
    void sessionFilter;
    void page;
    sessionPages = 1;
  });
  const sessionPage = $derived(pageRows(sessionRows, sessionPages));

  let sessionDays = $derived.by(() => {
    const groups: { day: string; rows: TelemetrySession[] }[] = [];
    for (const row of sessionPage.rows) {
      const last = groups[groups.length - 1];
      if (!last || last.day !== row.day) groups.push({ day: row.day, rows: [row] });
      else last.rows.push(row);
    }
    return groups;
  });
</script>

<div class="telemetry" data-testid="telemetry-view" data-refreshing={refreshing ? "true" : "false"}>
  <aside class="pane" aria-label="My Telemetry">
    <div class="pane-list">
      {#each pages as item (item.id)}
        <button
          class="row"
          aria-current={page === item.id ? "true" : undefined}
          onclick={() => (page = item.id)}
        >
          <span>{item.label}</span>
          {#if item.meta}<span class="meta" data-testid="telemetry-sessions-count">{snapshot ? String(snapshot.sessionsRows.length) : item.meta}</span>{/if}
        </button>
      {/each}
      <button class="row" onclick={() => void showSkills()}>
        <span>Skills</span>
        <span class="meta">{snapshot?.distinctSkills ?? ""}</span>
      </button>
      <div class="sec">Range</div>
      <div class="tabs" role="tablist">
        {#each ["7d", "30d", "90d"] as id (id)}
          <button
            class="tab"
            role="tab"
            aria-selected={range === id}
            onclick={() => pickRange(id as TelemetryRange)}
          >{id}</button>
        {/each}
      </div>
      <div class="sec">Scope</div>
      {#each scopes as item (item.id)}
        <button
          class="row"
          aria-current={activeScope === item.id ? "true" : undefined}
          onclick={() => (activeScope = item.id)}
        >
          {#if item.mark}<span class="mini">{item.mark}</span>{/if}
          <span>{item.label}</span>
          {#if item.id === "all" && activeScope === "all"}<span class="meta">On</span>
          {:else if item.count}<span class="meta">{item.count}</span>{/if}
        </button>
      {/each}
    </div>
  </aside>

  <main class="content">
    <div class="toolbar">
      <h1>
        {page === "overview" ? "My Telemetry" : page === "sessions" ? "Sessions" : page === "tokens" ? "Tokens" : "Outcomes"}
      </h1>
      <span class="sub meta-line" data-meta-line>
        {snapshot?.rangeLabel ?? "—"}
        {#if page === "tokens"} · all models{/if}
        · {snapshot?.subtitle ?? ""}
        {#if page === "sessions" && snapshot} · {snapshot.sessions} sessions{/if}
        {#if page === "outcomes" && snapshot} · what {snapshot.sessions} sessions produced{/if}
      </span>
      <span class="grow"></span>
      <span class="sub meta-line" data-meta-line>Only you can see this</span>
      <RailButton icon="download" onclick={exportCsv}>Export CSV</RailButton>
    </div>

    {#if snapshot && loadError}
      <p class="foot" data-testid="telemetry-stale">Showing saved numbers. {loadError} <button class="lnk" onclick={() => refresh()}>Retry</button></p>
    {/if}
    {#if snapshot?.optedOut}
      <p class="foot" data-testid="telemetry-opted-out">Personal telemetry is off for your account, so HQ has nothing recorded. Turn it on in Settings to start counting sessions.</p>
    {:else if snapshot?.notice}
      <p class="foot" data-testid="telemetry-notice">{snapshot.notice}</p>
    {/if}
    {#if !snapshot && loadError}
      <div class="canvas" role="alert" data-testid="telemetry-error">
        <p>{loadError}</p>
        <RailButton icon="refresh" data-testid="telemetry-retry" onclick={() => refresh()}>Retry</RailButton>
      </div>
    {:else if !snapshot}
      <div class="canvas" data-testid="telemetry-skeleton" aria-busy="true">
        <div class="statline">
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <div class="stat"><div class="n shimmer">&nbsp;</div><div class="l shimmer">&nbsp;</div></div>
          {/each}
        </div>
      </div>
    {:else if !snapshot.optedOut && hasNoTelemetryActivity(snapshot)}
      <div class="canvas">
        <p class="empty-line" data-testid="telemetry-empty">{TELEMETRY_EMPTY_COPY}</p>
      </div>
    {:else if page === "overview"}
      <div class="canvas">
        <div class="statline">
          <div class="stat"><div class="n" class:shimmer={refreshing}>{snapshot.sessions}<small>{snapshot.sessionsDelta}</small></div><div class="l">sessions</div></div>
          <div class="stat"><div class="n" class:shimmer={refreshing}>{snapshot.tokensLabel}<small>tokens</small></div><div class="l">{snapshot.modelMix}</div></div>
          <div class="stat"><div class="n">{snapshot.storiesShipped}</div><div class="l">stories shipped</div></div>
          <div class="stat"><div class="n">{snapshot.deploys}</div><div class="l">deploys</div></div>
          <div class="stat"><div class="n">{snapshot.distinctSkills}</div><div class="l">distinct skills</div></div>
          <div class="stat"><div class="n">{snapshot.medianGap}</div><div class="l">median session gap</div></div>
        </div>
        <div>
          <div class="sech">Tokens per day · stacked by model <span class="grow"></span>
            <span class="lg" data-testid="telemetry-legend">{#each bandLabels as label, i (label)}<i style:opacity={bandOpacity(i)}></i>{label}{/each}</span>
          </div>
          <div class="chart" aria-hidden="true">
            <span class="pk">{snapshot.peakLabel}</span>
            {#each snapshot.days as day, i (i)}
              <div class="d" class:today={day.today} title={dayTooltip(day, bandLabels)}>
                {#each dayBands(day, bandLabels) as band (band.label)}
                  <i data-band={band.label} data-tokens={band.tokens} style:opacity={band.opacity} style:height="{bandPercent(band.tokens, maxStack)}%"></i>
                {/each}
              </div>
            {/each}
          </div>
          <div class="spark-lb">{#each snapshot.dayLabels as label (label)}<span>{label}</span>{/each}</div>
        </div>
        <div class="two">
          <div>
            <div class="sech">Sessions <span class="grow"></span>
              <button class="lnk" onclick={() => (page = "sessions")}>Show all {snapshot.sessionsRows.length}</button>
            </div>
            <div class="srow hd"><span>When</span><span>Company</span><span>Project</span><span class="n">Length</span><span class="n">Tokens</span><span>Outcome</span></div>
            <div class="scroll">
              {#each snapshot.sessionsRows as row (row.id)}
                <button class="srow hq-contain-row" aria-current={selected?.id === row.id ? "true" : undefined} onclick={() => selectSession(row)}>
                  <span>{row.when}</span>
                  <span class="co"><CompanyLabel name={row.company} /></span>
                  <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                  <span class="n">{row.length}</span>
                  <span class="n">{row.tokensLabel}</span>
                  <span class="oc {row.outcomeKind}"><span class="dot" class:live={row.outcomeKind === "live"} class:err={row.outcomeKind === "error"}></span>{row.outcome}</span>
                </button>
              {/each}
            </div>
            <p class="foot">Sessions on your laptop, your Outpost, and bots running under your identity. Company admins see totals only, never transcripts.</p>
          </div>
          <div bind:this={skillsSection} tabindex="-1" data-testid="telemetry-top-skills">
            <div class="sech">Top skills <span class="grow"></span>
              <button class="lnk" onclick={() => void showSkills()}>{snapshot.distinctSkills} total</button>
            </div>
            {#each snapshot.skills as skill (skill.name)}
              <div class="sk">
                <span class="nm">{skill.name}</span>
                <span class="n">{skill.count}</span>
                <span class="bar"><i style:width="{Math.round((skill.count / skillMax) * 100)}%"></i></span>
              </div>
            {/each}
            <div class="sech gap">Bots acting on your behalf <span class="grow"></span>
              <span class="status"><span class="dot" class:live={snapshot.bots.some((b) => b.live)}></span>{snapshot.bots.filter((b) => b.live).length} live</span>
            </div>
            {#each snapshot.bots as bot (bot.name)}
              <div class="bot">
                <span class="nm">{bot.name}<span class="m">{bot.meta}</span></span>
                <span class="status"><span class="dot" class:live={bot.live}></span>{bot.status}</span>
              </div>
            {/each}
          </div>
        </div>
      </div>
    {:else if page === "sessions"}
      <div class="canvas sessions">
        <div class="table">
          <div class="sech">Filter
            <div class="tabs" role="tablist">
              {#each [["all", "All"], ["mine", "Mine"], ["bots", "Via bots"], ["outpost", "Outpost"], ["failed", "Failed"]] as item (item[0])}
                <button class="tab" role="tab" aria-selected={sessionFilter === item[0]} onclick={() => (sessionFilter = item[0] as SessionFilter)}>{item[1]}</button>
              {/each}
            </div>
            <span class="grow"></span>
            {#if snapshot.outcomeCounts.live > 0}<span class="status"><span class="dot live"></span>{snapshot.outcomeCounts.live} in progress</span>{/if}
          </div>
          <div class="srow hd wide" data-testid="telemetry-sessions-head"><span>When</span><span>Company</span><span>Project</span><span>Host</span><span class="n">Length</span><span class="n">Tokens</span><span>Outcome</span></div>
          <div class="scroll">
            {#each sessionDays as group (group.day)}
              <div class="day">{group.day}</div>
              {#each group.rows as row (row.id)}
                <button class="srow wide hq-contain-row" aria-current={selected?.id === row.id ? "true" : undefined} onclick={() => (selectedId = row.id)}>
                  <span>{row.when}</span>
                  <span class="co"><CompanyLabel name={row.company} /></span>
                  <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                  <span class="host">{row.host}</span>
                  <span class="n">{row.length}</span>
                  <span class="n">{row.tokensLabel}</span>
                  <span class="oc {row.outcomeKind}"><span class="dot" class:live={row.outcomeKind === "live"} class:err={row.outcomeKind === "error"}></span>{row.outcome}</span>
                </button>
              {/each}
            {/each}
            {#if sessionPage.remaining > 0}
              <ShowMoreRow shown={sessionPage.rows.length} total={sessionPage.total} next={sessionPage.next} noun="sessions" testid="telemetry-sessions-show-more" onmore={() => (sessionPages += 1)} />
            {/if}
          </div>
        </div>
        {#if selected}
          <aside class="detail" aria-label="Session">
            <div class="dh">
              <div class="tt">{selected.project} {#if selected.outcomeKind === "live"}<span class="status"><span class="dot live"></span>Live</span>{/if}</div>
              <div class="mm">{selected.detail || selected.outcome} · {selected.length}</div>
            </div>
            <div class="acts">
              <RailButton icon="file" variant="primary" onclick={() => (transcriptFor = selected.id)}>Open transcript</RailButton>
              <RailButton icon="claude-code" onclick={() => onopen?.(selected, "claude")}>Open in Claude Code</RailButton>
              <RailButton icon="arrow-right" onclick={() => onopen?.(selected, "atlas")}>Atlas</RailButton>
            </div>
            {#if transcriptFor === selected.id}
              <div class="transcript" data-testid="telemetry-transcript">
                <p>In-app transcript for {selected.id}. Company admins do not see this.</p>
                {#each selected.timeline as line (line.at + line.text)}
                  <p><span class="m0">{line.at}</span> {line.text}</p>
                {/each}
              </div>
            {/if}
            <div class="kv">
              <span class="k">Company</span><span class="v"><CompanyLabel name={selected.company} /></span>
              <span class="k">Host</span><span class="v">{selected.host}</span>
              <span class="k">Actor</span><span class="v">{selected.actor === "you" ? "You" : selected.host}</span>
              <span class="k">Session</span><span class="v mono">{selected.id}</span>
              <span class="k">Branch</span><span class="v mono">{selected.branch}</span>
              <span class="k">Tokens</span><span class="v">{selected.tokensLabel} · {selected.tokensIn} · {selected.tokensOut}</span>
              <span class="k">Cost</span><span class="v">{selected.costLabel} · {LIST_RATE_LABEL}</span>
            </div>
            <div class="sech">By model</div>
            <div class="split">
              <i style:width="{selected.modelSplit.opus}%"></i>
              <i class="s" style:width="{selected.modelSplit.sonnet}%"></i>
              <i class="h" style:width="{selected.modelSplit.haiku}%"></i>
            </div>
            <div class="lg"><span>Opus {selected.modelSplit.opus}%</span><span>Sonnet {selected.modelSplit.sonnet}%</span><span>Haiku {selected.modelSplit.haiku}%</span></div>
            <div class="sech">Skills used</div>
            <div class="chips">{#each selected.skills as skill (skill)}<span class="tag">{skill}</span>{/each}</div>
            <div class="sech">Timeline</div>
            {#each selected.timeline as line (line.at + line.text)}
              <div class="tl" class:live={line.live}><span class="m0">{line.at}</span><span>{line.text}</span></div>
            {/each}
            <p class="foot">Transcripts stay on this device and in your personal vault. Company admins see totals only.</p>
          </aside>
        {/if}
      </div>
    {:else if page === "tokens"}
      <div class="canvas">
        <div class="statline">
          <div class="stat"><div class="n">{snapshot.tokensLabel}<small>{snapshot.tokensDelta}</small></div><div class="l">tokens, {snapshot.days.length} days</div></div>
          <div class="stat" data-testid="telemetry-list-cost"><div class="n">{formatUsd(snapshot.listCostUsd)}<small>est.</small></div><div class="l">cost at list price</div></div>
          <div class="stat"><div class="n">{snapshot.perDay}</div><div class="l">per day, average</div></div>
          <div class="stat"><div class="n">{snapshot.perSession}</div><div class="l">per session, median</div></div>
          <div class="stat"><div class="n">{snapshot.cacheReadShare}</div><div class="l">cache read share</div></div>
        </div>
        <div>
          <div class="sech">Tokens per day · stacked by {tokenStack}
            <div class="tabs" role="tablist">
              {#each [["model", "Model"], ["company", "Company"], ["actor", "Actor"]] as item (item[0])}
                <button class="tab" role="tab" aria-selected={tokenStack === item[0]} onclick={() => (tokenStack = item[0] as TokenStack)}>{item[1]}</button>
              {/each}
            </div>
            <span class="grow"></span>
            {#if tokenStack === "model"}<span class="lg" data-testid="telemetry-legend">{#each bandLabels as label, i (label)}<i style:opacity={bandOpacity(i)}></i>{label}{/each}</span>{/if}
          </div>
          {#if stackUnavailable}
          <p class="foot" data-testid="telemetry-stack-unavailable">{tokenStack === "company" ? "Company" : "Actor"} breakdown isn't available yet. HQ does not report tokens per day by {tokenStack} for your account.</p>
          {:else}
          <div class="chart" data-testid="telemetry-bars">
            <span class="pk">{snapshot.peakLabel}</span>
            {#each snapshot.days as day, i (i)}
              <div class="d" class:today={day.today} title={dayTooltip(day, bandLabels)}>
                {#each dayBands(day, bandLabels) as band (band.label)}
                  <i data-band={band.label} data-tokens={band.tokens} style:opacity={band.opacity} style:height="{bandPercent(band.tokens, maxStack)}%"></i>
                {/each}
              </div>
            {/each}
          </div>
          <div class="spark-lb">{#each snapshot.dayLabels as label (label)}<span>{label}</span>{/each}</div>
          {/if}
        </div>
        <div class="two">
          <div>
            <div class="sech">By model</div>
            <div class="trow hd"><span>Model</span><span class="n">Tokens</span><span>Share</span><span class="n">%</span><span class="n">Cost</span></div>
            {#each snapshot.models as model (model.model)}
              {@const tokens = model.input + model.output + model.cacheWrite + model.cacheRead}
              <div class="trow">
                <span class="nm"><i class={model.family ?? ""}></i>{model.label}<span class="m">{model.hint}</span></span>
                <span class="n">{formatTokens(tokens)}</span>
                <span class="bar"><i style:width="{sharePercent(tokens, tokenTotal)}%"></i></span>
                <span class="n">{sharePercent(tokens, tokenTotal)}%</span>
                <span class="n">{hasListRate(model) ? formatUsd(listRateUsd(model)) : "—"}</span>
              </div>
            {/each}
            {#if snapshot.unattributed}
              <div class="trow" data-testid="telemetry-model-other">
                <span class="nm"><i></i>Other / unattributed</span>
                <span class="n">{formatTokens(snapshot.unattributed.tokens)}</span>
                <span class="bar"><i style:width="{sharePercent(snapshot.unattributed.tokens, tokenTotal)}%"></i></span>
                <span class="n">{sharePercent(snapshot.unattributed.tokens, tokenTotal)}%</span>
                <span class="n">—</span>
              </div>
            {/if}
            <div class="trow tot" data-testid="telemetry-model-total"><span>Total</span><span class="n">{formatTokens(tokenTotal)}</span><span></span><span class="n">100%</span><span class="n">{formatUsd(snapshot.listCostUsd)}</span></div>
            {#if snapshot.unattributed?.note}<p class="foot" data-testid="telemetry-model-other-note">{snapshot.unattributed.note}</p>{/if}
            <div class="sech gap">Input, output, cache</div>
            <div class="statline">
              <div class="stat"><div class="n">{snapshot.io.input}</div><div class="l">input</div></div>
              <div class="stat"><div class="n">{snapshot.io.cacheRead}</div><div class="l">cache read</div></div>
              <div class="stat"><div class="n">{snapshot.io.cacheWrite}</div><div class="l">cache write</div></div>
              <div class="stat"><div class="n">{snapshot.io.output}</div><div class="l">output</div></div>
            </div>
          </div>
          <div>
            <div class="sech">By company</div>
            {#each snapshot.byCompany as row (row.id)}
              <div class="trow">
                <span class="nm"><CompanyLabel name={row.label} companyUid={row.id} /><span class="m">{row.meta}</span></span>
                <span class="n">{formatTokens(row.tokens)}</span>
                <span class="bar"><i style:width="{sharePercent(row.tokens, tokenTotal)}%"></i></span>
                <span class="n">{sharePercent(row.tokens, tokenTotal)}%</span>
                <span class="n">{formatUsd(row.costUsd)}</span>
              </div>
            {/each}
            <div class="sech gap">By actor</div>
            {#each snapshot.byActor as row (row.id)}
              <div class="trow">
                <span class="nm"><span class="mini" class:sq={row.bot}>{row.mark}</span>{row.label}<span class="m">{row.meta}</span></span>
                <span class="n">{formatTokens(row.tokens)}</span>
                <span class="bar"><i style:width="{sharePercent(row.tokens, tokenTotal)}%"></i></span>
                <span class="n">{sharePercent(row.tokens, tokenTotal)}%</span>
                <span class="n">{formatUsd(row.costUsd)}</span>
              </div>
            {/each}
            <p class="foot">Cost is an estimate at Anthropic list price with cache discounts applied ({LIST_RATE_LABEL}). Company plans are flat; token spend is not billed to you.</p>
          </div>
        </div>
      </div>
    {:else}
      <div class="canvas">
        <div class="cards">
          {#each [
            ["all", String(snapshot.outcomeCounts.all), "All sessions", `${snapshot.outcomeCounts.live} in progress`],
            ["deployed", String(snapshot.outcomeCounts.deployed), "Deployed", snapshot.outcomeCounts.deployedMeta],
            ["shipped", String(snapshot.outcomeCounts.shipped), "Shipped", snapshot.outcomeCounts.shippedMeta],
            ["blocked", String(snapshot.outcomeCounts.blocked), "Blocked", snapshot.outcomeCounts.blockedMeta],
            ["none", String(snapshot.outcomeCounts.none), "No change", snapshot.outcomeCounts.noneMeta],
          ] as card (card[0])}
            <button class="card" aria-pressed={outcomeFilter === card[0]} onclick={() => (outcomeFilter = card[0] as OutcomeFilter)}>
              <div class="n">{card[1]}</div>
              <div class="l" class:err={card[0] === "blocked"}>{card[2]}</div>
              <div class="m">{card[3]}</div>
            </button>
          {/each}
        </div>
        <div>
          <div class="sech">Mix <span class="grow"></span><span class="lnk">other {snapshot.mix.other}%</span></div>
          <div class="mix">
            <i style:width="{snapshot.mix.deployed}%"></i>
            <i class="s" style:width="{snapshot.mix.shipped}%"></i>
            <i class="err" style:width="{snapshot.mix.blocked}%"></i>
            <i class="dim" style:width="{snapshot.mix.none}%"></i>
          </div>
          <div class="lg">
            <span>deployed {snapshot.mix.deployed}%</span>
            <span>shipped {snapshot.mix.shipped}%</span>
            <span>blocked {snapshot.mix.blocked}%</span>
            <span>no change {snapshot.mix.none}%</span>
            <span>other {snapshot.mix.other}%</span>
          </div>
        </div>
        <div>
          <div class="sech">Sessions by outcome</div>
          <div class="srow hd out"><span>When</span><span>Company</span><span>Project</span><span>Outcome</span><span>Detail</span><span class="n">Open</span></div>
          <div class="scroll">
            {#each outcomeRows as row (row.id)}
              <button class="srow out hq-contain-row" onclick={() => onopen?.(row, row.openLabel)}>
                <span>{row.when}</span>
                <span class="co"><CompanyLabel name={row.company} /></span>
                <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                <span class="oc {row.outcomeKind}"><span class="dot" class:live={row.outcomeKind === "live"} class:err={row.outcomeKind === "error"}></span>{row.outcome}</span>
                <span class="host">{row.detail || row.branch}</span>
                <span class="n">{row.openLabel}</span>
              </button>
            {/each}
          </div>
          <p class="foot">Outcome is the session's last recorded signal: a deploy, a merged story, a blocked task, or no file or remote change. Branch pushed and report posted stay in other.</p>
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  /* Console-rail chrome measured from Messages (docs/design-standard-console-rail.md):
     one 20px/500 title, 13px Geist everywhere else, numbers in tabular sans,
     mono only for session ids and branches, 31px rows, status as dot plus text. */
  .telemetry {
    display: flex;
    height: 100%;
    min-height: 0;
    color: var(--t1, var(--v4-text-1));
    font: 400 13px/1.45 var(--font-ui, "Geist", -apple-system, sans-serif);
    background: var(--v4-ground, transparent);
  }
  .pane { width: 260px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--line, var(--v4-rowline)); }
  .pane-list { overflow: auto; padding: 12px 14px; }
  .row, .tab, .lnk, .card { font: inherit; font-size: 13px; color: inherit; background: transparent; border: 0; cursor: pointer; }
  .row {
    display: flex; align-items: center; gap: 8px; width: 100%; height: 31px; box-sizing: border-box;
    text-align: left; padding: 7px 8px; border-radius: 8px; color: var(--t2, var(--v4-text-2));
  }
  .row[aria-current="true"], .srow[aria-current="true"], .card[aria-pressed="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); box-shadow: none; }
  .row:hover, .srow:hover, .lnk:hover, .tab:hover { background: var(--hover, var(--v4-hover)); }
  .meta, .sub, .l, .m, .m0, .foot, .pk, .spark-lb, .k { color: var(--t3, var(--v4-text-3)); }
  .meta { margin-left: auto; font-variant-numeric: tabular-nums; }
  .sec { padding: 12px 8px 4px; font-weight: 500; color: var(--t2, var(--v4-text-2)); }
  .tabs { display: inline-flex; gap: 2px; padding: 2px; width: max-content; border: 1px solid var(--panel-border, var(--v4-control-border)); border-radius: 6px; background: var(--hover, var(--v4-hover)); }
  .pane .tabs { margin: 0 8px; }
  .tab { padding: 4px 8px; border-radius: 4px; color: var(--t2, var(--v4-text-2)); }
  .tab[aria-selected="true"] { background: var(--sel, var(--v4-active-row)); color: var(--t1, var(--v4-text-1)); }
  .mini {
    width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 10px; background: var(--btn-bg, var(--v4-control-faint)); color: var(--t2, var(--v4-text-2)); flex: none;
  }
  .status, .oc { display: inline-flex; align-items: center; gap: 6px; color: var(--t2, var(--v4-text-2)); white-space: nowrap; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--t3, var(--v4-text-3)); flex: none; display: inline-block; }
  .dot.live { background: var(--ok, var(--v4-ok)); }
  .dot.err { background: var(--red, var(--v4-error)); }
  .tag { color: var(--t2, var(--v4-text-2)); background: var(--btn-bg, var(--v4-control-faint)); border-radius: 980px; padding: 3px 7px; }
  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; gap: 8px; height: 52px; flex: none; box-sizing: border-box; padding: 0 20px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .toolbar h1 { font-size: var(--type-title, 20px); font-weight: var(--type-title-weight, 500); line-height: var(--type-title-line, 1.25); margin: 0 4px 0 0; white-space: nowrap; }
  .sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .grow { flex: 1; }
  .canvas { padding: 16px 20px 20px; overflow: auto; display: flex; flex-direction: column; gap: 24px; }
  .statline { display: flex; gap: 8px 28px; flex-wrap: wrap; align-items: baseline; }
  .stat { display: flex; flex-direction: column; gap: 2px; }
  .stat .n { font-size: 13px; font-weight: 500; text-align: left; color: var(--t1, var(--v4-text-1)); }
  .stat .n small { font-size: 13px; font-weight: 400; color: var(--t3, var(--v4-text-3)); margin-left: 4px; }
  .sech { display: flex; align-items: center; gap: 8px; min-height: 28px; margin: 0 0 4px; font-weight: 500; color: var(--t2, var(--v4-text-2)); }
  .sech.gap { margin-top: 20px; }
  .lnk { height: 26px; padding: 0 8px; border-radius: 6px; font-weight: 400; color: var(--t2, var(--v4-text-2)); }
  .lg { display: flex; align-items: center; gap: 10px; font-weight: 400; color: var(--t2, var(--v4-text-2)); }
  .lg i, .nm i, .chart i, .split i, .mix i, .bar i { background: var(--t1, var(--v4-text-1)); }
  .lg i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: -4px; }
  .o, .nm .opus { opacity: 0.9; }
  .s, .nm .sonnet { opacity: 0.45; }
  .h, .nm .haiku { opacity: 0.18; }
  .chart { position: relative; height: 96px; display: flex; align-items: flex-end; gap: 3px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .chart .d { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
  .chart .d i { display: block; width: 100%; }
  .pk { position: absolute; right: 0; top: 0; }
  .spark-lb { display: flex; justify-content: space-between; margin-top: 4px; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 28px; }
  .srow, .trow {
    display: grid; gap: 10px; align-items: center; width: 100%; height: 31px; box-sizing: border-box;
    padding: 0 8px; border: 0; border-radius: 8px;
    background: transparent; color: var(--t2, var(--v4-text-2)); font: inherit; font-size: 13px; text-align: left;
  }
  .srow { grid-template-columns: 76px 120px minmax(0, 1fr) 56px 64px 120px; cursor: pointer; }
  .srow.wide { grid-template-columns: 76px 120px minmax(0, 1fr) 120px 56px 64px 120px; }
  .srow.out { grid-template-columns: 76px 120px minmax(0, 1fr) 120px minmax(0, 1.4fr) 80px; }
  .trow { grid-template-columns: minmax(0, 1.4fr) 64px minmax(60px, 1fr) 40px 72px; }
  .srow > *, .trow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hd { color: var(--t3, var(--v4-text-3)); cursor: default; }
  .hd .n { color: inherit; }
  .hd:hover { background: transparent; }
  .mono { font-family: var(--font-mono, "Geist Mono", ui-monospace, monospace); }
  .n { font-variant-numeric: tabular-nums; text-align: right; color: var(--t1, var(--v4-text-1)); }
  .pr span, .m { color: var(--t3, var(--v4-text-3)); margin-left: 6px; }
  .card .err { color: var(--red, var(--v4-error)); }
  .mix .err { background: var(--red, var(--v4-error)); opacity: 1; }
  .oc.dim, .mix .dim { opacity: 0.45; }
  .sk, .bot { display: grid; align-items: center; gap: 10px; height: 31px; padding: 0 8px; }
  .sk { grid-template-columns: minmax(0, 1fr) 44px 90px; }
  .bot { grid-template-columns: minmax(0, 1fr) auto; color: var(--t2, var(--v4-text-2)); }
  .sk > *, .bot > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { height: 3px; background: var(--btn-bg, var(--v4-control-faint)); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; opacity: 0.45; }
  .foot { margin: 8px 0 0; padding: 0 8px; }
  .empty-line { margin: 0; padding: 48px 16px; text-align: center; font-size: 13px; color: var(--t3); }
  .content > .foot { padding: 0 20px; }
  .scroll { max-height: 420px; overflow: auto; }
  .sessions { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 0; padding-right: 0; padding-top: 8px; }
  .detail { border-left: 1px solid var(--line, var(--v4-rowline)); padding: 0 20px 24px; margin-top: -8px; }
  .dh { padding: 12px 0; margin-bottom: 12px; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
  .dh .tt { display: flex; align-items: center; gap: 8px; font-weight: 500; color: var(--t1, var(--v4-text-1)); }
  .dh .mm { color: var(--t3, var(--v4-text-3)); }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 16px; }
  .kv { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 6px 10px; margin: 0 0 16px; }
  .kv .v { display: flex; align-items: center; gap: 6px; min-width: 0; overflow-wrap: anywhere; }
  .split, .mix { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: var(--btn-bg, var(--v4-control-faint)); margin: 4px 0; }
  .split i, .mix i { display: block; height: 100%; }
  .detail .lg { margin-bottom: 16px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 16px; }
  .tl { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; min-height: 28px; align-items: center; }
  .tl.live { color: var(--ok, var(--v4-ok)); }
  .transcript { background: var(--raised, var(--v4-control-faint)); border-radius: 6px; padding: 8px 10px; margin-bottom: 16px; }
  .transcript p { margin: 4px 0; }
  .day { padding: 12px 8px 4px; font-weight: 500; color: var(--t2, var(--v4-text-2)); }
  .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
  .card { text-align: left; border-radius: 8px; padding: 10px 12px; background: var(--raised, transparent); display: flex; flex-direction: column; gap: 2px; }
  .card .n { font-weight: 500; text-align: left; }
  .shimmer {
    background: linear-gradient(90deg, var(--btn-bg, var(--v4-control-faint)), var(--hover, var(--v4-hover)), var(--btn-bg, var(--v4-control-faint)));
    background-size: 200% 100%;
    animation: telem-shimmer 1.1s linear infinite;
    border-radius: 4px;
    min-width: 48px;
    min-height: 1em;
  }
  @keyframes telem-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  .co { display: flex; align-items: center; gap: 6px; }
  .nm { display: flex; align-items: center; gap: 6px; color: var(--t1, var(--v4-text-1)); }
  .nm i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .host { color: var(--t2, var(--v4-text-2)); }
  /* Below ~1180px the Sessions table and the Top skills column no longer fit
     side by side, so the right column stacks under the table. */
  @media (max-width: 1180px) {
    .two { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 900px) {
    .telemetry { flex-direction: column; }
    .pane { width: auto; border-right: 0; border-bottom: 1px solid var(--line, var(--v4-rowline)); }
    .two, .sessions, .cards { grid-template-columns: 1fr; }
  }
</style>
