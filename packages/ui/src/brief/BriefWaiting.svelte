<script lang="ts">
  /**
   * Who you are waiting on. The hourglass runs because you are waiting.
   * Rows: 3 in a one-column slot, 5 in wider ones, then a "+N more" row whose
   * peek lists the rest. Each row carries a mono age (amber past a day); its
   * peek says since when, what kind of wait it is, and offers the nudge prompt.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { productName } from "./brief-origin.js";
  import { sinceDay, waitingAge, waitingLimit, waitingRows, waitingSource, type WaitingKind } from "./brief-waiting.js";
  import { countUp } from "./count-up.js";
  import type { BriefWaiting } from "./brief-types.js";

  interface Props {
    waiting: BriefWaiting[];
    prompts: Record<string, string>;
    /** Columns of the slot: 1 (S) shows 3 rows, 2+ (W, W3, M) show 5. */
    cols?: number;
    /** Kinds another card already carries (handoff rows when Handoffs is placed). */
    hideKinds?: WaitingKind[];
    /** ISO time the brief is for; the peek's "since {day}" counts back from it. */
    now?: string;
  }
  let { waiting, prompts, cols = 1, hideKinds = [], now = new Date().toISOString() }: Props = $props();
  const brief = useBrief();
  const rows = $derived(waitingRows(waiting, hideKinds));
  const shown = $derived(rows.slice(0, waitingLimit(cols)));
  const rest = $derived(rows.slice(shown.length));

  const label = (w: BriefWaiting) => `${w.who} ${w.what}`;

  function content(w: BriefWaiting): PeekContent {
    const since = sinceDay(w.ageHours, now);
    const source = waitingSource(w.kind);
    return {
      sample: w.sample,
      title: label(w),
      status: since ? `You are waiting · since ${since}` : "You are waiting",
      origin: w.origin ? { companyUid: w.origin.companyUid, label: productName(w.origin.repo, w.origin.product) } : undefined,
      sections: source ? [{ label: "Source", text: source }] : [],
      prompt: prompts[w.id] ? { id: w.id, text: prompts[w.id]! } : undefined,
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more`,
    status: "Also waiting on",
    sections: [{ label: "Waiting on", lines: rest.map((w) => ({ label: label(w), state: waitingAge(w.ageHours)?.label ?? "", tone: waitingAge(w.ageHours)?.old ? ("warn" as const) : undefined })) }],
  });
</script>

<div class="w c-amber" data-testid="brief-waiting">
  <svg class="glass" viewBox="0 0 34 40" fill="none" aria-hidden="true">
    <path d="M7 3h20M7 37h20M9 3c0 9 8 11 8 17S9 28 9 37M25 3c0 9-8 11-8 17s8 8 8 17" stroke="rgba(255,255,255,.8)" stroke-width="1.6" stroke-linecap="round" />
    <path class="top" d="M11 7h12c-1 5-6 7-6 9 0-2-5-4-6-9z" fill="rgba(255,255,255,.85)" />
    <path class="bot" d="M11 35h12c-1-4-5-6-6-6s-5 2-6 6z" fill="rgba(255,255,255,.85)" />
    <line class="stream" x1="17" y1="17" x2="17" y2="30" stroke="#fff" stroke-width="1.4" />
  </svg>
  <div class="eyebrow">Waiting on</div>
  <div class="big" style="font-size:42px;margin-top:6px" use:countUp={rows.length}>0</div>
  {#each shown as w (w.id)}
    {@const age = waitingAge(w.ageHours)}
    <div class="row" role="group" aria-label={label(w)} data-testid="brief-waiting-row" use:peek={{ state: brief, content: () => content(w) }}>
      <span class="bul" style="background:#fff"></span>
      <div class="tx">{w.who} <em>{w.what}</em></div>
      {#if age}<span class="age" class:old={age.old} data-testid="brief-waiting-age" title={age.old ? "Over a day" : "Under a day"}>{age.label}</span>{/if}
    </div>
  {/each}
  {#if rest.length}
    <div class="row more" role="button" tabindex="0" data-testid="brief-waiting-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
  {/if}
</div>

<style>
  .glass {
    position: absolute;
    top: 16px;
    right: 16px;
    width: 30px;
    height: 36px;
  }
  .glass .top {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: drain 4s linear infinite;
  }
  .glass .bot {
    transform-box: fill-box;
    transform-origin: 50% 100%;
    animation: fill 4s linear infinite;
  }
  .glass .stream {
    stroke-dasharray: 2 3;
    animation: fall 0.5s linear infinite;
  }
  @keyframes drain {
    to {
      transform: scaleY(0.15);
    }
  }
  @keyframes fill {
    from {
      transform: scaleY(0.15);
    }
  }
  @keyframes fall {
    to {
      stroke-dashoffset: -5;
    }
  }
  .row {
    align-items: center;
  }
  .row .bul {
    margin-top: 0;
  }
  .tx {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row em {
    color: rgba(255, 255, 255, 0.76) !important;
  }
  /* Age in mono at the row end; past a day it sits on a darker pill in warm amber. */
  .age {
    flex: none;
    margin-left: auto;
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    line-height: 16px;
    color: rgba(255, 255, 255, 0.72);
  }
  .age.old {
    padding: 0 6px;
    border-radius: 999px;
    color: #ffe08a;
    background: rgba(0, 0, 0, 0.28);
  }
  .more {
    justify-content: center;
    margin-top: 10px;
    padding: 4px 10px;
    border-radius: 10px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.82);
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgba(255, 255, 255, 0.14);
    outline: none;
  }
</style>
