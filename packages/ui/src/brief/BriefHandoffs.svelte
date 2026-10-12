<script lang="ts">
  /**
   * Ownership moved: handoffs that changed hands in the window and whether
   * they landed (access, acknowledgment, first activity). A dashed arrow with
   * a travelling baton = still in the air; a solid arrow = acknowledged; an
   * amber receiving ring = it is yours to acknowledge. Three receipt dots per
   * row: green done, grey ring missing, "?" unknown (never green), amber ring
   * when the row is overdue or in production. Hover reveals Acknowledge
   * (start in the engine) on your rows and Nudge (copy a DM draft, nothing is
   * sent) on the others; the peek shows the giver's note, the receipts, the
   * production flag and the prompt. Lists cap at five, then "+N more".
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { copyBriefPrompt, peek, useBrief } from "./brief-context.svelte.js";
  import {
    HANDOFF_ROWS,
    HANDOFF_ROWS_SHORT,
    RECEIPTS,
    acked,
    handoffHeadline,
    handoffPeek,
    initial,
    landed,
    landedCount,
    moreHandoffsPeek,
    promptFor,
    rankHandoffs,
    receiptHot,
    receiptState,
  } from "./brief-handoffs.js";
  import { monogramHue } from "./brief-origin.js";
  import type { BriefHandoff } from "./brief-types.js";

  interface Props {
    handoffs: BriefHandoff[];
    prompts: Record<string, string>;
    /** ISO time the brief is for; ages and the 24h amber rule read it. */
    now: string;
    rows: number;
  }

  let { handoffs, prompts, now, rows }: Props = $props();
  const brief = useBrief();
  const ranked = $derived(rankHandoffs(handoffs, now));
  const cap = $derived(rows > 1 ? HANDOFF_ROWS : HANDOFF_ROWS_SHORT);
  const shown = $derived(ranked.slice(0, cap));
  const rest = $derived(ranked.slice(cap));
  const done = $derived(landedCount(ranked));
  const headline = $derived(handoffHeadline(ranked));
  let copied = $state<string | null>(null);

  /** Nudge copies a DM-draft prompt; the person reads and sends it themselves. */
  async function nudge(h: BriefHandoff): Promise<void> {
    const prompt = promptFor(h, prompts);
    if (prompt && (await copyBriefPrompt(prompt))) {
      copied = h.id;
      setTimeout(() => (copied = null), 1400);
    }
  }
</script>

{#if ranked.length}
  <div class="w" data-testid="brief-handoffs">
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="2.5" /><circle cx="18.5" cy="12" r="2.5" /><path d="M8.5 12h6.5M12.5 9.5l2.5 2.5-2.5 2.5" /></svg>
      Ownership moved
    </div>
    <h3 data-testid="brief-handoffs-title">{headline}</h3>
    <div class="list">
      {#each shown as h (h.id)}
        {@const prompt = promptFor(h, prompts)}
        {@const isLanded = landed(h)}
        {@const isAcked = acked(h)}
        <div
          class="hr"
          class:me={h.me}
          class:landed={isLanded}
          class:done={brief.cleared[h.id]}
          data-testid="brief-handoff"
          data-handoff={h.id}
          data-landed={isLanded}
          role="group"
          aria-label={`${h.object} · ${h.from} to ${h.to}`}
          use:peek={{ state: brief, content: () => handoffPeek(h, prompt, now) }}
        >
          <span class="ini" style:--h={monogramHue(h.from)} title={h.from} data-testid="brief-handoff-from">{initial(h.from)}</span>
          <svg class="ar" viewBox="0 0 42 20" aria-hidden="true" data-testid="brief-handoff-arrow" data-acked={isAcked}>
            <line class="track" x1="2" y1="10" x2="34" y2="10" stroke-dasharray={isAcked ? null : "3 3"} />
            {#if isAcked}
              <path class="head" d="M30 6l5 4-5 4" />
            {:else}
              <circle class="ring" class:hot={h.me} cx="38" cy="10" r="3.5" />
              <circle class="baton" cx="4" cy="10" r="2" />
            {/if}
          </svg>
          <span class="ini" style:--h={monogramHue(h.to)} title={h.to} data-testid="brief-handoff-to">{initial(h.to)}</span>
          <span class="ob">
            <span class="name" data-testid="brief-handoff-object">{h.object}</span>
            <BriefOrigin origin={h.origin} product />
          </span>
          <span class="rc" role="group" aria-label="Receipts">
            {#each RECEIPTS as r (r.key)}
              {@const s = receiptState(h.receipts[r.key])}
              <i
                class="rd {s}"
                class:hot={receiptHot(h, r.key, now)}
                role="img"
                aria-label={`${r.label} ${s}`}
                title={`${r.label} · ${s}`}
                data-testid="brief-receipt"
                data-receipt={r.key}
                data-state={s}
              ></i>
            {/each}
          </span>
          {#if !isLanded && prompt}
            <span class="acts">
              {#if brief.cleared[h.id]}
                <span class="donechip">Done</span>
              {:else if h.me}
                <span class="verb" data-testid="brief-handoff-ack">Acknowledge</span>
                <BriefLaunch id={h.id} {prompt} compact />
              {:else}
                <button type="button" class="nudge" data-testid="brief-handoff-nudge" title="Copy a DM-draft prompt; nothing is sent" onclick={() => void nudge(h)}>
                  {copied === h.id ? "Copied" : "Nudge"}
                </button>
              {/if}
            </span>
          {/if}
        </div>
      {/each}
      {#if rest.length}
        <div class="hr more" role="button" tabindex="0" data-testid="brief-handoffs-more" use:peek={{ state: brief, content: () => moreHandoffsPeek(rest, now) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if rows > 1}
      <div class="foot" data-testid="brief-handoffs-foot"><span>Access · Ack · Active</span><span>{done} of {ranked.length} landed</span></div>
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
  .hr {
    position: relative;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 12px;
    transition: background 0.2s, opacity 0.4s;
  }
  .hr:hover,
  .hr:focus-within {
    background: rgba(255, 255, 255, 0.05);
  }
  .hr.landed {
    opacity: 0.72;
  }
  .hr.done .name {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.4);
  }
  .ini {
    width: 20px;
    height: 20px;
    flex: none;
    border-radius: 7px;
    display: grid;
    place-items: center;
    font-size: 10px;
    font-weight: 500;
    color: #fff;
    background: hsl(var(--h) 45% 42%);
    box-shadow: none;
  }
  .ar {
    width: 42px;
    height: 20px;
    flex: none;
    overflow: visible;
  }
  .ar .track,
  .ar .head {
    fill: none;
    stroke: var(--b-t2);
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ar .ring {
    fill: none;
    stroke: var(--b-t3);
    stroke-width: 1.3;
  }
  .ar .ring.hot {
    stroke: var(--b-warn);
  }
  /* The baton travels giver -> receiver every 6s while the handoff is in the air. */
  .ar .baton {
    fill: var(--b-t1);
    animation: baton 6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
  }
  @keyframes baton {
    0% {
      opacity: 0;
      transform: translateX(0);
    }
    10% {
      opacity: 1;
    }
    70% {
      opacity: 1;
      transform: translateX(30px);
    }
    85%,
    100% {
      opacity: 0;
      transform: translateX(30px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ar .baton {
      opacity: 0;
    }
  }
  .ob {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    container-type: inline-size;
  }
  .ob .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ob :global(.org) {
    flex: none;
    margin-left: auto;
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 170px) {
    .ob :global(.org b) {
      display: none;
    }
  }
  .rc {
    display: flex;
    gap: 5px;
    flex: none;
  }
  .rd {
    position: relative;
    display: block;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, 0.18);
  }
  .rd.done {
    background: var(--b-ok);
    box-shadow: none;
  }
  .rd.hot {
    box-shadow: inset 0 0 0 1.5px var(--b-warn);
  }
  .rd.unknown::after {
    content: "?";
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    font-family: var(--b-mono);
    font-size: 7px;
    line-height: 1;
    color: var(--b-t3);
  }
  /* Actions appear only on the row under your attention and sit over the receipts. */
  .acts {
    position: absolute;
    right: 6px;
    top: 50%;
    translate: 0 -50%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 2px 2px 10px;
    border-radius: 10px;
    background: var(--b-card-hi);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .hr:hover .acts,
  .hr:focus-within .acts,
  .hr.done .acts {
    opacity: 1;
    pointer-events: auto;
  }
  .verb {
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--b-warn);
    white-space: nowrap;
  }
  .nudge {
    all: unset;
    cursor: pointer;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--b-t2);
    padding: 4px 8px;
    border-radius: 7px;
    box-shadow: var(--b-well);
    white-space: nowrap;
    transition: color 0.2s, box-shadow 0.2s;
  }
  .nudge:hover,
  .nudge:focus-visible {
    color: var(--b-t1);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
  }
  .donechip {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 10px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.14);
  }
  .more {
    justify-content: center;
    padding: 4px 8px;
    font-size: 12px;
    color: var(--b-t2);
    cursor: default;
  }
</style>
