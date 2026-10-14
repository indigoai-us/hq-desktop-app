<script lang="ts">
  /**
   * A live incident. Pulse dot = live data. The eyebrow names the product
   * ("HQ Cloud main is red · live"), never a repo slug, with the company logo
   * at its end. A red main shows the workflow as the title and a facts grid:
   * job, how long it has been red, changes merged on top. A measured incident
   * shows the affected count and a dot per affected unit (never the whole
   * fleet); hovering a dot inspects it. Tall slots add the fix chips, the
   * launch pill and the probe line. Other live incidents list under "Also
   * live" (at most four more, then "+N more"), each with its own peek.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import { LIST_CAP, affectedOf, fixTitle, incidentEyebrow, incidentShortState, mergesOnTopText, moreFixesPeek, moreIncidentsPeek, redAge, riskPeek, watchTitle } from "./brief-peeks.js";
  import type { BriefRisk } from "./brief-types.js";

  interface Props {
    /** The lead incident (the one a priority points at, or the first). */
    risk: BriefRisk;
    prompt: string | undefined;
    rows: number;
    now?: string;
    /** Every live incident the catalogue counted; the lead stays first, the rest list under "Also live". Defaults to the lead alone. */
    incidents?: BriefRisk[] | null;
    /** Prompts by incident id, for the other rows' peeks. */
    prompts?: Record<string, string> | null;
  }
  let { risk, prompt, rows, now = new Date().toISOString(), incidents = null, prompts = null }: Props = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  const m = $derived(risk.measure);
  const stuck = $derived(affectedOf(risk) ?? 0);
  const ci = $derived(risk.ci ?? null);
  const eyebrow = $derived(incidentEyebrow(risk));
  const age = $derived(ci ? redAge(ci, now) : null);
  const onTop = $derived(mergesOnTopText(risk));
  // The other live incidents: never more than four under the lead, then "+N more".
  const others = $derived((incidents ?? []).filter((r) => r.id !== risk.id));
  const shownOthers = $derived(others.slice(0, 4));
  const restOthers = $derived(others.slice(shownOthers.length));
  // Fixes in review: plain titles with the product's logo, five at most, then "+N more".
  const shownFixes = $derived(risk.links.slice(0, LIST_CAP));
  const restFixes = $derived(risk.links.slice(shownFixes.length));
  const promptOf = (r: BriefRisk) => prompts?.[r.id] ?? r.prompt;
  const unitOne = $derived(m ? m.unit.replace(/s$/, "") : "unit");
  let probe = $state("");
</script>

<div
  class="w c-red"
  data-testid="brief-incident"
  role="group"
  aria-label={risk.title}
  use:peek={{ state: brief, content: () => riskPeek(risk, prompt, now) }}
>
  <!-- The headline is what is on fire, in plain words, with a pulsing LIVE tag; the company sits at its right. -->
  <div class="inc-head">
    <span class="eb" data-testid="brief-incident-eyebrow">{eyebrow}<span class="livetag"><span class="vh">{" · "}</span><span class="live" aria-hidden="true"></span>live</span></span>
    {#if risk.origin.companyUid}
      <span class="lgo" data-testid="brief-incident-logo"><BriefLogo company={brief.company(risk.origin.companyUid)} fallback={risk.origin.companyUid} size={20} /></span>
    {/if}
  </div>
  {#if m}
    <!-- The count, with one lit cell per stuck unit beside it (never the whole fleet). -->
    <div class="count">
      <div class="big" style="font-size:var(--b-fs-num)" use:countUp={stuck}>0</div>
      {#if stuck > 0}
        <div class="dots" data-testid="brief-incident-dots" aria-label="{stuck} {m.unit} stuck">
          {#each Array.from({ length: stuck }, (_, i) => i) as i (i)}
            <i
              role="img"
              aria-label="Stuck {unitOne}"
              onmouseenter={() => (probe = `${unitOne.toUpperCase()} ${i + 1} OF ${stuck} · ${m.cause.toUpperCase()}`)}
              onmouseleave={() => (probe = "")}
            ></i>
          {/each}
        </div>
      {/if}
    </div>
    <div class="sub" data-testid="brief-incident-sub"><span class="unit">{m.unit} stuck · {m.cause}</span><br />{risk.summary}</div>
  {:else if ci}
    {#if ci.note && ci.note !== ci.workflow}<p class="lede">{ci.note}</p>{/if}
    <!-- The details as label / value rows at the card's foot. -->
    <div class="facts" data-testid="brief-incident-facts">
      <div><span>Workflow</span><b data-testid="brief-incident-title">{ci.workflow ?? risk.title}</b></div>
      {#if ci.job}<div><span>Job</span><b>{ci.job}</b></div>{/if}
      {#if age}<div><span>Since</span><b>{age}</b></div>{/if}
      {#if onTop}<div><span>Main</span><b>{onTop}</b></div>{/if}
      {#if !tall && risk.links.length}<div><span>Fixes</span><b>{risk.links.length} in review</b></div>{/if}
    </div>
  {:else}
    <h3>{risk.summary}</h3>
  {/if}
  {#if tall}
    {#if risk.links.length}
      <div class="prs" data-testid="brief-incident-fixes">
        {#each shownFixes as l, i (`${l.label}-${i}`)}
          <span class="chip fix" data-testid="brief-incident-fix"><BriefOrigin origin={l.origin} product /><span class="fix-t">{fixTitle(l)}</span></span>
        {/each}
        {#if restFixes.length}
          <span class="chip fix more" role="group" aria-label="More fixes" data-testid="brief-incident-fixes-more" use:peek={{ state: brief, content: () => moreFixesPeek(restFixes) }}>+{restFixes.length} more</span>
        {/if}
      </div>
      <div class="sub" style="font-size:11px;margin-top:6px">{risk.links.length} fix{risk.links.length === 1 ? "" : "es"} in review</div>
    {/if}
    {#if prompt}<div class="start">{#if brief.notes[risk.id]}<span class="launch-note">{brief.notes[risk.id]}</span>{:else}<BriefLaunch id={risk.id} {prompt} compact />{/if}</div>{/if}
    {#if m}<div class="probe">{probe || "HOVER ONE TO INSPECT"}</div>{/if}
  {/if}
  {#if others.length}
    <div class="also" data-testid="brief-incident-also">
      <div class="also-l">Also live</div>
      {#each shownOthers as r (r.id)}
        <div class="arow" role="group" aria-label={r.title} data-testid="brief-incident-other" use:peek={{ state: brief, content: () => riskPeek(r, promptOf(r), now) }}>
          {#if r.origin.companyUid}<span class="lgo-s"><BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={14} /></span>{/if}
          <span class="tx">{watchTitle(r)}</span>
          {#if incidentShortState(r, now)}<span class="st">{incidentShortState(r, now)}</span>{/if}
        </div>
      {/each}
      {#if restOthers.length}
        <div class="arow more" role="button" tabindex="0" data-testid="brief-incident-more" use:peek={{ state: brief, content: () => moreIncidentsPeek(restOthers, now) }}>+{restOthers.length} more</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .inc-head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
  }
  /* What is on fire, as the card's title. */
  .eb {
    flex: 1;
    min-width: 0;
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: #fff;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  /* LIVE: the shared mono label as a glass pill, its dot pulsing, in the card's top-right corner
     opposite the card label (same 18px / 20px inset and 20px height). */
  .livetag {
    position: absolute;
    z-index: 4;
    top: 18px;
    right: 20px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(255, 255, 255, 0.2);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  .live {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #fff;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0.7);
    }
    70% {
      box-shadow: 0 0 0 6px rgba(255, 255, 255, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(255, 255, 255, 0);
    }
  }
  .lgo {
    flex: none;
    margin-top: 0;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    overflow: hidden;
  }
  .lede {
    margin: 8px 0 12px;
    font-size: 13px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }
  /* Label / value rows at the foot, over a hairline: labels in the mono caps style. */
  .facts {
    display: grid;
    gap: 6px;
    margin-top: auto;
    padding-top: 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.2);
    font-size: 13px;
    line-height: 1.3;
  }
  .facts > div {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
  }
  .facts span {
    flex: none;
    width: 68px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }
  .facts b {
    min-width: 0;
    font-weight: 500;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .prs {
    display: flex;
    gap: 6px;
    margin-top: 10px;
    flex-wrap: wrap;
  }
  /* A fix chip: the product's logo and name, then the plain title; never a slug or a PR number. */
  .chip.fix {
    font-family: var(--b-ui, system-ui);
    font-size: 11px;
    letter-spacing: 0;
    max-width: 100%;
  }
  .chip.fix .fix-t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.fix.more {
    font-family: var(--b-mono);
    font-size: 11px;
    cursor: default;
  }
  .start {
    margin-top: 10px;
  }
  .probe {
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: rgb(var(--b-ink) / 0.85);
    min-height: 14px;
    margin-top: 8px;
  }
  /* Other live incidents: glass rows under a small label. */
  .also {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .also-l {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
    margin-bottom: 2px;
  }
  .arow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 7px 10px;
    border-radius: 10px;
    font-size: 13px;
    line-height: 1.3;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    border: 0;
    transition: background 0.2s;
  }
  .arow:hover,
  .arow:focus-visible {
    background: rgb(var(--b-ink) / 0.16);
    outline: none;
  }
  .arow .tx {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .arow .st {
    flex: none;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.75);
    white-space: nowrap;
  }
  .arow.more {
    justify-content: center;
    cursor: default;
  }
  .lgo-s {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    overflow: hidden;
  }
  /* The count and its stuck units: lit cells in the mosaic style, beside the number. */
  .count {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 2px;
  }
  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 120px;
  }
  .dots i {
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: rgba(255, 255, 255, 0.9);
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.45);
    cursor: crosshair;
    transition: scale 0.15s;
  }
  .dots i:hover {
    scale: 1.4;
  }
  .sub .unit {
    color: #fff;
    font-weight: 500;
  }
</style>
