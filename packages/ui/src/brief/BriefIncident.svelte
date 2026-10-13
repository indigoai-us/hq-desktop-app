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
  <div class="eyebrow inc-eyebrow" title={risk.title}>
    <span class="live"></span>
    <span class="eb" data-testid="brief-incident-eyebrow">{eyebrow} · live</span>
    {#if risk.origin.companyUid}
      <span class="lgo" data-testid="brief-incident-logo"><BriefLogo company={brief.company(risk.origin.companyUid)} fallback={risk.origin.companyUid} size={16} /></span>
    {/if}
  </div>
  {#if m}
    <div class="big" style="margin-top:{tall ? 12 : 6}px;font-size:var(--b-fs-num)" use:countUp={stuck}>0</div>
    <div class="sub" data-testid="brief-incident-sub">{m.unit} stuck · {m.cause}<br />{risk.summary}</div>
  {:else if ci}
    <h3 data-testid="brief-incident-title">{ci.workflow ?? risk.title}</h3>
    <div class="facts" data-testid="brief-incident-facts">
      {#if ci.job}<div><span>Job</span>{ci.job}</div>{/if}
      {#if age}<div><span>Since</span>{age}</div>{/if}
      {#if onTop}<div><span>Main</span>{onTop}</div>{/if}
      {#if ci.note && ci.note !== ci.workflow}<div class="note">{ci.note}</div>{/if}
      {#if !tall && risk.links.length}<div><span>Fixes</span>{risk.links.length} in review</div>{/if}
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
  {#if m && stuck > 0}
    <!-- One dot per affected unit, never the whole fleet. -->
    <div class="dots" class:wide={!tall} data-testid="brief-incident-dots" aria-label="{stuck} {m.unit} stuck">
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

<style>
  .live {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #fff;
    animation: pulse 1.8s infinite;
  }
  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 rgb(var(--b-ink) / 0.7);
    }
    70% {
      box-shadow: 0 0 0 9px rgb(var(--b-ink) / 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgb(var(--b-ink) / 0);
    }
  }
  .inc-eyebrow {
    min-width: 0;
  }
  .eb {
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
  .lgo {
    flex: none;
    margin-left: auto;
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    overflow: hidden;
  }
  .facts {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.92);
  }
  .facts span {
    display: inline-block;
    min-width: 52px;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: rgb(var(--b-ink) / 0.6);
  }
  .facts .note {
    color: rgb(var(--b-ink) / 0.76);
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
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: rgb(var(--b-ink) / 0.6);
    margin-bottom: 2px;
  }
  .arow {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 8px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.3;
    color: rgb(var(--b-ink) / 0.92);
    background: rgb(var(--b-ink) / 0.1);
    border: 1px solid rgb(var(--b-ink) / 0.12);
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
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: rgb(var(--b-ink) / 0.72);
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
    width: 14px;
    height: 14px;
    border-radius: 4px;
    overflow: hidden;
  }
  /* The affected set: one square per stuck unit, wrapping; the fleet total never renders. */
  .dots {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: auto;
    padding-top: 10px;
  }
  .dots.wide {
    gap: 3px;
  }
  .dots i {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: rgba(0, 0, 0, 0.3);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.28);
    cursor: crosshair;
    transition: transform 0.2s, box-shadow 0.2s;
  }
  .dots.wide i {
    width: 8px;
    height: 8px;
  }
  .dots i:hover {
    transform: scale(1.6);
    box-shadow: 0 0 0 2px #fff;
  }
</style>
