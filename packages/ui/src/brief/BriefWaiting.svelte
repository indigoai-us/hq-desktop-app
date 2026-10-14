<script lang="ts">
  /**
   * Who you are waiting on: the total in the top-right corner, then glass rows.
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
  <!-- The total sits in the top-right corner, level with the card label. -->
  <div class="total" aria-label="{rows.length} waiting" use:countUp={rows.length}>0</div>
  <div class="list">
    {#each shown as w (w.id)}
      {@const age = waitingAge(w.ageHours)}
      <div class="row" role="group" aria-label={label(w)} data-testid="brief-waiting-row" use:peek={{ state: brief, content: () => content(w) }}>
        <span class="ini" aria-hidden="true">{w.who.trim().charAt(0).toUpperCase()}</span>
        <div class="tx"><b>{w.who}</b> <em>{w.what}</em></div>
        {#if age}<span class="age" class:old={age.old} data-testid="brief-waiting-age">{age.label}</span>{/if}
      </div>
    {/each}
    {#if rest.length}
      <div class="row more" role="button" tabindex="0" data-testid="brief-waiting-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
    {/if}
  </div>
</div>

<style>
  /* The total, quietly: a small glass count in the top-right corner, level with the card label. */
  .total {
    position: absolute;
    z-index: 4;
    top: 18px;
    right: 20px;
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 7px;
    box-sizing: border-box;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.86);
    background: rgba(255, 255, 255, 0.14);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  /* Glass rows: who in a soft initial circle, the task beside it, the age as a pill. */
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: var(--b-row-fs, 13px);
    line-height: 1.3;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.18);
    transition: background 0.2s;
  }
  .row:hover,
  .row:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .ini {
    flex: none;
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    font-size: 11px;
    font-weight: 500;
    color: #fff;
    background: rgba(255, 255, 255, 0.2);
  }
  .tx {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .tx b {
    font-weight: 500;
  }
  .row em {
    font-style: normal;
    color: rgba(255, 255, 255, 0.78) !important;
  }
  .age {
    flex: none;
    margin-left: auto;
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.88);
    background: rgba(255, 255, 255, 0.16);
  }
  /* Past a day: a warm yellow tint. */
  .age.old {
    color: #fff4d6;
    background: rgba(255, 205, 110, 0.32);
  }
  /* "+N more": a plain glass pill, no rim. */
  .more {
    justify-content: center;
    border: 0;
    padding: 6px 10px;
    font-size: var(--b-row-fs, 13px);
    color: rgba(255, 255, 255, 0.85);
    cursor: default;
  }
</style>
