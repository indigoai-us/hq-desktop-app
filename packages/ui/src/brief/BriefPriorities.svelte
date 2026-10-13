<script lang="ts">
  /**
   * Today's priorities: a slim full-width card above the grid, one line per
   * priority (at most five), the text bold and the reason muted, the linked
   * item's company logo at the row end. Hovering a row opens the linked item's
   * peek with its Start and Copy actions; when the writer scored the row, the
   * peek status appends the score in words ("unblocks 3 people and revenue ·
   * 44h old"). A row is struck through once that item is cleared.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { decisionPeek, priorityScoreWords, riskPeek, riskProduct } from "./brief-peeks.js";
  import { productName } from "./brief-origin.js";
  import type { BriefDecision, BriefPriority, BriefRisk } from "./brief-types.js";

  interface Props {
    priorities: BriefPriority[];
    decisions: BriefDecision[];
    risks: BriefRisk[];
    prompts: Record<string, string>;
    /** ISO time the brief is for; red ages in incident peeks count back from it. */
    now?: string;
  }
  let { priorities, decisions, risks, prompts, now = "" }: Props = $props();
  const brief = useBrief();
  const rows = $derived(priorities.slice(0, 5));

  const decisionOf = (p: BriefPriority) => (p.itemId ? decisions.find((x) => x.id === p.itemId) : undefined);
  const riskOf = (p: BriefPriority) => (p.itemId ? risks.find((x) => x.id === p.itemId) : undefined);

  /** The linked item's company and product, for the row's logo. */
  function originOf(p: BriefPriority): { companyUid: string; product: string } | null {
    const d = decisionOf(p);
    if (d?.origin.companyUid) return { companyUid: d.origin.companyUid, product: productName(d.origin.repo, d.origin.product) };
    const r = riskOf(p);
    if (r?.origin.companyUid) return { companyUid: r.origin.companyUid, product: riskProduct(r) };
    return null;
  }

  function content(p: BriefPriority): PeekContent {
    const d = decisionOf(p);
    const r = d ? undefined : riskOf(p);
    const c: PeekContent = d
      ? decisionPeek(d, prompts[d.id])
      : r
        ? riskPeek(r, prompts[r.id] ?? r.prompt, now)
        : { title: p.text, status: p.because ?? undefined, sections: [] };
    const words = priorityScoreWords(p, d ?? r ?? null, now);
    if (words) c.status = [c.status, words].filter(Boolean).join(" · ");
    return c;
  }
</script>

<section class="w prio" data-testid="brief-priorities" aria-label="Today's priorities">
  <div class="eyebrow">Today's priorities</div>
  <ol>
    {#each rows as p, i (`${i}|${p.text}`)}
      {@const o = originOf(p)}
      <li
        class:done={p.itemId ? brief.cleared[p.itemId] : false}
        data-testid="brief-priority"
        use:peek={{ state: brief, content: () => content(p) }}
      >
        <span class="n">{i + 1}</span>
        <span class="tx"><b>{p.text}</b>{#if p.because}<span class="why">{" · "}{p.because}</span>{/if}</span>
        {#if o}
          <span class="lg" title={o.product} data-testid="brief-priority-logo"><BriefLogo company={brief.company(o.companyUid)} fallback={o.companyUid} size={14} /></span>
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .prio {
    margin-top: 14px;
    padding: 14px 20px;
    animation: none;
  }
  ol {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: grid;
  }
  li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    padding: 4px 6px;
    margin: 0 -6px;
    border-radius: 8px;
    font-size: 13px;
    line-height: 1.35;
    cursor: default;
    transition: background 0.15s;
  }
  li:hover {
    background: rgb(var(--b-ink) / 0.05);
  }
  .n {
    flex: none;
    width: 14px;
    font-family: var(--b-mono);
    font-size: 13px;
    font-weight: 400;
    color: var(--b-t3);
    font-variant-numeric: tabular-nums;
  }
  .tx {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lg {
    flex: none;
    margin-left: auto;
    align-self: center;
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    overflow: hidden;
    opacity: 0.85;
  }
  b {
    font-weight: 500;
    color: var(--b-t1, #fff);
  }
  .why {
    color: var(--b-t3);
  }
  li.done .tx {
    text-decoration: line-through;
    text-decoration-color: rgb(var(--b-ink) / 0.35);
    opacity: 0.5;
  }
</style>
