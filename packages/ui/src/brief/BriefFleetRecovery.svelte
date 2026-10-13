<script lang="ts">
  /**
   * Fleet recovery: during a fleet incident, is the fleet healing or only not
   * getting worse, and which agents are still stuck. Verdict-first title whose
   * peek holds the rule; a 48h curve of the stuck count that fills red only
   * inside the incident window, with dashed pins where fixes landed; then dots
   * for the stuck set only (five named, then "+N more"), breathing while the
   * incident is live. Hovering a dot opens an "Inspect in <engine>" card with a
   * read-only diagnosis prompt. No total agent count anywhere. The card hides
   * itself once the incident has been closed for more than 24 hours.
   */
  import { onMount } from "svelte";
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
    inspectPrompt,
    peakOf,
    stuckFor,
    stuckList,
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
  const geo = $derived(fleetGeometry(incident, now));
  const list = $derived(stuckList(incident.stillStuck));
  const origin = $derived(incident.fixes[0]?.origin ?? null);
  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = $derived(reducedMotion ?? prefersReduced);

  const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  /** Local midnights inside the window, labelled by weekday; "now" sits at the right edge. */
  const dayTicks = $derived.by(() => {
    const out: { x: number; label: string }[] = [];
    if (!Number.isFinite(geo.from) || geo.to <= geo.from) return out;
    const cur = new Date(geo.from);
    cur.setHours(24, 0, 0, 0);
    while (cur.getTime() < geo.to) {
      const x = ((cur.getTime() - geo.from) / (geo.to - geo.from)) * 100;
      if (x > 5 && x < 88) out.push({ x, label: DAY[cur.getDay()]! });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  });

  // The curve draws in once: dash length measured from the path, offset animated to zero.
  let path = $state<SVGPathElement | null>(null);
  let length = $state(0);
  onMount(() => {
    const el = path;
    if (el && typeof el.getTotalLength === "function") {
      try {
        length = el.getTotalLength();
      } catch {
        length = 0;
      }
    }
  });

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
    return { title: title.split(" · ")[0]!, status: title, sections, prompt: prompt ? { id: incident.id, text: prompt } : undefined };
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
  <div class="w fr" data-testid="brief-fleet-recovery" data-verdict={incident.verdict} data-live={live}>
    <div class="hd">
      <div class="hl">
        <div class="eyebrow" data-testid="brief-fleet-eyebrow">
          {#if live}<span class="live" aria-hidden="true"></span>{/if}
          {wide ? "Fleet recovery · 48h" : "Fleet recovery"}
        </div>
        <h3 data-testid="brief-fleet-verdict" role="group" aria-label={title} use:peek={{ state: brief, content: verdictPeek }}>{title}</h3>
      </div>
      {#if origin}<BriefOrigin {origin} />{/if}
    </div>

    <div class="body" class:tall>
      {#if wide}
        <div class="chart" class:tall data-testid="brief-fleet-chart">
          {#each geo.pins as p, i (p.index)}
            <span
              class="pinlbl"
              role="group"
              aria-label={`${p.label}, ${clockLabel(new Date(p.at).toISOString())}`}
              style="left:{(p.x / CHART.w) * 100}%;top:{(i % 2) * 12}px"
              data-testid="brief-fleet-pin"
              use:peek={{ state: brief, content: () => pinPeek(p) }}>Fix landed {clockLabel(new Date(p.at).toISOString())}</span
            >
          {/each}
          <svg viewBox="0 0 {CHART.w} {CHART.h}" preserveAspectRatio="none" role="img" aria-label="Stuck agents over the last 48 hours">
            {#if geo.area}<path class="area" d={geo.area} data-testid="brief-fleet-area" />{/if}
            <line class="base" x1={CHART.left} x2={CHART.w - CHART.right} y1={geo.baseY} y2={geo.baseY} />
            {#each geo.pins as p (p.index)}
              <line class="pin" x1={p.x} x2={p.x} y1={CHART.top} y2={geo.baseY} />
            {/each}
            <path class="line" class:draw={!reduced} bind:this={path} d={geo.line} style="--len:{length}" data-testid="brief-fleet-line" />
          </svg>
          <div class="axis" data-testid="brief-fleet-axis">
            {#each dayTicks as t (t.label + t.x)}<span style="left:{t.x}%">{t.label}</span>{/each}
            <span class="nowl">now</span>
          </div>
        </div>
      {/if}

      <div class="stuck" class:wide data-testid="brief-fleet-stuck">
        {#if !incident.stillStuck.length}
          <div class="none">No agent still stuck.</div>
        {:else}
          {#each list.shown as a (a.name)}
            <button type="button" class="ag" data-testid="brief-fleet-agent" aria-label={`${a.name}, ${a.reason}`} use:peek={{ state: brief, content: () => agentPeek(a) }}>
              <i class="dot" class:breathe={live}></i>
              <span class="nm">{a.name}</span>
              <span class="rs">{a.reason}</span>
              {#if tall}{@const since = stuckFor(a.since, nowMs)}{#if since}<span class="sn">{since}</span>{/if}{/if}
            </button>
          {/each}
          {#if list.rest.length}
            <div class="ag more" role="button" tabindex="0" data-testid="brief-fleet-more" use:peek={{ state: brief, content: morePeek }}>
              <i class="dot" class:breathe={live}></i>+{list.rest.length} more
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }
  .hl {
    min-width: 0;
  }
  .fr h3 {
    margin-top: 6px;
    cursor: default;
  }
  /* Pulse dot: only while the incident is live. */
  .live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--b-red);
    position: relative;
  }
  /* The pulse is a ring that scales and fades, so it stays on the compositor. */
  .live::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: 0 0 0 2px rgba(255, 69, 58, 0.6);
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% {
      transform: scale(1);
      opacity: 1;
    }
    70% {
      transform: scale(3.4);
      opacity: 0;
    }
    100% {
      transform: scale(3.4);
      opacity: 0;
    }
  }
  .body {
    display: flex;
    gap: 14px;
    margin-top: 10px;
    flex: 1;
    min-height: 0;
    align-items: flex-start;
  }
  .body.tall {
    margin-top: 14px;
  }
  /* curve */
  .chart {
    position: relative;
    flex: 1 1 55%;
    min-width: 0;
    padding-top: 26px;
  }
  .chart svg {
    display: block;
    width: 100%;
    height: 64px;
    overflow: visible;
  }
  .chart.tall svg {
    height: 112px;
  }
  .chart .area {
    fill: var(--b-red);
    fill-opacity: 0.22;
  }
  .chart .base {
    stroke: rgba(255, 255, 255, 0.08);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  .chart .pin {
    stroke: rgba(255, 255, 255, 0.4);
    stroke-width: 1;
    stroke-dasharray: 2 2;
    vector-effect: non-scaling-stroke;
  }
  .chart .line {
    fill: none;
    stroke: rgba(255, 255, 255, 0.6);
    stroke-width: 1.3;
    stroke-linejoin: round;
    stroke-linecap: round;
    vector-effect: non-scaling-stroke;
  }
  /* Draws in once; reduced motion shows the whole curve at once. */
  .chart .line.draw {
    stroke-dasharray: var(--len, 0);
    stroke-dashoffset: var(--len, 0);
    animation: draw 1.1s 0.3s ease-out forwards;
  }
  @keyframes draw {
    to {
      stroke-dashoffset: 0;
    }
  }
  .pinlbl {
    position: absolute;
    translate: 3px 0;
    font-family: var(--b-mono);
    font-size: 9px;
    letter-spacing: 0.04em;
    color: rgba(255, 255, 255, 0.55);
    white-space: nowrap;
    cursor: default;
    line-height: 12px;
  }
  .pinlbl:hover {
    color: var(--b-t1);
  }
  .axis {
    position: relative;
    height: 12px;
    margin-top: 4px;
    font-family: var(--b-mono);
    font-size: 8.5px;
    letter-spacing: 0.06em;
    color: var(--b-t3);
  }
  .axis span {
    position: absolute;
    top: 0;
    translate: -50% 0;
  }
  .axis .nowl {
    right: 0;
    translate: 0 0;
    color: var(--b-t2);
  }
  /* stuck set */
  .stuck {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1 1 100%;
    min-width: 0;
  }
  .stuck.wide {
    flex: 0 1 45%;
    min-width: 128px;
  }
  .ag {
    all: unset;
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border-radius: 11px;
    font-size: 12px;
    line-height: 1.25;
    color: var(--b-t1);
    min-width: 0;
    cursor: default;
    /* Glass: lit from the top, hairline rim. No inner shadow, no backdrop-filter. */
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.075), rgba(255, 255, 255, 0.025));
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-top-color: rgba(255, 255, 255, 0.16);
    transition: background 0.2s, border-color 0.2s;
  }
  .ag:hover,
  .ag:focus-visible {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.05));
    border-color: rgba(255, 255, 255, 0.18);
    outline: none;
  }
  .dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--b-red);
    box-shadow: 0 0 6px rgba(255, 69, 58, 0.55);
    transition: transform 0.2s;
  }
  .ag:hover .dot {
    transform: scale(1.4);
  }
  /* Still-stuck dots breathe only while the incident is live. */
  .dot.breathe {
    animation: br 2.4s infinite;
  }
  @keyframes br {
    50% {
      opacity: 0.5;
    }
  }
  .nm {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 50%;
  }
  .rs {
    flex: 1;
    min-width: 0;
    font-family: var(--b-mono);
    font-size: 10px;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .sn {
    flex: none;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: var(--b-t3);
  }
  .more {
    justify-content: center;
    color: var(--b-t2);
    font-size: 11.5px;
  }
  .more .dot {
    width: 6px;
    height: 6px;
    opacity: 0.7;
  }
  .none {
    font-size: 12px;
    color: var(--b-t2);
    padding: 6px 0;
  }
</style>
