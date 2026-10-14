<script lang="ts">
  /**
   * Firsts: what you shipped yesterday for the first time. Glass medal tiles
   * (no inset, no backdrop-filter) with the company logo in a 50px disc, a
   * plain caption and the writer's why. Holographic foil follows the pointer
   * and glints once after load (not under reduced motion): the reward is
   * earned, never manufactured. Up to three tiles (one at S, two at W); the
   * rest sit behind a "+N more" peek. Renders nothing with no first.
   */
  import { onMount } from "svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import {
    GLINT_DELAY_MS,
    GLINT_MS,
    firstCaption,
    firstNotePrompt,
    firstPeek,
    firstProduct,
    firstSub,
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

  /** The foil's highlight and rim follow the pointer, as on the shipped card. */
  function track(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", `${((event.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--hy", `${((event.clientY - r.top) / r.height) * 100}%`);
    el.style.setProperty("--ang", `${(Math.atan2(event.clientY - r.top - r.height / 2, event.clientX - r.left - r.width / 2) * 180) / Math.PI + 90}deg`);
  }
</script>

{#if firsts.length}
  <div class="w" data-testid="brief-firsts" data-glint={glint ? "on" : "off"}>
    <div class="hd">
      <div>
        <div class="eyebrow">
          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></svg> Firsts
        </div>
        <h3 data-testid="brief-firsts-title">{firstsHeadline(firsts.length)}</h3>
      </div>
      {#if rest.length}
        <div class="more" role="button" tabindex="0" data-testid="brief-firsts-more" use:peek={{ state: brief, content: () => firstsMorePeek(rest) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    <div class="meds" style="--cols:{shown.length}">
      {#each shown as s (s.id)}
        {@const company = brief.company(s.origin.companyUid)}
        <div
          class="med"
          class:glint
          role="group"
          aria-label={`${firstCaption(s.title)} · a first for ${firstProduct(s)}`}
          data-testid="brief-first"
          onpointermove={track}
          use:peek={{ state: brief, content: () => firstPeek(s, prompt(s)) }}
        >
          <div class="disc">
            {#if company}
              <BriefLogo {company} size={28} />
            {:else}
              <span class="fig" data-testid="brief-first-figure">1st</span>
            {/if}
          </div>
          <div class="cap" data-testid="brief-first-caption">{firstCaption(s.title)}</div>
          <div class="cs" data-testid="brief-first-sub">{firstSub(s) || firstProduct(s)}</div>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 12px;
  }
  .more {
    flex: none;
    margin-top: 2px;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    padding: 4px 8px;
    border-radius: 8px;
    color: var(--b-t2);
    border: 1px solid rgb(var(--b-ink) / 0.09);
    white-space: nowrap;
    cursor: default;
    transition: color 0.2s, border-color 0.2s;
  }
  .more:hover,
  .more:focus-visible {
    color: var(--b-t1);
    border-color: rgb(var(--b-ink) / 0.18);
    outline: none;
  }
  .meds {
    flex: 1;
    display: grid;
    gap: 10px;
    margin-top: 12px;
    grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
    min-height: 0;
  }
  .med {
    position: relative;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    min-width: 0;
    border-radius: 6px;
    padding: 12px 10px 11px;
    /* Glass: lit from the top, hairline rim, soft drop. No inset shadow and no
       backdrop-filter (WKWebView draws it as a square that ignores the radius). */
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid rgb(var(--b-ink) / 0.09);
    box-shadow: none;
  }
  /* Holographic foil: only on a true first. Follows the pointer; glints once on load. */
  .med::before {
    content: "";
    position: absolute;
    inset: -1px;
    border-radius: inherit;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    /* A soft white light under the pointer, the same glass light the cards use; no colour. */
    background: radial-gradient(180px circle at var(--hx, 50%) var(--hy, 50%), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0) 70%);
  }
  .med::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    padding: 1px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.3s;
    /* The rim catches the light on the pointer's side and fades away from it, in white. */
    background: conic-gradient(from var(--ang, 0deg), rgba(255, 255, 255, 0.75), rgba(255, 255, 255, 0.2) 22%, rgba(255, 255, 255, 0.08) 50%, rgba(255, 255, 255, 0.2) 78%, rgba(255, 255, 255, 0.75));
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask-composite: exclude;
  }
  .med:hover::before,
  .med.glint::before {
    opacity: 1;
  }
  .med:hover::after,
  .med.glint::after {
    opacity: 0.95;
  }
  .disc {
    position: relative;
    width: 50px;
    height: 50px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--b-card-hi);
    border: 1px solid var(--b-line);
  }
  .disc :global(.blogo) {
    border-radius: 8px;
  }
  .fig {
    font-family: var(--b-mono);
    font-size: 13px;
    letter-spacing: -0.02em;
    color: var(--b-t1);
  }
  .cap {
    margin-top: 8px;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
    overflow-wrap: anywhere;
  }
  .cs {
    margin-top: 3px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--b-t2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
</style>
