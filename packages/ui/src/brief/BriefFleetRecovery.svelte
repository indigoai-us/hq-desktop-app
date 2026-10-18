<script lang="ts">
  /**
   * Fleet recovery: during a fleet incident, is the fleet healing or only not
   * getting worse, and which agents are still stuck. Read in one pass:
   *
   *   hero    the still-stuck count, large and light, beside the verdict
   *           ("Healing", its peek holds the rule) and a mono line saying
   *           where it came down from and how long the incident has run;
   *   chart   (two columns wide) a slim white line of the stuck count over
   *           48h on a faint dot grid: a small hollow dot per reading, the
   *           latest a filled dot with its value in a pill, a soft fill only
   *           inside the incident window, dashed pins where fixes landed, and
   *           an axis of weekdays ending in NOW whose labels never collide;
   *   stuck   the agents still stuck (five named, then "+N more"): open rows
   *           of initial circle, name, phase and an age pill that turns warm
   *           past a day (two rows tall), or initial chips (one row tall).
   *           Hovering one opens "Inspect in <engine>" with a read-only prompt.
   *
   * No total agent count anywhere. The card hides itself once the incident has
   * been closed for more than 24 hours.
   */
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { humanTitle } from "./brief-distill.js";
  import { productName } from "./brief-origin.js";
  import { clockLabel } from "./brief-time.js";
  import {
    CHART,
    VERDICT_RULE,
    agentPromptKey,
    fleetGeometry,
    fleetRecoveryVisible,
    heroMeta,
    initialOf,
    inspectPrompt,
    monoWidth,
    peakOf,
    pillSpot,
    pillText,
    placeAxisLabels,
    placePinLabels,
    readingDots,
    stuckFor,
    stuckList,
    stuckOld,
    verdictTitle,
    type FleetPin,
    type StuckAgent,
  } from "./brief-fleet-recovery.js";
  import type { BriefFleetIncident } from "./brief-types.js";

  interface Props {
    incident: BriefFleetIncident;
    prompts: Record<string, string>;
    /** End of the 48h window (ISO). */
    now: string;
    cols: number;
    rows: number;
    /** Test seam; null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
  }
  let { incident, prompts, now, cols, rows, reducedMotion = null }: Props = $props();
  const brief = useBrief();

  const visible = $derived(fleetRecoveryVisible(incident, now));
  const live = $derived(incident.incidentEnd == null);
  const wide = $derived(cols > 1);
  const tall = $derived(rows > 1);
  const nowMs = $derived(Date.parse(now));
  const title = $derived(verdictTitle(incident));
  const verdictWord = $derived(title.split(" · ")[0]!);
  const verdictRest = $derived(title.slice(verdictWord.length));
  const stuckN = $derived(incident.stillStuck.length);
  const meta = $derived(heroMeta(incident, nowMs));
  const metaParts = $derived(meta.split(" · "));
  const geo = $derived(fleetGeometry(incident, now));
  const list = $derived(stuckList(incident.stillStuck));
  const origin = $derived(incident.fixes[0]?.origin ?? null);
  /** Two rows tall with a longer list: the rows take a column of their own beside the chart. */
  const side = $derived(wide && tall && list.shown.length > 2);
  /** One row tall: the stuck set as chips; named while there are two or fewer. */
  const chips = $derived(!tall);
  const named = $derived(list.shown.length <= 2);
  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = $derived(reducedMotion ?? prefersReduced);

  // The plot is measured so dots, pill and labels are placed in real pixels; tests (no layout) use a nominal box.
  let plotW = $state(0);
  let plotH = $state(0);
  const pw = $derived(plotW || 300);
  const ph = $derived(plotH || 90);
  const px = (x: number) => (x / CHART.w) * pw;
  const py = (y: number) => (y / CHART.h) * ph;

  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /** Local midnights inside the window, labelled by weekday (px); "now" sits at the right edge. */
  const axis = $derived.by(() => {
    const ticks: { x: number; label: string }[] = [];
    if (Number.isFinite(geo.from) && geo.to > geo.from) {
      const cur = new Date(geo.from);
      cur.setHours(24, 0, 0, 0);
      while (cur.getTime() < geo.to) {
        ticks.push({ x: ((cur.getTime() - geo.from) / (geo.to - geo.from)) * pw, label: DAY[cur.getDay()]! });
        cur.setDate(cur.getDate() + 1);
      }
    }
    return { ticks, labels: placeAxisLabels(ticks, pw) };
  });

  const dots = $derived(readingDots(geo, incident.series, pw));
  const current = $derived(dots.find((d) => d.current) ?? null);
  const pill = $derived.by(() => {
    if (!current) return null;
    const text = pillText(current, nowMs);
    const box = { w: monoWidth(text) + 16, h: 18 };
    const spot = pillSpot(
      geo.points.map((p) => ({ x: px(p.x), y: py(p.y) })),
      { x: px(current.x), y: py(current.y) },
      box,
      { w: pw, h: ph },
    );
    return { text, ...box, ...spot };
  });

  const pinText = (p: FleetPin) => `Fix ${clockLabel(new Date(p.at).toISOString())}`;
  const pinSpots = $derived(
    placePinLabels(
      geo.pins.map((p) => ({ x: px(p.x), label: pinText(p) })),
      pw,
      pill?.side === "strip" ? [{ left: pill.left, w: pill.w }] : [],
    ),
  );
  /** Lines in the strip above the plot: fix labels, and the pill when the line leaves it no room below. */
  const stripRows = $derived(Math.max(1, ...pinSpots.map((s) => (s.row ?? 0) + 1)));
  const leader = $derived.by(() => {
    if (!pill?.leader || !current) return null;
    const y0 = pill.side === "strip" ? -4 : pill.top + pill.h + 3;
    const y1 = py(current.y) - 8;
    return y1 > y0 + 4 ? { x: px(current.x), y0, y1 } : null;
  });

  // The curve draws in once. Its stroke does not scale with the plot, so the dash is measured in
  // screen pixels (an upper bound: the sum of each segment's run and rise), not in viewBox units.
  const lineLen = $derived(
    Math.ceil(geo.points.reduce((sum, p, i) => (i ? sum + Math.abs(px(p.x) - px(geo.points[i - 1]!.x)) + Math.abs(py(p.y) - py(geo.points[i - 1]!.y)) : 0), 0)) + 2,
  );

  const verdictPeek = (): PeekContent => {
    const sections: PeekContent["sections"] = [{ label: "Verdict rule", text: VERDICT_RULE }];
    const peak = peakOf(incident.series);
    if (peak) sections.push({ label: "Peak", text: `${peak.stuck} stuck at ${clockLabel(peak.at)}` });
    if (incident.fixes.length) {
      sections.push({
        label: "Fixes",
        lines: incident.fixes.map((f) => ({ label: humanTitle(f.label).text, state: clockLabel(f.at), tone: "ok" as const })),
      });
    }
    const prompt = prompts[incident.id];
    return { title: verdictWord, status: title, sections, prompt: prompt ? { id: incident.id, text: prompt } : undefined };
  };

  const agentPeek = (a: StuckAgent): PeekContent => {
    const key = agentPromptKey(incident.id, a.name);
    const since = stuckFor(a.since, nowMs);
    return {
      compact: true,
      eyebrow: `Agent · ${live ? "stuck now" : "stuck"}`,
      title: a.name,
      status: `${a.reason}${since ? ` · stuck ${since}` : ""}`,
      sections: [],
      prompt: { id: key, verb: "Inspect", text: prompts[key] ?? inspectPrompt(a, incident) },
    };
  };

  const morePeek = (): PeekContent => ({
    title: `${list.rest.length} more still stuck`,
    status: "Hover a dot to inspect one",
    sections: [{ label: "Agents", lines: list.rest.map((a) => ({ label: a.name, state: a.reason, tone: "red" as const })) }],
  });

  const pinPeek = (p: FleetPin): PeekContent => {
    const fix = incident.fixes[p.index]!;
    return {
      compact: true,
      eyebrow: "Fix landed",
      origin: { companyUid: fix.origin.companyUid, label: productName(fix.origin.repo, fix.origin.product) },
      title: p.label,
      status: clockLabel(fix.at),
      sections: [],
    };
  };
</script>

{#if visible}
  <div
    class="w fr"
    class:wide
    class:tall
    class:side
    class:chips
    data-testid="brief-fleet-recovery"
    data-verdict={incident.verdict}
    data-live={live}
  >
    <!-- The card's own line; on a colour field the corner label names the card instead. -->
    <div class="eyebrow" data-testid="brief-fleet-eyebrow">{wide ? "Fleet recovery · 48h" : "Fleet recovery"}</div>
    {#if wide || origin}
      <div class="corner">
        {#if origin}<BriefOrigin {origin} />{/if}
        {#if wide}<span class="rng">48h</span>{/if}
      </div>
    {/if}

    <div class="main">
      <div class="lead">
        <div class="head">
          <div class="hero" data-testid="brief-fleet-count" aria-hidden="true">{stuckN}</div>
          <div class="cap">
            <h3 data-testid="brief-fleet-verdict" role="group" aria-label={title} use:peek={{ state: brief, content: verdictPeek }}>{verdictWord}<span class="sr">{verdictRest}</span></h3>
            <div class="unit">{stuckN === 1 ? "agent still stuck" : "agents still stuck"}</div>
            {#if meta}
              <div class="meta" data-testid="brief-fleet-meta">
                {#each metaParts as part, i (i)}{#if i}{" "}{/if}<span>{part}{i < metaParts.length - 1 ? " ·" : ""}</span>{/each}
              </div>
            {/if}
          </div>
        </div>

        {#if wide}
          <div class="chart" data-testid="brief-fleet-chart">
            <!-- The strip above the plot: where each fix landed, and the value pill when the line leaves it no room below. -->
            {#if geo.pins.length || pill?.side === "strip"}<div class="strip" style="height:{stripRows * 18}px">
              {#each geo.pins as p, i (p.index)}
                {@const s = pinSpots[i]!}
                <span
                  class="pinlbl"
                  class:bare={s.row == null}
                  role="group"
                  aria-label={`${p.label}, ${clockLabel(new Date(p.at).toISOString())}`}
                  style="left:{s.row == null ? px(p.x) - 5 : s.left}px;top:{s.row == null ? stripRows * 18 - 1 : s.row * 18}px"
                  data-testid="brief-fleet-pin"
                  use:peek={{ state: brief, content: () => pinPeek(p) }}>{s.row == null ? "" : pinText(p)}</span
                >
              {/each}
              {#if pill?.side === "strip"}
                <span class="pill" style="left:{pill.left}px;top:0;width:{pill.w}px" data-testid="brief-fleet-pill" data-side={pill.side}>{pill.text}</span>
              {/if}
            </div>{/if}
            <div class="plot" bind:clientWidth={plotW} bind:clientHeight={plotH}>
              <svg viewBox="0 0 {CHART.w} {CHART.h}" preserveAspectRatio="none" role="img" aria-label="Stuck agents over the last 48 hours">
                <defs>
                  <linearGradient id="fr-fill-{incident.id}" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stop-color="#fff" stop-opacity="0.26" />
                    <stop offset="1" stop-color="#fff" stop-opacity="0.02" />
                  </linearGradient>
                </defs>
                {#if geo.area}<path class="area" d={geo.area} fill="url(#fr-fill-{incident.id})" data-testid="brief-fleet-area" />{/if}
                <line class="base" x1={CHART.left} x2={CHART.w - CHART.right} y1={geo.baseY} y2={geo.baseY} />
                {#each axis.ticks as t (t.x)}
                  <line class="day" x1={(t.x / pw) * CHART.w} x2={(t.x / pw) * CHART.w} y1={0} y2={geo.baseY} />
                {/each}
                {#each geo.pins as p (p.index)}
                  <line class="pin" x1={p.x} x2={p.x} y1={0} y2={geo.baseY} />
                {/each}
                <path class="line" class:draw={!reduced} d={geo.line} style="--len:{lineLen}" data-testid="brief-fleet-line" />
              </svg>
              {#each dots as d (d.at)}
                <i
                  class="pt"
                  class:cur={d.current}
                  class:live={d.current && live}
                  style="left:{px(d.x)}px;top:{py(d.y)}px"
                  data-testid={d.current ? "brief-fleet-now" : "brief-fleet-reading"}
                ></i>
              {/each}
              {#if leader}<i class="leader" style="left:{leader.x}px;top:{leader.y0}px;height:{leader.y1 - leader.y0}px"></i>{/if}
              {#if pill && pill.side !== "strip"}
                <span class="pill" style="left:{pill.left}px;top:{pill.top}px;width:{pill.w}px" data-testid="brief-fleet-pill" data-side={pill.side}>{pill.text}</span>
              {/if}
            </div>
            <div class="axis" data-testid="brief-fleet-axis">
              {#each axis.labels as l, i (l.label + i)}
                <span class:nowl={i === axis.labels.length - 1} style="left:{l.left}px;width:{l.w}px" data-testid="brief-fleet-tick">{l.label}</span>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <div class="stuck" class:chips data-testid="brief-fleet-stuck">
        {#if !incident.stillStuck.length}
          <div class="none">No agent still stuck.</div>
        {:else}
          {#each list.shown as a (a.name)}
            {@const since = stuckFor(a.since, nowMs)}
            <button
              type="button"
              class="ag"
              class:named
              data-testid="brief-fleet-agent"
              aria-label={`${a.name}, ${a.reason}`}
              use:peek={{ state: brief, content: () => agentPeek(a) }}
            >
              <i class="dot" class:breathe={live} aria-hidden="true">{initialOf(a.name)}</i>
              {#if !chips || named}<span class="nm">{a.name}</span>{/if}
              {#if !chips}
                <span class="rs">{a.reason}</span>
                {#if since}<span class="age" class:old={stuckOld(a.since, nowMs)}>{since}</span>{/if}
              {/if}
            </button>
          {/each}
          {#if list.rest.length}
            <div class="more" role="button" tabindex="0" aria-label={`${list.rest.length} more still stuck`} data-testid="brief-fleet-more" use:peek={{ state: brief, content: morePeek }}>+{list.rest.length}{#if chips}<span class="sr">{" more"}</span>{:else}{" more"}{/if}</div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .fr {
    /* Mono caps: the one label style for the axis, pins, pills and meta. */
    --mono: 400 10px/1 var(--b-code);
  }
  .rng,
  .meta,
  .pinlbl,
  .pill,
  .axis span,
  .rs,
  .age,
  .more {
    font: var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Top right, in the label row: the window and the company of the fixes. */
  .corner {
    position: absolute;
    top: 18px;
    right: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rng {
    color: var(--b-t3);
  }
  .main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .side .main {
    flex-direction: row;
    gap: 18px;
  }
  /* One row tall and wide: the head over the chips on the left, the chart on the right. */
  .wide:not(.tall) .main {
    display: grid;
    grid-template-columns: minmax(0, 46%) minmax(0, 1fr);
    grid-template-rows: auto 1fr;
    grid-template-areas: "head chart" "stuck chart";
    gap: 12px 20px;
  }
  .lead {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .wide:not(.tall) .lead {
    display: contents;
  }
  .wide:not(.tall) .head {
    grid-area: head;
  }

  /* Hero: the still-stuck count, large and light, with the verdict and its small lines beside it. */
  .head {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
  }
  .hero {
    flex: none;
    font-size: 48px;
    font-weight: 300;
    line-height: 0.9;
    letter-spacing: -0.045em;
    font-variant-numeric: tabular-nums;
    color: var(--b-t1);
  }
  .chips .hero {
    font-size: 40px;
  }
  .cap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .fr h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.01em;
    color: var(--b-t1);
    cursor: default;
    position: relative;
  }
  .unit {
    font-size: 12px;
    line-height: 1.25;
    color: var(--b-t2);
  }
  .meta {
    margin-top: 2px;
    line-height: 1.3;
    white-space: normal;
    color: var(--b-t3);
  }
  /* Each part stays whole; a narrow card wraps between parts, never inside one. */
  .meta span {
    white-space: nowrap;
  }

  /* Chart: label strip for the fixes, the plot on a dot grid, then the axis. */
  .chart {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .wide:not(.tall) .chart {
    grid-area: chart;
  }
  .strip {
    position: relative;
    flex: none;
    margin-bottom: 4px;
  }
  .pinlbl {
    position: absolute;
    line-height: 18px;
    color: var(--b-t2);
    cursor: default;
    transition: color 0.2s;
  }
  .pinlbl:hover {
    color: #fff;
  }
  /* A pin with no room for its words: a small hollow mark on the top of its line, still hoverable. */
  .pinlbl.bare {
    width: 10px;
    height: 10px;
  }
  .pinlbl.bare::after {
    content: "";
    position: absolute;
    left: 2px;
    top: 2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    box-sizing: border-box;
    border: 1px solid rgb(var(--b-ink) / 0.8);
  }
  .plot {
    position: relative;
    flex: 1;
    min-height: 64px;
    /* A faint dot grid behind the line, as in the references. */
    background: radial-gradient(circle, rgb(var(--b-ink) / 0.22) 0.75px, transparent 1.1px) 0 0 / 10px 10px;
  }
  .tall:not(.side) .plot {
    min-height: 84px;
  }
  .side .plot {
    min-height: 76px;
  }
  .plot svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .base {
    stroke: rgb(var(--b-ink) / 0.35);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  /* Midnights: the faintest hairline, so a weekday on the axis has its place. */
  .day {
    stroke: rgb(var(--b-ink) / 0.16);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .pin {
    stroke: rgb(var(--b-ink) / 0.55);
    stroke-width: 1;
    stroke-dasharray: 2 3;
    vector-effect: non-scaling-stroke;
  }
  .line {
    fill: none;
    stroke: #fff;
    stroke-width: 1.5;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  /* Draws in once; reduced motion shows the whole curve at once. */
  .line.draw {
    stroke-dasharray: var(--len, 0);
    stroke-dashoffset: var(--len, 0);
    animation: draw 1.1s 0.3s ease-out forwards;
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  /* A small dot per reading; the latest is larger, with its value in a pill. */
  .pt {
    position: absolute;
    width: 5px;
    height: 5px;
    margin: -2.5px 0 0 -2.5px;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.9);
    pointer-events: none;
  }
  .pt.cur {
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border: 0;
    background: #fff;
  }
  /* While the incident is live, a thin ring breathes around the latest reading. */
  .pt.live::after {
    content: "";
    position: absolute;
    inset: -5px;
    border-radius: 50%;
    border: 1px solid rgb(255 255 255 / 0.7);
    animation: ring 2.4s ease-in-out infinite;
  }
  @keyframes ring {
    50% {
      opacity: 0.15;
    }
  }
  /* A pill away from its dot hangs a dotted leader down to it. */
  .leader {
    position: absolute;
    width: 1px;
    margin-left: -0.5px;
    background: linear-gradient(rgb(255 255 255 / 0.7) 50%, transparent 0) 0 0 / 1px 4px repeat-y;
    pointer-events: none;
  }
  .pill {
    position: absolute;
    height: 18px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    color: #fff;
    background: rgb(255 255 255 / 0.22);
    text-shadow: none;
  }
  .axis {
    position: relative;
    flex: none;
    height: 10px;
    margin-top: 7px;
  }
  .axis span {
    position: absolute;
    top: 0;
    text-align: center;
    color: var(--b-t3);
  }
  .axis .nowl {
    text-align: right;
    color: #fff;
  }

  /* Still stuck: open rows (two rows tall) or chips (one row tall). */
  .stuck {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .side .stuck {
    flex: 0 0 44%;
    justify-content: center;
  }
  .stuck.chips {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }
  .wide:not(.tall) .stuck {
    grid-area: stuck;
    align-self: end;
  }
  .ag {
    all: unset;
    box-sizing: border-box;
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 34px;
    padding: 0 8px;
    margin: 0 -8px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.25;
    color: var(--b-t1);
    cursor: default;
    transition: background 0.2s;
  }
  .side .ag {
    height: 30px;
    gap: 8px;
  }
  .ag:hover,
  .ag:focus-visible {
    background: rgb(255 255 255 / 0.14);
    outline: none;
  }
  /* The initial circle: soft glass with the agent's first letter. */
  .dot {
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-style: normal;
    font-size: 11px;
    font-weight: 600;
    line-height: 1;
    color: #fff;
    background: rgb(255 255 255 / 0.22);
    transition: background 0.2s;
  }
  .ag:hover .dot {
    background: rgb(255 255 255 / 0.32);
  }
  /* Still-stuck circles breathe, slowly, only while the incident is live. */
  .dot.breathe {
    animation: br 2.8s ease-in-out infinite;
  }
  @keyframes br {
    50% {
      background-color: rgb(255 255 255 / 0.1);
    }
  }
  .nm {
    flex: 0 1 auto;
    min-width: 0;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rs {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--b-t3);
  }
  .age {
    flex: none;
    height: 18px;
    padding: 0 7px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    color: #fff;
    background: rgb(255 255 255 / 0.14);
    text-shadow: none;
  }
  .age.old {
    color: #ffe08a;
    background: rgba(255, 205, 110, 0.32);
  }
  /* Chips: a glass capsule per agent, the name inside while there are two or fewer. */
  .chips .ag {
    height: 26px;
    margin: 0;
    padding: 0 2px;
    gap: 6px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.14);
  }
  /* Unnamed, a chip is just its circle. */
  .chips .ag:not(.named) {
    padding: 0;
    background: none;
  }
  .chips .ag:not(.named) .dot {
    width: 24px;
    height: 24px;
  }
  .chips .ag:not(.named):hover .dot,
  .chips .ag:not(.named):focus-visible .dot {
    background: rgb(255 255 255 / 0.36);
  }
  .chips .ag.named {
    padding-right: 10px;
    font-size: 12px;
  }
  .chips .ag:hover,
  .chips .ag:focus-visible {
    background: rgb(255 255 255 / 0.22);
  }
  .chips .dot {
    width: 22px;
    height: 22px;
  }
  .more {
    align-self: flex-start;
    height: 24px;
    padding: 0 10px;
    margin-top: 4px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    border-radius: 6px;
    color: #fff;
    background: rgb(255 255 255 / 0.14);
    text-shadow: none;
    cursor: default;
    transition: background 0.2s, color 0.2s;
  }
  .chips .more {
    align-self: center;
    margin: 0 0 0 2px;
    height: 24px;
    padding: 0 8px;
  }
  .more:hover,
  .more:focus-visible {
    background: #fff;
    color: #2a1a22;
    outline: none;
  }
  .none {
    font: var(--mono);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    padding: 4px 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .dot.breathe,
    .pt.live::after {
      animation: none;
    }
  }
</style>
