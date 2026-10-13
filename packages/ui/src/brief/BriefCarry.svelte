<script lang="ts">
  /**
   * Carried over: what was open at your last brief and still has no follow-up
   * today, so nothing is dropped as "nothing new". One row per carried item:
   * a ring at the left whose colour carries age only (hollow white under a
   * day, amber past a day, red past two; grey and filled when a decision or
   * live incident today continues it), the title in plain words, the company
   * logo and product, and a mono tag ("2 briefs", "since Fri"; on a catch-up
   * day the day it was first seen). In a two-row slot each row also shows a
   * 72-hour micro-timeline: a dotted thread drifts from the day it was first
   * seen to today while it waits for a link, and sits solid and faded once a
   * card continues it. Hover a row for Start in <engine>; its peek shows why,
   * when it was first seen, the closest follow-up and the prompt. At most five
   * rows (three in a one-row slot), then "+N more" whose peek lists the rest.
   * Renders nothing with no rows; the picker hides it when every row is linked.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { CARRY_CAP, CARRY_CAP_SHORT, carryHeadline, carryMorePeek, carryPeek, carryRows, carryTag, orphanRows, resolvePrompt, threadX, type RingTone } from "./brief-carry.js";
  import type { BriefCarry, BriefDecision, BriefRisk } from "./brief-types.js";

  interface Props {
    carry: BriefCarry[];
    /** Today's decisions: a row whose itemId is one of them renders grey and launches that decision's prompt. */
    decisions: BriefDecision[];
    /** Today's risks: only live incidents continue a row (same rule as the picker). */
    risks: BriefRisk[];
    /** Prompt per item id from the plan; a linked row uses its linked item's. */
    prompts: Record<string, string>;
    rows: number;
    /** ISO time of the brief; ring colour is age against it. */
    now: string;
    /** Catch-up day: the mono tag shows the day each row was first seen. */
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

  const RING: Record<RingTone, string> = { white: "var(--b-t1)", warn: "var(--b-warn)", red: "var(--b-red)", grey: "rgb(var(--b-ink) / .32)" };
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
          <svg class="ring" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="5" fill={r.linked ? RING.grey : "none"} stroke={RING[r.tone]} stroke-width="1.8" />
          </svg>
          <div class="tx">
            <span class="t" data-testid="brief-carry-row-title">{r.title}</span>
            <BriefOrigin origin={r.carry.origin} product />
          </div>
          <span class="mt" class:y={r.tone === "warn"} class:r={r.tone === "red"} data-testid="brief-carry-tag">{carryTag(r, catchUp)}</span>
          {#if tall && x != null}
            <!-- 72h micro-timeline: first-seen dot, thread to today's ring. -->
            <svg class="thread-line" viewBox="0 0 160 10" preserveAspectRatio="none" aria-hidden="true">
              <line x1="4" y1="5" x2="154" y2="5" stroke="var(--b-line)" stroke-width="1" />
              <line class:thread={!r.linked} x1={x} y1="5" x2="154" y2="5" stroke={RING[r.tone]} stroke-width="1.2" opacity={r.linked ? 0.5 : 0.8} />
              <circle cx={x} cy="5" r="2.5" fill="var(--b-t2)" />
              <circle cx="154" cy="5" r="2" fill={r.linked ? RING.grey : "none"} stroke={RING[r.tone]} />
            </svg>
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
        <div class="orow more-row" role="button" tabindex="0" data-testid="brief-carry-more" use:peek={{ state: brief, content: () => carryMorePeek(rest, catchUp) }}>
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
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 10px;
    min-height: 0;
  }
  /* ring | title + origin | mono tag; the thread line sits under the title in two-row slots. */
  .orow {
    position: relative;
    display: grid;
    grid-template-columns: 14px minmax(0, 1fr) auto;
    gap: 2px 10px;
    align-items: center;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    border: 1px solid transparent;
    transition: background 0.2s, border-color 0.2s, opacity 0.5s;
  }
  .orow:hover,
  .orow:focus-within {
    background: rgb(var(--b-ink) / 0.05);
    border-color: rgb(var(--b-ink) / 0.06);
  }
  .ring {
    width: 14px;
    height: 14px;
    flex: none;
  }
  .tx {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    container-type: inline-size;
  }
  .t {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    line-height: 1.25;
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .linked .t {
    color: var(--b-t2);
  }
  .tx :global(.org) {
    flex: none;
    margin-left: auto;
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 220px) {
    .tx :global(.org b) {
      display: none;
    }
  }
  .mt {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .mt.y {
    color: var(--b-warn);
  }
  .mt.r {
    color: var(--b-red);
  }
  .thread-line {
    grid-column: 2 / 4;
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
  /* Actions appear only on the row that has your attention, over the tag. */
  .acts {
    position: absolute;
    right: 6px;
    top: 50%;
    translate: 6px -50%;
    display: flex;
    align-items: center;
    padding-left: 18px;
    opacity: 0;
    pointer-events: none;
    background: linear-gradient(90deg, transparent, var(--b-card-hi) 18px);
    transition: opacity 0.25s, translate 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .orow:hover .acts,
  .orow:focus-within .acts,
  .orow.done .acts {
    opacity: 1;
    translate: 0 -50%;
    pointer-events: auto;
  }
  .orow.done {
    opacity: 0.5;
  }
  .orow.done .t {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.4);
  }
  .donechip {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.14);
  }
  .more-row {
    display: flex;
    justify-content: center;
    padding: 5px 12px;
    font-size: 13px;
    color: var(--b-t2);
    cursor: default;
  }
  .more-row:focus-visible {
    outline: 2px solid rgb(var(--b-ink) / 0.5);
    outline-offset: 1px;
  }
</style>
