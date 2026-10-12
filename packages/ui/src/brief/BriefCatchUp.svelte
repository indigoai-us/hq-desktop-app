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
  <div class="eyebrow" style="color:var(--b-sun)">Welcome back · {away}</div>
  <div class="greet">Morning{input.userName ? `, ${input.userName}` : ""}.<br /><span data-testid="brief-catchup-greet">{greet}</span></div>
  {#if because}<div class="first" data-testid="brief-catchup-first">{because}</div>{/if}
  {#if cells}
    <div class="cu" style="--cols:{cells > 4 ? 3 : 2}">
      {#each shown as t (t.id)}
        <div class="tile" role="group" aria-label={t.text} data-testid="brief-catchup-tile" data-tone={t.tone} use:peek={{ state: brief, content: () => t.peek }}>
          <span class="tag tone-{t.tone}">{t.tag}</span>
          <div class="tx">{t.text}</div>
          {#if t.sub}<div class="ts">{t.sub}</div>{/if}
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
  .greet {
    font-size: 40px;
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin-top: 12px;
  }
  .greet span {
    color: var(--b-sun);
  }
  .first {
    margin-top: 10px;
    max-width: 560px;
    font-size: 13.5px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.86);
  }
  .cu {
    display: grid;
    grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr));
    gap: 10px;
    margin-top: 16px;
  }
  /* Glass tile: lit from the top, hairline rim, soft drop. No inner shadow,
     no backdrop-filter (WKWebView draws it as a square that ignores the radius). */
  .tile {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 11px 12px 10px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: none;
    transition: background 0.3s, border-color 0.3s;
  }
  .tile:hover,
  .tile:focus-visible {
    background: rgba(255, 255, 255, 0.07);
    border-color: rgba(255, 255, 255, 0.14);
    outline: none;
  }
  .tag {
    display: block;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .tag.tone-neutral {
    color: var(--b-t2);
  }
  .tx {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .ts {
    font-size: 11px;
    line-height: 1.3;
    color: var(--b-t2);
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
    padding-top: 6px;
  }
  .orgs :global(.org.product b) {
    font-size: 10.5px;
    color: var(--b-t2);
  }
  .more {
    justify-content: center;
    align-items: center;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
    cursor: default;
  }
  .quiet {
    margin-top: 16px;
  }
  .end {
    margin: auto 0 0;
    padding-top: 12px;
  }
</style>
