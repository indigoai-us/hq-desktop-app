<script lang="ts">
  /**
   * Welcome back: the 10,000-ft view after days away. The greeting names
   * priority 1 in the writer's words; under it, up to five glass tiles say what
   * changed (live incident, the two calls the catalogue ranked first, what got
   * fixed, what was handed to you, what shipped by product), each with the
   * item's peek and its launch prompt, then "+N more" whose peek lists the
   * rest. The tiles are exactly what the catalogue's measure() counted.
   */
  import BriefOrigin from "./BriefOrigin.svelte";
  import { buildContext, rankDecisions } from "./brief-catalogue.js";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { CATCH_UP_TILES, catchUpBecause, catchUpGreet, catchUpTiles, moreTilesPeek, type HeroLead } from "./brief-hero.js";
  import { briefPriorities } from "./brief-peeks.js";
  import { briefPrompts } from "./brief-prompts.js";
  import type { BriefDecision, BriefInput } from "./brief-types.js";

  interface Props {
    input: BriefInput;
    daysAway: number;
    /** Priority 1 in the writer's words. Left out: derived from the input; null: no lead line. */
    lead?: HeroLead | null;
    /** The decisions the catalogue ranked first (rankDecisions), top first; derived from the input when absent. */
    decisions?: BriefDecision[] | null;
    /** Launch prompts by item id (plan.prompts); derived from the input when absent. */
    prompts?: Record<string, string> | null;
  }
  let { input, daysAway, lead, decisions = null, prompts = null }: Props = $props();
  const brief = useBrief();
  const leadRow = $derived(lead === undefined ? (briefPriorities(input)[0] ?? null) : lead);
  const greet = $derived(catchUpGreet(leadRow));
  const because = $derived(catchUpBecause(leadRow));
  const ranked = $derived(decisions ?? rankDecisions(buildContext(input)));
  const tiles = $derived(catchUpTiles(input, { decisions: ranked, prompts: prompts ?? briefPrompts(input) }));
  // At most five tiles on the face; a "+N more" tile opens the rest in the peek.
  const shown = $derived(tiles.slice(0, CATCH_UP_TILES));
  const rest = $derived(tiles.slice(CATCH_UP_TILES));
  const cells = $derived(shown.length + (rest.length ? 1 : 0));
  const away = $derived(daysAway > 0 ? `${daysAway} day${daysAway === 1 ? "" : "s"} at a glance` : "what changed at a glance");
</script>

<div class="w" data-testid="brief-catchup">
  <div class="eyebrow">Welcome back · {away}</div>
  <!-- The page already says good morning; the card leads with what changed. -->
  <div class="greet"><span class="line" data-testid="brief-catchup-greet">{greet}</span></div>
  {#if because}<div class="first" data-testid="brief-catchup-first">{because}</div>{/if}
  {#if cells}
    <div class="cu" style="--cols:{Math.min(cells, 3)}">
      {#each shown as t (t.id)}
        <div class="tile" role="group" aria-label={t.text} data-testid="brief-catchup-tile" data-tone={t.tone} use:peek={{ state: brief, content: () => t.peek }}>
          <span class="tag tone-{t.tone}">{t.tag}</span>
          <div class="tx">{t.text}</div>
          {#if t.sub && !t.origins.some((o) => o.product === t.sub || o.repo === t.sub)}<div class="ts">{t.sub}</div>{/if}
          {#if t.origins.length}
            <div class="orgs">{#each t.origins.slice(0, 3) as o, i (`${o.companyUid ?? ""}:${o.repo ?? ""}:${o.product ?? ""}:${i}`)}<BriefOrigin origin={o} product />{/each}</div>
          {/if}
        </div>
      {/each}
      {#if rest.length}
        <div class="tile more" role="button" tabindex="0" data-testid="brief-catchup-more" use:peek={{ state: brief, content: () => moreTilesPeek(rest) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
  {:else}
    <p class="sub quiet" data-testid="brief-catchup-quiet">Nothing broke, nothing waits on you, and nothing shipped while you were away.</p>
  {/if}
  <p class="sub end">Everything else can wait for a normal brief tomorrow.</p>
</div>

<style>
  /* What changed, as the card's title. */
  .greet {
    margin-top: 0;
    font-size: var(--b-fs-title-lg);
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 1.25;
  }
  .greet .line {
    color: #fff;
  }
  .first {
    margin-top: 6px;
    max-width: 560px;
    font-size: 13px;
    line-height: 1.4;
    color: rgb(var(--b-ink) / 0.78);
  }
  /* Tiles fill the card: a row of glass tiles, label and title at the top, the product at the foot. */
  .cu {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr));
    grid-auto-rows: minmax(120px, 1fr);
    gap: 10px;
    margin-top: 18px;
  }
  .tile {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    padding: 14px;
    border-radius: 10px;
    background: rgb(var(--b-ink) / 0.12);
    border: 0;
    box-shadow: none;
    transition: background 0.3s;
  }
  .tile:hover,
  .tile:focus-visible {
    background: rgb(var(--b-ink) / 0.2);
    outline: none;
  }
  .tag {
    display: block;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgb(var(--b-ink) / 0.7);
    margin-bottom: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag.tone-neutral {
    color: rgb(var(--b-ink) / 0.7);
  }
  .tx {
    font-size: 15px;
    font-weight: 500;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .ts {
    font-size: 12px;
    line-height: 1.35;
    color: rgb(var(--b-ink) / 0.75);
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .orgs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: auto;
    padding-top: 8px;
  }
  .orgs :global(.org.product b) {
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.85);
  }
  .more {
    justify-content: center;
    align-items: center;
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.78);
    background: transparent;
    cursor: default;
  }
  .quiet {
    margin-top: 16px;
  }
  .end {
    margin: 0;
    padding-top: 16px;
    color: rgb(var(--b-ink) / 0.78);
  }
</style>
