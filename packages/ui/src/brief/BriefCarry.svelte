<script lang="ts">
  /**
   * Carried over: what was open at your last brief and still has no follow-up
   * today, so nothing is dropped as "nothing new". One glass row per carried
   * item: the company's 20px logo circle at the left, the title in plain words
   * (two lines at most) and the age as a small pill at the right ("2 briefs",
   * "since Fri"; on a catch-up day the day it was first seen). The pill turns
   * warm yellow once the item is past a day (or has run two briefs); a row a
   * card continues today (a decision or live incident) is set quieter. In a
   * two-row slot each row also shows the product and a 72-hour micro-timeline:
   * a dotted thread drifts from the day it was first seen to today while it
   * waits for a link, and sits solid and faded once a card continues it. Hover
   * a row for Start in <engine>; its peek shows why, when it was first seen,
   * the closest follow-up and the prompt. At most five rows (three in a
   * one-row slot), then "+N more" whose peek lists the rest. Renders nothing
   * with no rows; the picker hides it when every row is linked.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { CARRY_CAP, CARRY_CAP_SHORT, carryHeadline, carryMorePeek, carryPeek, carryRows, carryTag, orphanRows, resolvePrompt, threadX, type RingTone } from "./brief-carry.js";
  import { productName } from "./brief-origin.js";
  import type { BriefCarry, BriefDecision, BriefRisk } from "./brief-types.js";

  interface Props {
    carry: BriefCarry[];
    /** Today's decisions: a row whose itemId is one of them is set quieter and launches that decision's prompt. */
    decisions: BriefDecision[];
    /** Today's risks: only live incidents continue a row (same rule as the picker). */
    risks: BriefRisk[];
    /** Prompt per item id from the plan; a linked row uses its linked item's. */
    prompts: Record<string, string>;
    rows: number;
    /** ISO time of the brief; the age tint is age against it. */
    now: string;
    /** Catch-up day: the age pill shows the day each row was first seen. */
    catchUp?: boolean;
  }
  let { carry, decisions, risks, prompts, rows, now, catchUp = false }: Props = $props();
  const brief = useBrief();

  const tall = $derived(rows > 1);
  const nowMs = $derived(Date.parse(now));
  const all = $derived(carryRows(carry, decisions, risks, nowMs));
  const orphans = $derived(orphanRows(all).length);
  const linked = $derived(all.length - orphans);
  // At most five rows in a list (three in a one-row slot); a "+N more" row opens the rest in the peek.
  const shown = $derived(all.slice(0, tall ? CARRY_CAP : CARRY_CAP_SHORT));
  const rest = $derived(all.slice(shown.length));

  /** Past a day (or two briefs running): the warm yellow tint used across the brief. */
  const old = (tone: RingTone) => tone === "warn" || tone === "red";
  /** Thread colour on the micro-timeline: white while fresh, warm yellow once old, faint when a card continues it. */
  const THREAD: Record<RingTone, string> = { white: "rgb(var(--b-ink) / .85)", warn: "#ffe08a", red: "#ffe08a", grey: "rgb(var(--b-ink) / .4)" };
</script>

{#if all.length}
  <div class="w" data-testid="brief-carry" data-orphans={orphans}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" /></svg>
      Still open since your last brief
    </div>
    <h3 data-testid="brief-carry-title">{carryHeadline(orphans)}</h3>
    <div class="list">
      {#each shown as r (r.carry.id)}
        {@const prompt = resolvePrompt(r, prompts)}
        {@const done = !!brief.cleared[r.launchId]}
        {@const x = threadX(r.ageHours)}
        <div
          class="orow"
          class:tall
          class:linked={!!r.linked}
          class:done
          data-testid="brief-carry-row"
          data-linked={r.linked ? "true" : "false"}
          data-tone={r.tone}
          role="group"
          aria-label={r.title}
          use:peek={{ state: brief, content: () => carryPeek(r, prompt) }}
        >
          <span class="lg"><BriefLogo company={brief.company(r.carry.origin.companyUid)} fallback={r.carry.origin.companyUid} size={20} /></span>
          <span class="t" data-testid="brief-carry-row-title">{r.title}</span>
          <span class="mt" class:old={old(r.tone)} data-testid="brief-carry-tag">{carryTag(r, catchUp)}</span>
          {#if tall}
            {@const product = productName(r.carry.origin.repo, r.carry.origin.product)}
            <div class="sub">
              {#if product}<span class="prod">{product}</span>{/if}
              {#if x != null}
                <!-- 72h micro-timeline: first-seen dot, thread to today. -->
                <svg class="thread-line" viewBox="0 0 160 10" preserveAspectRatio="none" aria-hidden="true">
                  <line x1="4" y1="5" x2="154" y2="5" stroke="rgb(var(--b-ink) / .2)" stroke-width="1" />
                  <line class:thread={!r.linked} x1={x} y1="5" x2="154" y2="5" stroke={THREAD[r.tone]} stroke-width="1.2" opacity={r.linked ? 0.6 : 0.9} />
                  <circle cx={x} cy="5" r="2.5" fill="rgb(var(--b-ink) / .7)" />
                  <circle cx="154" cy="5" r="2" fill={THREAD[r.tone]} />
                </svg>
              {/if}
            </div>
          {/if}
          <div class="acts">
            {#if done}
              <span class="donechip">Done</span>
            {:else}
              <BriefLaunch id={r.launchId} {prompt} compact />
            {/if}
          </div>
        </div>
      {/each}
      {#if rest.length}
        <div class="orow more" role="button" tabindex="0" data-testid="brief-carry-more" use:peek={{ state: brief, content: () => carryMorePeek(rest, catchUp) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if tall}
      <div class="foot">
        <span>{orphans} without follow-up{linked ? ` · ${linked} with a card today` : ""}</span>
        <span>Hover a row to start it</span>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* A small card's headline: one size up from the rows, never broken with a hyphen. */
  .w h3 {
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.01em;
    hyphens: none;
    overflow-wrap: normal;
    text-wrap: pretty;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    min-height: 0;
    container-type: inline-size;
  }
  /* Glass rows: logo circle | title (two lines at most) | age pill; in a two-row slot the
     product and the micro-timeline sit under the title. */
  .orow {
    position: relative;
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr) auto;
    grid-template-areas: "lg t mt";
    column-gap: 10px;
    row-gap: 4px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.14);
    border: 0;
    --acts-w: 64px;
    transition: background 0.2s, opacity 0.5s;
  }
  .orow.tall {
    grid-template-areas: "lg t mt" "lg sub sub";
  }
  .orow:hover,
  .orow:focus-within {
    background: rgb(var(--b-ink) / 0.22);
  }
  .lg {
    grid-area: lg;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    overflow: hidden;
  }
  .t {
    grid-area: t;
    min-width: 0;
    font-size: var(--b-row-fs, 13px);
    font-weight: 500;
    line-height: 1.3;
    color: var(--b-t1);
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
    transition: opacity 0.2s;
  }
  /* Continued by a card today: still listed, set back. */
  .linked .t {
    color: rgb(var(--b-ink) / 0.72);
  }
  .linked .lg {
    opacity: 0.7;
  }
  /* The age as a small glass pill; past a day, the warm yellow tint. */
  .mt {
    grid-area: mt;
    flex: none;
    height: 20px;
    padding: 0 8px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: rgb(var(--b-ink) / 0.88);
    background: rgb(var(--b-ink) / 0.16);
    transition: opacity 0.2s;
  }
  .mt.old {
    color: #ffe08a;
    background: rgba(255, 205, 110, 0.32);
  }
  .sub {
    grid-area: sub;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .prod {
    flex: none;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.75);
  }
  .thread-line {
    flex: 1;
    width: 100%;
    height: 10px;
    min-width: 0;
  }
  /* Dotted = still waiting for a link; the dash drifts slowly. */
  .thread {
    stroke-dasharray: 2 3;
    animation: drift 8s linear infinite;
  }
  @keyframes drift {
    to {
      stroke-dashoffset: -40;
    }
  }
  /* Actions float over the row's end on the row that has your attention; no panel behind
     them: the age pill fades and the title fades out under them instead. */
  .acts {
    position: absolute;
    z-index: 2;
    top: 50%;
    right: 8px;
    display: flex;
    align-items: center;
    opacity: 0;
    translate: 6px -50%;
    pointer-events: none;
    transition: opacity 0.25s, translate 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .orow:hover .acts,
  .orow:focus-within .acts,
  .orow.done .acts {
    opacity: 1;
    translate: 0 -50%;
    pointer-events: auto;
  }
  .orow:is(:hover, :focus-within) .mt,
  .orow.done .mt {
    opacity: 0;
  }
  .orow:is(:hover, :focus-within) .t,
  .orow.done .t {
    /* The title column ends at the pill's column (about 72px from the row's end), so the fade
       starts just before the actions' left edge, measured from there. */
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% + 72px - var(--acts-w) - 28px), transparent calc(100% + 72px - var(--acts-w) - 4px));
    mask-image: linear-gradient(90deg, #000 calc(100% + 72px - var(--acts-w) - 28px), transparent calc(100% + 72px - var(--acts-w) - 4px));
  }
  /* Controls one height (26px) on the glass, no ring or drop; the row title's shadow stays off them. */
  .acts :global(.launch) {
    gap: 4px;
    text-shadow: none;
  }
  .acts :global(.launch .go) {
    height: 26px;
    padding: 0 10px;
    box-shadow: none;
  }
  .acts :global(.launch .go:hover) {
    background: rgba(255, 255, 255, 0.86);
  }
  .acts :global(.launch .eng) {
    height: 26px;
    padding: 2px;
    border-radius: 8px;
    background: rgb(var(--b-ink) / 0.16);
  }
  .acts :global(.launch .eng button) {
    height: 22px;
    padding: 0 6px;
    border-radius: 6px;
    color: rgb(var(--b-ink) / 0.7);
  }
  .acts :global(.launch .eng button[aria-pressed="true"]) {
    background: rgba(255, 255, 255, 0.95);
    color: #1d3b6e;
  }
  .acts :global(.launch .copy) {
    width: 26px;
    height: 26px;
    background: rgb(var(--b-ink) / 0.16);
    color: rgb(var(--b-ink) / 0.85);
  }
  .acts :global(.launch .copy:hover) {
    background: rgb(var(--b-ink) / 0.26);
  }
  /* A narrow row has room for the start button only; a wide one also shows the engine switch and copy. */
  .acts :global(.launch .eng),
  .acts :global(.launch .copy) {
    display: none;
  }
  @container (min-width: 380px) {
    .acts :global(.launch .eng) {
      display: inline-flex;
    }
    .acts :global(.launch .copy) {
      display: inline-grid;
    }
    .orow {
      --acts-w: 190px;
    }
  }
  .orow.done {
    opacity: 0.5;
  }
  .orow.done .t {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.4);
  }
  .donechip {
    height: 22px;
    display: inline-flex;
    align-items: center;
    font-size: 11px;
    font-weight: 500;
    padding: 0 10px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.16);
  }
  /* "+N more": a plain glass row, centred. */
  .orow.more {
    display: flex;
    justify-content: center;
    padding: 6px 10px;
    font-size: var(--b-row-fs, 13px);
    color: rgb(var(--b-ink) / 0.85);
    cursor: default;
  }
  .orow.more:focus-visible {
    outline: 2px solid rgb(var(--b-ink) / 0.5);
    outline-offset: 1px;
  }
  /* A one-column card is too narrow for title and pill side by side: the title takes the
     full width and the pill drops under it (beside the timeline in a two-row slot). */
  @container (max-width: 260px) {
    .orow,
    .orow.tall {
      grid-template-columns: 20px auto minmax(0, 1fr);
      grid-template-areas: "lg t t" "lg mt sub";
      row-gap: 5px;
    }
    .orow:not(.tall) .sub {
      display: none;
    }
    /* The actions take the pill's line, so the title above stays whole. */
    .acts {
      top: auto;
      bottom: 5px;
      translate: 6px 0;
    }
    .orow:hover .acts,
    .orow:focus-within .acts,
    .orow.done .acts {
      translate: 0 0;
    }
    .orow:is(:hover, :focus-within) .t,
    .orow.done .t {
      -webkit-mask-image: none;
      mask-image: none;
    }
  }
</style>
