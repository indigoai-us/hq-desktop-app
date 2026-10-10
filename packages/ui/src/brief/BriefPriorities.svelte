<script lang="ts">
  /**
   * Today's priorities: a slim full-width card above the grid, one line per
   * priority (at most five), the text bold and the reason muted. Hovering a
   * row opens the linked item's peek with its Start and Copy actions; a row
   * is struck through once that item is cleared.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { decisionPeek, riskPeek } from "./brief-peeks.js";
  import type { BriefDecision, BriefPriority, BriefRisk } from "./brief-types.js";

  let {
    priorities,
    decisions,
    risks,
    prompts,
  }: { priorities: BriefPriority[]; decisions: BriefDecision[]; risks: BriefRisk[]; prompts: Record<string, string> } = $props();
  const brief = useBrief();
  const rows = $derived(priorities.slice(0, 5));

  function content(p: BriefPriority): PeekContent {
    const d = p.itemId ? decisions.find((x) => x.id === p.itemId) : undefined;
    if (d) return decisionPeek(d, prompts[d.id]);
    const r = p.itemId ? risks.find((x) => x.id === p.itemId) : undefined;
    if (r) return riskPeek(r, prompts[r.id] ?? r.prompt);
    return { title: p.text, status: p.because ?? undefined, sections: [] };
  }
</script>

<section class="w prio" data-testid="brief-priorities" aria-label="Today's priorities">
  <div class="eyebrow">Today's priorities</div>
  <ol>
    {#each rows as p, i (`${i}|${p.text}`)}
      <li
        class:done={p.itemId ? brief.cleared[p.itemId] : false}
        data-testid="brief-priority"
        use:peek={{ state: brief, content: () => content(p) }}
      >
        <span class="n">{i + 1}</span>
        <span class="tx"><b>{p.text}</b>{#if p.because}<span class="why">{" · "}{p.because}</span>{/if}</span>
      </li>
    {/each}
  </ol>
</section>

<style>
  .prio {
    margin-top: 14px;
    padding: 12px 18px 10px;
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
    background: rgba(255, 255, 255, 0.05);
  }
  .n {
    flex: none;
    width: 14px;
    font-family: var(--b-mono);
    font-size: 12px;
    font-weight: 300;
    color: var(--b-t3);
    font-variant-numeric: tabular-nums;
  }
  .tx {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
    text-decoration-color: rgba(255, 255, 255, 0.35);
    opacity: 0.5;
  }
</style>
