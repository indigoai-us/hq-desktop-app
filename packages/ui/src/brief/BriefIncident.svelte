<script lang="ts">
  /**
   * A live incident, read top to bottom as: what is on fire (the product's
   * logo and a plain title, with a LIVE tag in the corner), how big it is,
   * how long it has lasted, and what else is live.
   *
   * A measured incident leads with the affected count and a two-line caption
   * (what is stuck, and why), never the whole fleet. A red main shows its
   * facts (workflow, job, merges on top). Either way, when the brief knows how
   * long it has been live, a "stuck for" / "red for" track draws it on this
   * week's days (or the last 24 hours) with the duration as a pill: the most
   * alarming fact gets its own row instead of hiding in the summary.
   * Tall slots add the fix chips and the launch at the foot. Other live
   * incidents list under "Also live" (at most four more, then "+N more"),
   * each with its own peek.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { ageTone } from "./BriefNeedsYou.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { countUp } from "./count-up.js";
  import {
    LIST_CAP,
    affectedOf,
    durationTrack,
    fixTitle,
    incidentEyebrow,
    incidentHoursOf,
    incidentShortState,
    mergesOnTopText,
    moreFixesPeek,
    moreIncidentsPeek,
    redAge,
    redHoursOf,
    riskPeek,
    watchTitle,
    workflowsRed,
  } from "./brief-peeks.js";
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
  // How long it has been live, drawn as a track; null when the brief carries no duration.
  const hours = $derived(incidentHoursOf(risk, now));
  const track = $derived(durationTrack(hours, now));
  const tone = $derived(ageTone(hours));
  const verb = $derived(ci ? "Red" : "Stuck");
  // The summary repeats the duration the track draws, so a one-row slot leaves it to the peek.
  const showSummary = $derived(!track || tall);
  // The other live incidents: never more than four under the lead, then "+N more".
  const others = $derived((incidents ?? []).filter((r) => r.id !== risk.id));
  const shownOthers = $derived(others.slice(0, 4));
  const restOthers = $derived(others.slice(shownOthers.length));
  // Fixes in review: plain titles with the product's logo, five at most, then "+N more".
  const shownFixes = $derived(risk.links.slice(0, LIST_CAP));
  const restFixes = $derived(risk.links.slice(shownFixes.length));
  const promptOf = (r: BriefRisk) => prompts?.[r.id] ?? r.prompt;
  const unitOne = $derived(m ? m.unit.replace(/s$/, "") : "unit");
  const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
</script>

<div
  class="w c-red inc"
  class:tall
  data-testid="brief-incident"
  role="group"
  aria-label={risk.title}
  use:peek={{ state: brief, content: () => riskPeek(risk, prompt, now) }}
>
  <!-- What is on fire: the company's logo, then the plain title. LIVE sits in the card's top-right corner. -->
  <div class="inc-head">
    {#if risk.origin.companyUid}
      <span class="lgo" data-testid="brief-incident-logo"><BriefLogo company={brief.company(risk.origin.companyUid)} fallback={risk.origin.companyUid} size={20} /></span>
    {/if}
    <span class="eb" data-testid="brief-incident-eyebrow">{eyebrow}<span class="livetag"><span class="vh">{" · "}</span><span class="live" aria-hidden="true"></span>live</span></span>
  </div>

  <div class="body">
    {#if m}
      <!-- How big: the affected count, light and large, with what is stuck and why beside it. -->
      <div class="hero">
        <div class="num" role="img" aria-label="{stuck} {stuck === 1 ? unitOne : m.unit} stuck" data-testid="brief-incident-count"><span aria-hidden="true" use:countUp={stuck}>0</span></div>
        <div class="cap" data-testid="brief-incident-sub">
          <span class="unit">{stuck === 1 ? unitOne : m.unit} stuck</span>
          <span class="cause">{m.cause}</span>
        </div>
      </div>
    {:else if ci}
      {@const wf = workflowsRed(ci.note)}
      {#if wf}
        <!-- One dot per workflow on main, the red ones lit: the count at a glance instead of a sentence. -->
        <div class="wf" role="img" aria-label={ci.note} data-testid="brief-incident-workflows">
          <span class="wf-dots" aria-hidden="true">{#each Array.from({ length: wf.total }, (_, i) => i) as i (i)}<i class:on={i < wf.red}></i>{/each}</span>
          <span class="wf-label" aria-hidden="true">{wf.red} of {wf.total} workflows red</span>
        </div>
      {:else if ci.note && ci.note !== ci.workflow}<p class="lede">{ci.note}</p>{/if}
    {:else}
      <h3>{risk.summary}</h3>
    {/if}

    {#if track}
      <!-- How long: this week's days (or the last 24 hours), the live stretch filled from when it began to now. -->
      <div class="dur" class:hours={track.scale === "hours"} role="img" aria-label="{verb} for {track.label.toLowerCase()}" data-testid="brief-incident-duration">
        <div class="dur-h">
          <span class="dur-l" aria-hidden="true">{verb} for</span>
          <span class="pill-age {tone ?? ''}" aria-hidden="true" data-testid="brief-incident-duration-pill">{track.label}</span>
        </div>
        <div class="trk" aria-hidden="true">
          <span class="fill" class:clipped={track.clipped} style:left={pct(track.from)} style:width={pct(Math.max(0, track.to - track.from))} data-testid="brief-incident-duration-fill"></span>
        </div>
        <div class="ticks" aria-hidden="true">
          {#each track.ticks as t, i (i)}
            <span class:now={t.now} class:lead={t.at === 0} class:tail={t.at === 1} style:left={pct(t.at)}>{t.label}</span>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#if m && showSummary}
    <p class="sum" data-testid="brief-incident-summary">{risk.summary}</p>
  {/if}

  {#if ci}
    <!-- The details as label / value rows. -->
    <div class="facts" data-testid="brief-incident-facts">
      <div><span>Workflow</span><b data-testid="brief-incident-title">{ci.workflow ?? risk.title}</b></div>
      {#if ci.job}<div><span>Job</span><b>{ci.job}</b></div>{/if}
      <!-- The track already draws a known age; a date read from the note ("Red since Oct 9") stays a fact. -->
      {#if age && !track}<div><span>Since</span><b>{age}</b></div>{/if}
      {#if onTop}<div><span>Main</span><b>{onTop}</b></div>{/if}
      {#if !tall && risk.links.length}<div><span>Fixes</span><b>{risk.links.length} in review</b></div>{/if}
    </div>
  {/if}

  {#if tall && risk.links.length}
    <div class="fixes">
      <div class="sec-l">{risk.links.length} fix{risk.links.length === 1 ? "" : "es"} in review</div>
      <div class="prs" data-testid="brief-incident-fixes">
        {#each shownFixes as l, i (`${l.label}-${i}`)}
          <span class="chip fix" data-testid="brief-incident-fix"><BriefOrigin origin={l.origin} product /><span class="fix-t">{fixTitle(l)}</span></span>
        {/each}
        {#if restFixes.length}
          <span class="chip fix more" role="group" aria-label="More fixes" data-testid="brief-incident-fixes-more" use:peek={{ state: brief, content: () => moreFixesPeek(restFixes) }}>+{restFixes.length} more</span>
        {/if}
      </div>
    </div>
  {/if}

  {#if others.length}
    <div class="also" data-testid="brief-incident-also">
      <div class="sec-l">Also live</div>
      {#each shownOthers as r (r.id)}
        {@const st = incidentShortState(r, now)}
        <div class="arow" role="group" aria-label={r.title} data-testid="brief-incident-other" use:peek={{ state: brief, content: () => riskPeek(r, promptOf(r), now) }}>
          {#if r.origin.companyUid}<span class="lgo-s"><BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={16} /></span>{/if}
          <span class="tx">{watchTitle(r)}</span>
          {#if st}<span class="pill-age {r.ci ? (ageTone(redHoursOf(r, now)) ?? '') : ''}">{st}</span>{/if}
        </div>
      {/each}
      {#if restOthers.length}
        <div class="arow more" role="button" tabindex="0" data-testid="brief-incident-more" use:peek={{ state: brief, content: () => moreIncidentsPeek(restOthers, now) }}>+{restOthers.length} more</div>
      {/if}
    </div>
  {/if}

  {#if tall && prompt}
    <!-- What to do: the launch at the card's foot. -->
    <div class="start">{#if brief.notes[risk.id]}<span class="launch-note">{brief.notes[risk.id]}</span>{:else}<BriefLaunch id={risk.id} {prompt} compact />{/if}</div>
  {/if}
</div>

<style>
  .inc {
    container-type: inline-size;
  }
  .inc-head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    min-width: 0;
  }
  .lgo {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    margin-top: 0.5px;
    border-radius: 50%;
    overflow: hidden;
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
  /* LIVE: the shared mono label as a glass pill, its dot breathing, in the card's top-right
     corner opposite the card label (same 18px / 20px inset and 20px height). */
  .livetag {
    position: absolute;
    z-index: 4;
    top: 18px;
    right: 20px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    padding: 0 9px 0 8px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
  /* The live dot breathes (opacity and size), no glow ring. */
  .live {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #fff;
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.35;
      scale: 0.7;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live {
      animation: none;
    }
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
    min-width: 0;
  }
  /* The hero: a light, large count with a two-line caption beside it. */
  .hero {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .num {
    flex: none;
    font-size: 42px;
    font-weight: 300;
    line-height: 0.9;
    letter-spacing: -0.045em;
    color: #fff;
    font-variant-numeric: tabular-nums;
  }
  .cap {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    font-size: 13px;
    line-height: 1.3;
  }
  .cap .unit {
    color: #fff;
    font-weight: 500;
  }
  .cap .cause {
    color: rgba(255, 255, 255, 0.78);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wf {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .wf-dots {
    display: inline-flex;
    gap: 5px;
  }
  .wf-dots i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
  }
  .wf-dots i.on {
    background: #fff;
  }
  .wf-label {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.78);
  }
  .lede {
    margin: 0;
    font-size: 13px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.85);
  }
  .sum {
    margin: 10px 0 0;
    font-size: 13px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.78);
  }

  /* Mono labels: uppercase, 10px, tracked. */
  .dur-l,
  .sec-l,
  .facts span,
  .ticks span,
  .pill-age {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .dur-l,
  .sec-l {
    color: rgba(255, 255, 255, 0.7);
  }

  /* The duration: label and pill, then the track, then the day initials under it. */
  .dur {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .dur-h {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }
  /* An age pill: glass, warm past a day, coral past two (as on the other cards). */
  .pill-age {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border-radius: 999px;
    white-space: nowrap;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    text-shadow: none;
  }
  .pill-age.warn {
    color: #ffe08a;
    background: rgba(255, 205, 110, 0.32);
  }
  .pill-age.red {
    color: #fff;
    background: rgba(255, 107, 94, 0.42);
  }
  /* The track: a hatched glass capsule (the quiet days), the live stretch a solid white one. */
  .trk {
    position: relative;
    height: 10px;
    border-radius: 999px;
    background:
      repeating-linear-gradient(-45deg, rgba(255, 255, 255, 0.2) 0 1px, transparent 1px 4px),
      rgba(255, 255, 255, 0.1);
  }
  .fill {
    position: absolute;
    top: 0;
    bottom: 0;
    min-width: 10px;
    border-radius: 999px;
    background: #fff;
  }
  /* Began before the week shown: the stretch runs off the track's left end. */
  .fill.clipped {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.45), #fff 28px);
  }
  /* Now: a small notch at the stretch's right end, in the field's colour. */
  .fill::after {
    content: "";
    position: absolute;
    top: 3px;
    right: 3px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgba(236, 70, 146, 0.9);
  }
  .ticks {
    position: relative;
    height: 12px;
    margin-top: 4px;
  }
  .ticks span {
    position: absolute;
    top: 0;
    translate: -50% 0;
    line-height: 12px;
    color: rgba(255, 255, 255, 0.6);
    white-space: nowrap;
  }
  .ticks span.lead {
    translate: 0 0;
  }
  .ticks span.tail {
    translate: -100% 0;
  }
  .ticks span.now {
    color: #fff;
  }

  /* Label / value rows: labels in the mono caps style. */
  .facts {
    display: grid;
    gap: 6px;
    margin-top: auto;
    padding-top: 14px;
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
    color: rgba(255, 255, 255, 0.7);
  }
  .facts b {
    min-width: 0;
    font-weight: 500;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fixes {
    margin-top: 16px;
  }
  .prs {
    display: flex;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  /* A fix chip: the product's logo and name, then the plain title; never a slug or a PR number. */
  .chip.fix {
    font-family: var(--b-ui, system-ui);
    font-size: 11px;
    letter-spacing: 0;
    max-width: 100%;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
  }
  .chip.fix .fix-t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.fix.more {
    font-family: var(--b-code);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: default;
  }

  /* Other live incidents: glass rows under a small label. Narrow, the title takes the whole
     line and its state sits under it; wide, they share one line. Neither ever wraps. */
  .also {
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .also .sec-l {
    line-height: 12px;
  }
  .arow {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    column-gap: 8px;
    row-gap: 4px;
    align-items: center;
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
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .arow .tx {
    grid-column: 2;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .arow .pill-age {
    grid-column: 2;
    justify-self: start;
    height: 16px;
    padding: 0 6px;
  }
  .arow.more {
    display: flex;
    justify-content: center;
    font-family: var(--b-code);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: default;
  }
  .lgo-s {
    grid-column: 1;
    grid-row: 1;
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    overflow: hidden;
  }

  .start {
    margin-top: auto;
    padding-top: 16px;
  }

  /* Wide slots (W, W3, M): the count and the track share a row; also-live rows go one line. */
  @container (min-width: 380px) {
    .body:has(.hero + .dur) {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: end;
      column-gap: 32px;
    }
    .arow {
      grid-template-columns: 16px minmax(0, 1fr) auto;
    }
    .arow .pill-age {
      grid-column: 3;
      grid-row: 1;
    }
    .arow .tx {
      grid-row: 1;
    }
    /* A red main's facts become columns, label over value, so a one-row slot keeps room for "Also live". */
    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 28px;
    }
    .facts > div {
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      max-width: 100%;
    }
    .facts span {
      width: auto;
    }
    .facts b {
      max-width: 100%;
    }
  }

  /* Tall slots (M): the count grows, the track thickens, and everything stacks from the top;
     only the launch pins to the foot. */
  .inc.tall .body {
    display: flex;
    align-items: stretch;
    gap: 20px;
    margin-top: 20px;
  }
  .inc.tall .hero {
    gap: 16px;
  }
  .inc.tall .num {
    font-size: 64px;
  }
  .inc.tall .cap {
    font-size: 14px;
  }
  .inc.tall .trk {
    height: 14px;
  }
  .inc.tall .fill::after {
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
  }
  .inc.tall .ticks {
    margin-top: 6px;
  }
  .inc.tall .facts {
    margin-top: 20px;
    padding-top: 0;
  }
  .inc.tall .also {
    margin-top: 20px;
  }
</style>
