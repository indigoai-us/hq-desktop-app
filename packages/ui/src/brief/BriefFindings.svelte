<script lang="ts">
  /**
   * What the bot has found so far, under the sunrise. Counters in the visual
   * language of the first-run import scene (FirstRunImportStep: hairline rule,
   * mono uppercase name, white tabular number) tick up with its own
   * countValue easing as findings land, each tinted by meaning. Sample cards
   * (title plus company chip) drift in and settle: proof of what the bot is
   * reading. Reduced motion: counters show their value and cards appear in
   * place.
   */
  import { onDestroy } from "svelte";
  import { fly } from "svelte/transition";
  import { countValue, type CountSample } from "../chat/first-run/knowledge-tree/scene-model.js";
  import { findingRows, sampleTone, type BriefFindings, type BriefSample } from "./brief-findings.js";

  interface Props {
    findings: BriefFindings;
    samples?: readonly BriefSample[];
    /** Cards shown at once. */
    cards?: number;
    /** Test seam; null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
    /** Test seam for the counter clock, in seconds. */
    clock?: () => number;
  }
  let { findings, samples = [], cards = 3, reducedMotion = null, clock }: Props = $props();

  /** How long a counter takes to reach a new value. */
  const TWEEN_S = 1.2;
  const prefersReduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const reduced = $derived(reducedMotion ?? prefersReduced);
  const now = () => (clock ? clock() : performance.now() / 1000);

  const rows = $derived(findingRows(findings));
  /** Per counter, the values seen and when, for countValue. */
  const history = new Map<string, CountSample[]>();
  let t = $state(0);
  let raf = 0;

  $effect(() => {
    const at = now();
    let moving = false;
    for (const r of rows) {
      const h = history.get(r.key) ?? [{ t: at, v: 0 }];
      if (h.at(-1)!.v !== r.value) h.push({ t: at, v: r.value });
      history.set(r.key, h);
      if (at < h.at(-1)!.t + TWEEN_S) moving = true;
    }
    t = at;
    if (moving && !reduced && typeof requestAnimationFrame === "function") tickUntilSettled();
  });

  function tickUntilSettled(): void {
    cancelAnimationFrame(raf);
    const step = () => {
      t = now();
      const settled = [...history.values()].every((h) => t >= h.at(-1)!.t + TWEEN_S);
      if (!settled) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  onDestroy(() => cancelAnimationFrame(raf));

  /** The number a counter shows now. */
  function shown(key: string, value: number): number {
    if (reduced) return value;
    const h = history.get(key);
    if (!h) return value;
    return Math.round(countValue(h, t, TWEEN_S));
  }
  const cardList = $derived(samples.slice(-cards));
</script>

<div class="fd" data-testid="brief-findings">
  {#if rows.length}
    <div class="rows">
      {#each rows as r (r.key)}
        <div class="row tone-{r.tone}" data-testid="brief-finding" data-key={r.key}>
          <span class="rule" aria-hidden="true"></span>
          <span class="name">{r.label}</span>
          <span class="count">
            <b data-testid="brief-finding-value">{shown(r.key, r.value)}</b>
            {#if r.sub}<span class="sub"> · {r.sub.value} {r.sub.label}</span>{/if}
          </span>
        </div>
      {/each}
    </div>
  {/if}
  {#if cardList.length}
    <ul class="cards">
      {#each cardList as s (`${s.at}|${s.title}`)}
        <li class="card" data-testid="brief-sample" in:fly={{ y: reduced ? 0 : 14, duration: reduced ? 0 : 420, opacity: reduced ? 1 : 0 }}>
          <span class="kind tone-{sampleTone(s.kind)}">{s.kind.replace(/[_-]+/g, " ")}</span>
          <span class="title">{s.title}</span>
          <span class="co">{s.company}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .fd {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    width: min(560px, 100%);
  }
  .rows {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 2px 14px;
  }
  .row {
    position: relative;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    height: 24px;
    padding-left: 10px;
  }
  .rule {
    position: absolute;
    top: 4px;
    bottom: 4px;
    left: 0;
    width: 1px;
    background: currentColor;
    opacity: 0.45;
  }
  .name {
    overflow: hidden;
    font-family: var(--b-mono, ui-monospace, monospace);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.55);
  }
  .count {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.5);
  }
  .count b {
    font-weight: 500;
    color: #fff;
  }
  .sub {
    font-size: 11.5px;
  }
  .tone-decision {
    color: #c084fc;
  }
  .tone-ok {
    color: #34c759;
  }
  .tone-warn {
    color: #facc15;
  }
  .tone-red {
    color: #ff6b5f;
  }
  .tone-sun {
    color: #ffb580;
  }
  .tone-neutral {
    color: rgba(255, 255, 255, 0.6);
  }
  .cards {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 5px;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 10px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.04);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
    font-size: 12.5px;
  }
  .kind {
    flex: none;
    font-family: var(--b-mono, ui-monospace, monospace);
    font-size: 9.5px;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: rgba(255, 255, 255, 0.88);
  }
  .co {
    flex: none;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 10.5px;
    color: rgba(255, 255, 255, 0.6);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14);
  }
</style>
