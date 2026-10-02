<script lang="ts">
  /**
   * My Telemetry (US-032). Paints the cached snapshot on the first frame,
   * then refreshes in the background. Charts are CSS bars in text-1 opacities.
   */
  import { onMount, untrack } from "svelte";
  import "../chat/scroll-perf.css";
  import type { TelemetryCache } from "./telemetry-cache.js";
  import {
    LIST_RATE_LABEL,
    barPercents,
    formatTokens,
    formatUsd,
    listRateUsd,
    outcomesForFilter,
    sessionsForFilter,
    sharePercent,
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
  import { TELEMETRY_SCOPES } from "./telemetry-smoke.js";
  import ShowMoreRow from "../shell/ShowMoreRow.svelte";
  import { pageRows } from "../shell/list-paging.js";

  interface Props {
    cache: TelemetryCache;
    scope?: string;
    onskills?: () => void;
    onopen?: (session: TelemetrySession, label: string) => void;
  }

  let { cache, scope = "all", onskills, onopen }: Props = $props();

  let snapshot = $state<TelemetrySnapshot | null>(untrack(() => cache.cached()));
  let refreshing = $state(false);
  let page = $state<TelemetryPage>("overview");
  let range = $state<TelemetryRange>("30d");
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
  const skillMax = $derived(snapshot?.skills[0]?.count ?? 1);
  const tokenTotal = $derived(
    snapshot?.models.reduce(
      (sum, row) => sum + row.input + row.output + row.cacheWrite + row.cacheRead,
      0,
    ) ?? 0,
  );

  const pages: { id: TelemetryPage; label: string; meta?: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "sessions", label: "Sessions", meta: "…" },
    { id: "tokens", label: "Tokens" },
    { id: "outcomes", label: "Outcomes" },
  ];

  function refresh(): void {
    refreshing = true;
    cache
      .refresh()
      .then((next) => {
        snapshot = next;
        range = next.range;
      })
      .catch((err) => {
        console.warn("[telemetry] refresh failed", err);
      })
      .finally(() => {
        refreshing = false;
      });
  }

  onMount(() => {
    if (!snapshot) snapshot = cache.fallback;
    refresh();
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
    <div class="pane-head">My Telemetry</div>
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
      <button class="row" onclick={() => onskills?.()}>
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
            onclick={() => (range = id as TelemetryRange)}
          >{id}</button>
        {/each}
      </div>
      <div class="sec">Scope</div>
      {#each TELEMETRY_SCOPES as item (item.id)}
        <button
          class="row"
          aria-current={activeScope === item.id ? "true" : undefined}
          onclick={() => (activeScope = item.id)}
        >
          {#if item.mark}<span class="mini">{item.mark}</span>{/if}
          <span>{item.label}</span>
          {#if item.id === "all" && activeScope === "all"}<span class="chip">on</span>
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
      <span class="sub">
        {snapshot?.rangeLabel ?? "—"}
        {#if page === "tokens"} · all models{/if}
        · {snapshot?.subtitle ?? ""}
        {#if page === "sessions" && snapshot} · {snapshot.sessions} sessions{/if}
        {#if page === "outcomes" && snapshot} · what {snapshot.sessions} sessions produced{/if}
      </span>
      <span class="grow"></span>
      <span class="chip">Only you can see this</span>
      <button class="btn" onclick={exportCsv}>Export CSV</button>
    </div>

    {#if !snapshot}
      <div class="canvas" data-testid="telemetry-skeleton" aria-busy="true">
        <div class="statline">
          {#each [0, 1, 2, 3, 4, 5] as i (i)}
            <div class="stat"><div class="n shimmer">&nbsp;</div><div class="l shimmer">&nbsp;</div></div>
          {/each}
        </div>
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
            <span class="lg"><i class="o"></i>Opus<i class="s"></i>Sonnet<i class="h"></i>Haiku</span>
          </div>
          <div class="chart" aria-hidden="true">
            <span class="pk">{snapshot.peakLabel}</span>
            {#each snapshot.days as day, i (i)}
              {@const bars = barPercents(day, maxStack)}
              <div class="d" class:today={day.today}>
                <i class="o" style:height="{bars.opus}%"></i>
                <i class="s" style:height="{bars.sonnet}%"></i>
                <i class="h" style:height="{bars.haiku}%"></i>
              </div>
            {/each}
          </div>
          <div class="spark-lb"><span>Sep 2</span><span>Sep 16</span><span>today</span></div>
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
                  <span class="mono">{row.when}</span>
                  <span class="co"><span class="mini">{row.mark}</span>{row.company}</span>
                  <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                  <span class="n">{row.length}</span>
                  <span class="n">{row.tokensLabel}</span>
                  <span class="oc {row.outcomeKind}">{row.outcome}</span>
                </button>
              {/each}
            </div>
            <p class="foot">Sessions on your laptop, your Outpost, and bots running under your identity. Company admins see totals only, never transcripts.</p>
          </div>
          <div>
            <div class="sech">Top skills <span class="grow"></span>
              <button class="lnk" onclick={() => onskills?.()}>{snapshot.distinctSkills} total</button>
            </div>
            {#each snapshot.skills as skill (skill.name)}
              <div class="sk">
                <span class="nm">{skill.name}</span>
                <span class="n">{skill.count}</span>
                <span class="bar"><i style:width="{Math.round((skill.count / skillMax) * 100)}%"></i></span>
              </div>
            {/each}
            <div class="sech gap">Bots acting on your behalf <span class="grow"></span>
              <span class="chip live">{snapshot.bots.filter((b) => b.live).length} live</span>
            </div>
            {#each snapshot.bots as bot (bot.name)}
              <div class="bot">
                <span class="mini sq">⌁</span>
                <div><b>{bot.name}</b><span class="m">{bot.meta}</span></div>
                <span class="r" class:live={bot.live}>{bot.status}</span>
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
            <span class="chip live">1 in progress</span>
          </div>
          <div class="srow hd wide" data-testid="telemetry-sessions-head"><span>When</span><span>Company</span><span>Project</span><span>Host</span><span class="n">Length</span><span class="n">Tokens</span><span>Outcome</span></div>
          <div class="scroll">
            {#each sessionDays as group (group.day)}
              <div class="day">{group.day}</div>
              {#each group.rows as row (row.id)}
                <button class="srow wide hq-contain-row" aria-current={selected?.id === row.id ? "true" : undefined} onclick={() => (selectedId = row.id)}>
                  <span class="mono">{row.when}</span>
                  <span class="co"><span class="mini">{row.mark}</span>{row.company}</span>
                  <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                  <span class="host">{row.host}</span>
                  <span class="n">{row.length}</span>
                  <span class="n">{row.tokensLabel}</span>
                  <span class="oc {row.outcomeKind}">{row.outcome}</span>
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
              <div class="tt">{selected.project} {#if selected.outcomeKind === "live"}<span class="chip live">live</span>{/if}</div>
              <div class="mm">{selected.detail || selected.outcome} · {selected.length}</div>
            </div>
            <div class="acts">
              <button class="btn primary" onclick={() => (transcriptFor = selected.id)}>Open transcript</button>
              <button class="btn" onclick={() => onopen?.(selected, "claude")}>Open in Claude Code</button>
              <button class="btn" onclick={() => onopen?.(selected, "atlas")}>Atlas</button>
            </div>
            {#if transcriptFor === selected.id}
              <div class="transcript" data-testid="telemetry-transcript">
                <p>In-app transcript for {selected.id}. Company admins do not see this.</p>
                {#each selected.timeline as line (line.at + line.text)}
                  <p><span class="mono">{line.at}</span> {line.text}</p>
                {/each}
              </div>
            {/if}
            <div class="kv">
              <span class="k">Company</span><span class="v"><span class="mini">{selected.mark}</span>{selected.company}</span>
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
            <div class="chips">{#each selected.skills as skill (skill)}<span class="chip">{skill}</span>{/each}</div>
            <div class="sech">Timeline</div>
            {#each selected.timeline as line (line.at + line.text)}
              <div class="tl" class:live={line.live}><span class="mono">{line.at}</span><span>{line.text}</span></div>
            {/each}
            <p class="foot">Transcripts stay on this device and in your personal vault. Company admins see totals only.</p>
          </aside>
        {/if}
      </div>
    {:else if page === "tokens"}
      <div class="canvas">
        <div class="statline">
          <div class="stat"><div class="n">{snapshot.tokensLabel}<small>{snapshot.tokensDelta}</small></div><div class="l">tokens, 30 days</div></div>
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
            <span class="lg"><i class="o"></i>Opus<i class="s"></i>Sonnet<i class="h"></i>Haiku</span>
          </div>
          <div class="chart" data-testid="telemetry-bars">
            <span class="pk">{snapshot.peakLabel}</span>
            {#each snapshot.days as day, i (i)}
              {@const bars = barPercents(day, maxStack)}
              <div class="d" class:today={day.today}>
                <i class="o" style:height="{bars.opus}%"></i>
                <i class="s" style:height="{bars.sonnet}%"></i>
                <i class="h" style:height="{bars.haiku}%"></i>
              </div>
            {/each}
          </div>
          <div class="spark-lb">{#each snapshot.dayLabels as label (label)}<span>{label}</span>{/each}</div>
        </div>
        <div class="two">
          <div>
            <div class="sech">By model</div>
            <div class="trow hd"><span>Model</span><span class="n">Tokens</span><span>Share</span><span class="n">%</span><span class="n">Cost</span></div>
            {#each snapshot.models as model (model.model)}
              {@const tokens = model.input + model.output + model.cacheWrite + model.cacheRead}
              <div class="trow">
                <span class="nm"><i class={model.model}></i>{model.label}<span class="m">{model.hint}</span></span>
                <span class="n">{formatTokens(tokens)}</span>
                <span class="bar"><i style:width="{sharePercent(tokens, tokenTotal)}%"></i></span>
                <span class="n">{sharePercent(tokens, tokenTotal)}%</span>
                <span class="n">{formatUsd(listRateUsd(model))}</span>
              </div>
            {/each}
            <div class="trow tot"><span>Total</span><span class="n">{formatTokens(tokenTotal)}</span><span></span><span class="n">100%</span><span class="n">{formatUsd(snapshot.listCostUsd)}</span></div>
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
                <span class="nm"><span class="mini">{row.mark}</span>{row.label}<span class="m">{row.meta}</span></span>
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
                <span class="mono">{row.when}</span>
                <span class="co"><span class="mini">{row.mark}</span>{row.company}</span>
                <span class="pr">{row.project}{#if row.detail}<span>{row.detail}</span>{/if}</span>
                <span class="oc {row.outcomeKind}">{row.outcome}</span>
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
  .telemetry {
    display: flex;
    height: 100%;
    min-height: 0;
    color: var(--v4-text-1);
    font-family: var(--font-sans, Geist, sans-serif);
    background: var(--v4-ground, transparent);
  }
  .pane { width: 260px; flex: none; display: flex; flex-direction: column; border-right: 1px solid var(--v4-rowline); }
  .pane-head { padding: 14px 12px 8px; font-weight: 600; }
  .pane-list { overflow: auto; padding: 0 8px 12px; }
  .row, .tab, .btn, .lnk { font: inherit; color: inherit; background: transparent; border: 0; }
  .row {
    display: flex; align-items: center; gap: 8px; width: 100%;
    text-align: left; padding: 6px 8px; border-radius: 6px; color: var(--v4-text-2);
  }
  .row[aria-current="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .row:hover { background: var(--v4-hover); }
  .meta, .sub, .l, .m, .foot, .pk, .spark-lb, .k { color: var(--v4-text-3); }
  .meta { margin-left: auto; font-size: var(--type-metadata); }
  .sec { margin: 12px 8px 4px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .tabs { display: flex; gap: 0; }
  .tab { padding: 3px 8px; color: var(--v4-text-2); font-size: var(--type-metadata); }
  .tab[aria-selected="true"] { background: var(--v4-active-row); color: var(--v4-text-1); border-radius: 6px; }
  .mini {
    width: 16px; height: 16px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    font-size: 8px; background: var(--v4-control-faint); color: var(--v4-text-2); flex: none;
  }
  .mini.sq { border-radius: 4px; }
  .chip { font-size: var(--type-metadata); color: var(--v4-text-2); border: 1px solid var(--v4-rowline); border-radius: 980px; padding: 1px 8px; }
  .chip.live, .oc.live, .r.live, .tl.live { color: var(--v4-ok); }
  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; gap: 8px; padding: 12px 16px; }
  .toolbar h1 { font-size: var(--type-section); font-weight: 600; margin: 0; }
  .sub { font-size: var(--type-metadata); }
  .grow { flex: 1; }
  .btn { border: 1px solid var(--v4-rowline); border-radius: 6px; padding: 4px 10px; color: var(--v4-text-1); }
  .btn.primary { background: var(--v4-active-row); }
  .canvas { padding: 0 16px 16px; overflow: auto; display: flex; flex-direction: column; gap: 20px; }
  .statline { display: flex; gap: 24px; flex-wrap: wrap; align-items: flex-end; }
  .stat .n { font-size: var(--type-detail); font-weight: 600; letter-spacing: -0.01em; }
  .stat .n small { font-size: var(--type-metadata); font-weight: 400; color: var(--v4-text-3); margin-left: 4px; }
  .stat .l { font-size: var(--type-metadata); }
  .sech {
    display: flex; align-items: center; gap: 8px; margin: 0 0 8px;
    font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em;
    text-transform: uppercase; color: var(--v4-text-3);
  }
  .sech.gap { margin-top: 20px; }
  .lnk { font-family: var(--font-sans, Geist, sans-serif); letter-spacing: 0; text-transform: none; font-size: var(--type-metadata); color: var(--v4-text-2); }
  .lg { display: flex; gap: 10px; font-family: var(--font-sans, Geist, sans-serif); letter-spacing: 0; text-transform: none; font-size: var(--type-metadata); color: var(--v4-text-2); }
  .lg i, .nm i, .chart i, .split i, .mix i, .bar i {
    background: var(--v4-text-1);
  }
  .lg i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .o, .lg .o, .nm .opus { opacity: 0.9; }
  .s, .lg .s, .nm .sonnet { opacity: 0.45; }
  .h, .lg .h, .nm .haiku { opacity: 0.18; }
  .chart {
    position: relative; height: 96px; display: flex; align-items: flex-end; gap: 3px;
    border-bottom: 1px solid var(--v4-rowline); color: var(--v4-text-1);
  }
  .chart .d { flex: 1; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; min-width: 0; }
  .chart .d i { display: block; width: 100%; }
  .pk { position: absolute; right: 0; top: 0; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; }
  .spark-lb { display: flex; justify-content: space-between; font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; margin-top: 4px; }
  .two { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 24px; }
  .srow, .trow {
    display: grid; gap: 10px; align-items: center; width: 100%;
    padding: 7px 8px; border: 0; border-bottom: 1px solid var(--v4-rowline);
    background: transparent; color: var(--v4-text-2); font: inherit; text-align: left;
    font-size: var(--type-secondary);
  }
  .srow { grid-template-columns: 76px 112px minmax(0, 1fr) 54px 64px 110px; }
  .srow.wide { grid-template-columns: 76px 112px minmax(0, 1fr) 120px 54px 64px 110px; }
  .srow.out { grid-template-columns: 76px 112px minmax(0, 1fr) 110px minmax(0, 1.4fr) 80px; }
  .trow { grid-template-columns: minmax(0, 1.4fr) 64px minmax(60px, 1fr) 40px 72px; }
  .srow > *, .trow > * { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .srow[aria-current="true"] { background: var(--v4-active-row); color: var(--v4-text-1); }
  .srow:hover { background: var(--v4-hover); }
  .hd { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); }
  .hd:hover { background: transparent; }
  .mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; color: var(--v4-text-3); }
  .n { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; text-align: right; color: var(--v4-text-1); }
  .pr span, .m { color: var(--v4-text-3); font-size: var(--type-metadata); margin-left: 6px; }
  .oc.err, .card .err, .mix .err { color: var(--v4-error); }
  .mix .err { background: var(--v4-error); opacity: 1; }
  .oc.dim, .mix .dim { opacity: 0.45; }
  .sk, .bot { display: grid; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--v4-rowline); }
  .sk { grid-template-columns: minmax(0, 1fr) 44px 90px; }
  .bot { grid-template-columns: auto minmax(0, 1fr) 72px; font-size: var(--type-metadata); color: var(--v4-text-2); }
  .bot b { font-weight: 500; color: var(--v4-text-1); font-size: var(--type-secondary); }
  .bot .m { display: block; margin: 2px 0 0; }
  .bar { height: 3px; background: var(--v4-control-faint); border-radius: 2px; overflow: hidden; }
  .bar i { display: block; height: 100%; opacity: 0.45; }
  .foot { font-size: var(--type-metadata); margin: 8px 0 0; }
  .scroll { max-height: 420px; overflow: auto; }
  .sessions { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; }
  .detail { border-left: 1px solid var(--v4-rowline); padding-left: 12px; }
  .dh .tt { font-weight: 600; }
  .acts { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .kv { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 4px 8px; font-size: var(--type-metadata); margin: 8px 0; }
  .split, .mix { display: flex; height: 8px; border-radius: 2px; overflow: hidden; background: var(--v4-control-faint); }
  .split i, .mix i { display: block; height: 100%; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .tl { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 8px; font-size: var(--type-metadata); padding: 3px 0; }
  .transcript { font-size: var(--type-metadata); background: var(--v4-active-row); border-radius: 6px; padding: 8px; margin-bottom: 8px; }
  .day { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--v4-text-3); padding: 8px; }
  .cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; }
  .card { text-align: left; background: transparent; border: 1px solid var(--v4-rowline); border-radius: 8px; padding: 10px; color: inherit; font: inherit; }
  .card[aria-pressed="true"] { background: var(--v4-active-row); }
  .card .n { font-size: var(--type-detail); font-weight: 600; text-align: left; }
  .shimmer {
    background: linear-gradient(90deg, var(--v4-control-faint), var(--v4-hover), var(--v4-control-faint));
    background-size: 200% 100%;
    animation: telem-shimmer 1.1s linear infinite;
    border-radius: 4px;
    min-width: 48px;
    min-height: 1em;
  }
  @keyframes telem-shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
  .co { display: flex; align-items: center; gap: 6px; }
  .nm { display: flex; align-items: center; gap: 6px; }
  .nm i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .host { color: var(--v4-text-2); }
  @media (max-width: 900px) {
    .telemetry { flex-direction: column; }
    .pane { width: auto; border-right: 0; border-bottom: 1px solid var(--v4-rowline); }
    .two, .sessions, .cards { grid-template-columns: 1fr; }
  }
</style>
