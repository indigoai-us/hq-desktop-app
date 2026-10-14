<script lang="ts">
  /**
   * Firsts: what shipped yesterday for the first time, said plainly. One first
   * leads as the card's title sentence (what happened), why it counts under
   * it, and the product it happened in at the foot (glass logo circle, the
   * product's human name, a mono caps "2 merged"). Two or three firsts read as
   * open rows: logo, the first, and "Product · why". A mono caps marker names
   * the count and the day; "+N more" holds the rest. Each first lifts to glass
   * once after load (not under reduced motion) and on hover, and peeks with
   * why, evidence and the team-note draft. Renders nothing with no first.
   */
  import { onMount } from "svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import {
    GLINT_DELAY_MS,
    GLINT_MS,
    firstDetail,
    firstLine,
    firstMeta,
    firstNotePrompt,
    firstPeek,
    firstProduct,
    firstsCount,
    firstsHeadline,
    firstsMorePeek,
    firstsOf,
    tileCount,
  } from "./brief-firsts.js";
  import type { BriefShipped } from "./brief-types.js";

  interface Props {
    shipped: BriefShipped[];
    cols: number;
    rows: number;
    /** Launch prompts by item id; the built-in team-note draft is the fallback. */
    prompts?: Record<string, string>;
    /** Test seam; null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
  }
  let { shipped, cols, rows, prompts = {}, reducedMotion = null }: Props = $props();
  const brief = useBrief();
  const firsts = $derived(firstsOf(shipped));
  const shown = $derived(firsts.slice(0, tileCount(cols, rows, firsts.length)));
  const rest = $derived(firsts.slice(shown.length));
  /** One first leads the card; two or three read as rows. */
  const layout = $derived(shown.length === 1 ? "hero" : "rows");
  const prompt = (s: BriefShipped) => prompts[s.id] ?? firstNotePrompt(s);

  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = $derived(reducedMotion ?? prefersReduced);
  let glint = $state(false);

  onMount(() => {
    if (reduced) return;
    const on = setTimeout(() => (glint = true), GLINT_DELAY_MS);
    const off = setTimeout(() => (glint = false), GLINT_DELAY_MS + GLINT_MS);
    return () => {
      clearTimeout(on);
      clearTimeout(off);
    };
  });
</script>

{#snippet logo(s: BriefShipped, size: number)}
  {@const company = brief.company(s.origin.companyUid)}
  <span class="lg" style:--lg="{size}px" aria-hidden="true">
    {#if company}
      <BriefLogo {company} {size} />
    {:else}
      <span class="fig" data-testid="brief-first-figure">1st</span>
    {/if}
  </span>
{/snippet}

{#if firsts.length}
  <div class="w" data-testid="brief-firsts" data-glint={glint ? "on" : "off"} data-layout={layout}>
    <!-- The card's own label; the corner tag names the card, so this one is hidden on a colour field. -->
    <div class="eyebrow">Firsts</div>
    <div class="hd">
      <h3 class="mk" data-testid="brief-firsts-title">
        {firstsCount(firsts.length)}<span class="day">{firstsHeadline(firsts.length).slice(firstsCount(firsts.length).length)}</span>
      </h3>
      {#if rest.length}
        <div class="more" role="button" tabindex="0" data-testid="brief-firsts-more" use:peek={{ state: brief, content: () => firstsMorePeek(rest) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>

    {#if layout === "hero"}
      {@const s = shown[0]!}
      {@const detail = firstDetail(s)}
      {@const meta = firstMeta(s)}
      <div
        class="f hero"
        class:glint
        role="group"
        aria-label={`${firstLine(s)} · a first for ${firstProduct(s)}`}
        data-testid="brief-first"
        use:peek={{ state: brief, content: () => firstPeek(s, prompt(s)) }}
      >
        <div class="cap" data-testid="brief-first-caption">{firstLine(s)}</div>
        {#if detail}<div class="sub" data-testid="brief-first-sub">{detail}</div>{/if}
        <div class="where">
          {@render logo(s, 22)}
          <span class="prod" data-testid="brief-first-product">{firstProduct(s)}</span>
          {#if meta}<span class="meta" data-testid="brief-first-meta">{meta}</span>{/if}
        </div>
      </div>
    {:else}
      <div class="list" data-n={shown.length}>
        {#each shown as s (s.id)}
          {@const detail = firstDetail(s)}
          <div
            class="f row"
            class:glint
            role="group"
            aria-label={`${firstLine(s)} · a first for ${firstProduct(s)}`}
            data-testid="brief-first"
            use:peek={{ state: brief, content: () => firstPeek(s, prompt(s)) }}
          >
            {@render logo(s, 28)}
            <div class="txt">
              <div class="cap" data-testid="brief-first-caption">{firstLine(s)}</div>
              <div class="sub" data-testid="brief-first-sub">
                <span class="prod" data-testid="brief-first-product">{firstProduct(s)}</span>{#if detail}<span class="sep" aria-hidden="true">·</span>{detail}{/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .w {
    container: firsts / inline-size;
  }
  /* The marker: the count and the day in mono caps. */
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex: none;
    min-height: 22px;
  }
  .hd .mk {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    margin: 0;
    font-family: var(--b-code);
    font-size: 10.5px;
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  /* "+N more": a mono caps glass chip. */
  .more {
    flex: none;
    display: inline-flex;
    align-items: center;
    height: 22px;
    padding: 0 9px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-t1);
    background: rgb(var(--b-ink) / 0.14);
    cursor: default;
    transition: background 0.2s;
  }
  .more:hover,
  .more:focus-visible {
    background: rgb(var(--b-ink) / 0.22);
    outline: none;
  }

  /* Each first: open, no box. It lifts to glass under the pointer and once after load. */
  .f {
    position: relative;
    min-width: 0;
    border-radius: 12px;
    background: rgb(var(--b-ink) / 0);
    transition: background 0.3s;
    cursor: default;
  }
  .f:hover,
  .f:focus-within {
    background: rgb(var(--b-ink) / 0.14);
  }
  .f.glint {
    background: rgb(var(--b-ink) / 0.14);
  }

  /* Logo circle: glass, the company's initial or icon in white. */
  .lg {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: var(--lg);
    height: var(--lg);
    border-radius: 50%;
    overflow: hidden;
    background: rgb(var(--b-ink) / 0.14);
  }
  .lg :global(.blogo .company-label-initials),
  .lg :global(.blogo .mono) {
    background: transparent;
    opacity: 1;
    color: var(--b-t1);
  }
  .fig {
    font-family: var(--b-code);
    font-size: 9px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--b-t1);
  }

  /* One first: the sentence leads; why under it; the product at the foot. */
  /* One first sits at the foot of the card, its marker as an overline (the reference's
     title-top, value-bottom), leaving the corner motif room on the right. */
  .w[data-layout="hero"] > .hd {
    margin-top: auto;
  }
  .hero {
    flex: none;
    display: flex;
    flex-direction: column;
    min-height: 0;
    margin: 2px -10px -6px;
    padding: 6px 10px 6px;
  }
  .hero .cap {
    flex: none;
    max-width: 30ch;
    font-size: var(--b-fs-title-lg, 20px);
    font-weight: 500;
    line-height: 1.2;
    letter-spacing: -0.02em;
    color: var(--b-t1);
    text-wrap: balance;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .hero .sub {
    flex: none;
    max-width: 46ch;
    margin-top: 8px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--b-t2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .where {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    margin-top: 14px;
  }
  .where .prod {
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    color: var(--b-t1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .meta {
    flex: none;
    margin-left: 4px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-t2);
  }

  /* Two or three firsts: open rows. */
  .list {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 0;
    margin: 10px -10px 0;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 9px 10px;
  }
  .row .lg {
    margin-top: 1px;
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .row .cap {
    font-size: 14px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: var(--b-t1);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row .sub {
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--b-t2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  /* Three rows: a tighter rhythm and one line of why each, so they fit a one-row slot. */
  .list[data-n="3"] {
    gap: 0;
    margin-top: 6px;
  }
  .list[data-n="3"] .row {
    padding-top: 7px;
    padding-bottom: 7px;
  }
  .list[data-n="3"] .row .sub {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .row .prod {
    font-weight: 500;
    color: var(--b-t1);
  }
  .sep {
    margin: 0 6px;
    color: var(--b-t3);
  }

  /* The narrow slot (S): a smaller sentence so a long first still fits in three lines. */
  @container firsts (max-width: 260px) {
    .hero .cap {
      font-size: 17px;
      -webkit-line-clamp: 4;
      line-clamp: 4;
    }
    .hero .sub {
      font-size: 12px;
      -webkit-line-clamp: 3;
      line-clamp: 3;
    }
    .hd .mk {
      font-size: 10px;
    }
    /* Beside "+N more" the day steps aside so the count stays whole. */
    .hd:has(.more) .day {
      display: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .f {
      transition: none;
    }
  }
</style>
