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
      <div class="rk" role="group" aria-label={r.title} data-testid="brief-risk-row" use:peek={{ state: brief, content: () => riskPeek(r, promptOf(r), now) }}>
        {#if r.origin.companyUid}
          <span class="lg"><BriefLogo company={brief.company(r.origin.companyUid)} fallback={r.origin.companyUid} size={20} /></span>
        {:else}
          <span class="bul" aria-hidden="true"></span>
        {/if}
        <div class="tx">
          <div class="t" data-testid="brief-risk-title">{watchTitle(r)}{#if r.sample}<span class="sample-tag">sample</span>{/if}</div>
          {#if tall && why(r)}<div class="y" data-testid="brief-risk-why">{why(r)}</div>{/if}
        </div>
        {#if r.ci}<span class="red" data-testid="brief-risk-red">red</span>{/if}
      </div>
    {/each}
    {#if list.rest.length}
      <div class="rk more" role="button" tabindex="0" data-testid="brief-risk-more" use:peek={{ state: brief, content: () => moreWatchesPeek(list.rest) }}>+{list.rest.length} more</div>
    {/if}
  </div>
  {#if health}
    <!-- Main health: a mono label, one cell per product (red ones in coral), and the count. -->
    <div class="foot hl" data-testid="brief-risk-foot" role="group" aria-label="Main health" use:peek={{ state: brief, content: () => mainHealthPeek(mainHealth ?? []) }}>
      <span class="hl-l">{mainHealthLabel(health).split(" · ")[0]}</span>{" "}
      <span class="hl-v">
        <span class="cells" aria-hidden="true">
          {#each Array.from({ length: health.total }, (_, i) => i) as i (i)}<i class:bad={i >= health.green}></i>{/each}
        </span>
        <span class:bad={health.red.length > 0} data-testid="brief-risk-health">{mainHealthLabel(health).split(" · ")[1]}</span>
      </span>
    </div>
  {/if}
</div>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  /* Glass rows on the field: logo circle, the title (two lines at most), a RED tag for a red main. */
  .rk {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 8px 10px;
    border-radius: 10px;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    border: 1px solid rgba(255, 255, 255, 0.18);
    transition: background 0.2s;
  }
  .rk:hover,
  .rk:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .rows.tall .rk {
    align-items: flex-start;
  }
  .lg {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    overflow: hidden;
  }
  .bul {
    flex: none;
    width: 6px;
    height: 6px;
    margin: 0 7px;
    border-radius: 50%;
    background: #ffd27a;
  }
  .tx {
    flex: 1;
    min-width: 0;
  }
  .t {
    font-size: var(--b-row-fs, 13px);
    font-weight: 500;
    line-height: 1.3;
    color: #fff;
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow-wrap: anywhere;
  }
  .y {
    margin-top: 2px;
    font-size: 11px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.75);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .red {
    flex: none;
    height: 20px;
    display: inline-flex;
    align-items: center;
    padding: 0 8px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #fff;
    background: rgba(255, 90, 80, 0.45);
  }
  .rk.more {
    justify-content: center;
    border: 0;
    font-size: var(--b-row-fs, 13px);
    color: rgba(255, 255, 255, 0.85);
    cursor: default;
  }
  /* Foot: label above, cells and the count below, over the card's hairline. */
  .foot.hl {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: flex-start;
    gap: 8px;
    cursor: default;
  }
  .hl-l {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }
  .hl-v {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--b-row-fs, 13px);
    font-weight: 500;
    color: #fff;
  }
  .cells {
    display: inline-flex;
    gap: 3px;
  }
  .cells i {
    width: 8px;
    height: 8px;
    border-radius: 1.5px;
    background: rgba(255, 255, 255, 0.9);
  }
  .cells i.bad {
    background: #ff6b5e;
    box-shadow: 0 0 6px rgba(255, 107, 94, 0.8);
  }
  .foot .bad {
    color: #fff;
  }
</style>
