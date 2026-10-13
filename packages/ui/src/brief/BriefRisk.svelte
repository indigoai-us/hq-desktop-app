<script lang="ts">
  /**
   * What is worth watching: every standing risk the catalogue counted, as
   * rows (at most five, then a "+N more" row whose peek lists the rest). Each
   * row carries the company logo, a plain title (a red main names its
   * product, never a repo slug) and, in a two-row slot, the muted why. A red
   * main gets a RED mark. Hovering a row opens its peek with the prompt. The
   * footer reads "Main health · N of M products green" when the sweep carried
   * main health; its peek lists every product GREEN or RED.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { LIST_CAP, capList, mainHealthLabel, mainHealthPeek, mainHealthSummary, moreWatchesPeek, riskPeek, riskProduct, watchTitle } from "./brief-peeks.js";
  import type { BriefMainHealth, BriefRisk } from "./brief-types.js";

  interface Props {
    /** One watch row (what DailyBrief passes today); used when `risks` is absent. */
    risk?: BriefRisk | null;
    prompt?: string;
    /** Every watch row the catalogue counted. */
    risks?: BriefRisk[] | null;
    prompts?: Record<string, string> | null;
    /** Rows of the slot: one-row sizes show titles only; a two-row slot adds each row's why. */
    rows?: number;
    cols?: number;
    /** The sweep's main health per product, for the footer and its peek. */
    mainHealth?: BriefMainHealth[] | null;
    now?: string;
  }
  let { risk = null, prompt = undefined, risks = null, prompts = null, rows = 1, cols = 1, mainHealth = null, now = new Date().toISOString() }: Props = $props();
  const brief = useBrief();
  const all = $derived(risks ?? (risk ? [risk] : []));
  const tall = $derived(rows > 1);
  const list = $derived(capList(all, LIST_CAP));
  const red = $derived(all.filter((r) => r.ci).length);
  const health = $derived(mainHealthSummary(mainHealth));
  const promptOf = (r: BriefRisk) => prompts?.[r.id] ?? (risk && r.id === risk.id ? prompt : undefined) ?? r.prompt;
  /** The muted why under a title: the product, then the summary when it adds something. */
  function why(r: BriefRisk): string {
    const product = riskProduct(r);
    const summary = r.summary.trim() && r.summary.trim() !== r.title.trim() ? r.summary.trim() : "";
    return [product, summary].filter(Boolean).join(" · ");
  }
</script>

<div class="w c-amber" data-testid="brief-risk" role="group" aria-label="Watch" data-cols={cols}>
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 17v.01" /></svg>
    <span data-testid="brief-risk-eyebrow">Watch{all.length > 1 ? ` · ${all.length}` : ""}{red ? ` · ${red} red on main` : ""}</span>
  </div>
  <div class="rows" class:tall>
    {#each list.shown as r (r.id)}
      <div class="rk" role="group" aria-label={r.title} data-testid="brief-risk-row" title={riskProduct(r)} use:peek={{ state: brief, content: () => riskPeek(r, promptOf(r), now) }}>
        {#if r.origin.companyUid}
          <span class="lg"><BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={16} /></span>
        {:else}
          <span class="bul" aria-hidden="true"></span>
        {/if}
        <div class="tx">
          <div class="t" data-testid="brief-risk-title">{watchTitle(r)}{#if r.sample}<span class="sample-tag">sample</span>{/if}</div>
          {#if tall && why(r)}<div class="y" data-testid="brief-risk-why">{why(r)}</div>{/if}
        </div>
        {#if r.ci}<span class="red" title="Red on main" data-testid="brief-risk-red">red</span>{/if}
      </div>
    {/each}
    {#if list.rest.length}
      <div class="rk more" role="button" tabindex="0" data-testid="brief-risk-more" use:peek={{ state: brief, content: () => moreWatchesPeek(list.rest) }}>+{list.rest.length} more</div>
    {/if}
  </div>
  {#if health}
    <div class="foot hl" data-testid="brief-risk-foot" role="group" aria-label="Main health" use:peek={{ state: brief, content: () => mainHealthPeek(mainHealth ?? []) }}>
      <span>{mainHealthLabel(health).split(" · ")[0]}</span>
      <span class:bad={health.red.length > 0} data-testid="brief-risk-health">{mainHealthLabel(health).split(" · ")[1]}</span>
    </div>
  {/if}
</div>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 10px;
    min-height: 0;
  }
  /* Glass row: translucent fill lit from the top, hairline rim, no inset well. */
  .rk {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    padding: 6px 9px;
    border-radius: 11px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.07);
    transition: background 0.2s;
  }
  .rk:hover,
  .rk:focus-visible {
    background: rgba(255, 255, 255, 0.08);
    outline: none;
  }
  .rows.tall .rk {
    align-items: flex-start;
    padding: 7px 10px;
  }
  .lg {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 5px;
    overflow: hidden;
  }
  .rows.tall .lg {
    margin-top: 1px;
  }
  .bul {
    flex: none;
    width: 6px;
    height: 6px;
    margin: 0 5px;
    border-radius: 50%;
    background: var(--b-warn);
  }
  .tx {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-size: 12.5px;
    font-weight: 500;
    line-height: 1.3;
    color: var(--b-t1);
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .y {
    margin-top: 1px;
    font-size: 11.5px;
    line-height: 1.35;
    color: var(--b-t2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .red {
    flex: none;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    line-height: 16px;
    padding: 0 6px;
    border-radius: 999px;
    color: var(--b-red);
    border: 1px solid rgba(255, 69, 58, 0.35);
    background: rgba(255, 69, 58, 0.08);
  }
  .rk.more {
    justify-content: center;
    font-size: 12px;
    color: var(--b-t2);
    cursor: default;
  }
  .foot.hl {
    cursor: default;
  }
  .foot .bad {
    color: var(--b-red);
  }
</style>
