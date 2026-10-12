<script lang="ts" module>
  import type { BriefDecision } from "./brief-types.js";

  /** What the call frees: unlock lines plus named blocks, the same count measure() puts in its fact. */
  export function unlockCount(d: BriefDecision): number {
    return (d.detail?.unlocks.length ?? 0) + (d.blocks?.length ?? 0);
  }

  /** The quote: the writer's lead hint when it wrote one, else the call and how much it unlocks. */
  export function oneThingQuote(d: BriefDecision | null, leadHint: string | null | undefined): string {
    const hint = (leadHint ?? "").trim();
    if (hint) return /[.!?]$/.test(hint) ? hint : `${hint}.`;
    if (!d) return "";
    const title = d.title.trim();
    const sentence = /[.!?]$/.test(title) ? title : `${title}.`;
    const k = unlockCount(d);
    return k ? `${sentence} It unlocks ${k} more.` : sentence;
  }

  /** Up to three because-chips: what clearing it unlocks first, then who or what it frees. */
  export function oneThingChips(d: BriefDecision | null): string[] {
    if (!d) return [];
    const chips = [
      ...(d.detail?.unlocks ?? []).map((u) => u.label),
      ...(d.blocks ?? []).map((b) => (b.kind === "person" ? `frees ${b.who}` : `frees ${b.what}`)),
    ];
    return [...new Set(chips.map((c) => c.trim()).filter(Boolean))].slice(0, 3);
  }
</script>

<script lang="ts">
  /**
   * If you do one thing: the call that unlocks the most (DailyBrief passes the
   * catalogue's pick), or the writer's lead hint when it wrote one. The W3
   * variant adds the because sentence under the quote; the quote's peek shows
   * why, what it unlocks, and the prompt. Up to three because-chips.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { decisionPeek } from "./brief-peeks.js";

  interface Props {
    /** The best decision (argmax peopleWaiting + unlocks + 2*revenue); null on a lead-hint-only day. */
    decision?: BriefDecision | null;
    prompt?: string;
    /** brief.json lead_hint: the writer's sentence, shown as the quote when present. */
    leadHint?: string | null;
    /** The because sentence (priority 1's when this is its call), shown at three columns. Falls back to the call's why. */
    because?: string | null;
    /** Slot columns; 3 (W3) shows the because sentence. */
    cols?: number;
  }
  let { decision = null, prompt = undefined, leadHint = null, because = null, cols = 2 }: Props = $props();
  const brief = useBrief();
  const quote = $derived(oneThingQuote(decision, leadHint));
  const chips = $derived(oneThingChips(decision));
  const why = $derived.by(() => {
    const text = (because ?? decision?.detail?.why ?? "").trim();
    if (!text) return "";
    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? "" : "."}`;
  });
  const wide = $derived(cols >= 3);
  const cleared = $derived(!!decision && !!brief.cleared[decision.id]);
</script>

<div class="w c-violet" class:wide data-testid="brief-one-thing">
  <div class="eyebrow">If you do one thing{#if wide && decision && unlockCount(decision)} · unlocks {unlockCount(decision)}{/if}</div>
  {#if decision}
    {@const d = decision}
    <div class="q" class:cleared role="group" aria-label={d.title} data-testid="brief-one-thing-quote" use:peek={{ state: brief, content: () => decisionPeek(d, prompt) }}>{quote}</div>
  {:else}
    <div class="q" data-testid="brief-one-thing-quote">{quote}</div>
  {/if}
  {#if wide && why}<div class="because" data-testid="brief-one-thing-because">{why}</div>{/if}
  <div class="why">
    {#each chips as c (c)}<span class="tag" data-testid="brief-one-thing-chip">{c}</span>{/each}
    {#if decision && cleared}
      <span class="go"><span class="donechip">Done</span></span>
    {:else if decision && prompt}
      <span class="go"><BriefLaunch id={decision.id} {prompt} compact choices={decision.action === "decide" ? decision.choices ?? null : null} /></span>
    {/if}
  </div>
  {#if decision && brief.notes[decision.id]}<div class="note" role="status">{brief.notes[decision.id]}</div>{/if}
</div>

<style>
  .q {
    font-size: var(--b-fs-title-lg);
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin-top: 10px;
  }
  .wide .q {
    font-size: var(--b-fs-title-lg);
  }
  .q.cleared {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.4);
    opacity: 0.6;
  }
  .because {
    margin-top: 8px;
    font-size: 12.5px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.76);
    max-width: 62ch;
  }
  .why {
    display: flex;
    gap: 8px;
    margin-top: auto;
    padding-top: 12px;
    flex-wrap: wrap;
    align-items: center;
  }
  .tag {
    font-family: var(--b-mono);
    font-size: 10px;
    padding: 5px 8px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.14);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .go {
    margin-left: auto;
  }
  .donechip {
    font-size: 12px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
  }
  .note {
    margin-top: 6px;
    font-size: 11px;
    color: #fff;
  }
</style>
