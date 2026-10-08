<script lang="ts">
  /** The 10,000-ft view after days away: the few things that changed, nothing else. */
  import type { BriefInput } from "./brief-types.js";

  let { input, daysAway }: { input: BriefInput; daysAway: number } = $props();
  const items = $derived(
    [
      ...input.risks.filter((r) => r.severity === "incident").map((r) => ({ tone: "red", tag: "Incident", text: r.measure ? `${r.measure.total - r.measure.healthy} of ${r.measure.total} ${r.measure.unit}: ${r.title.toLowerCase()}. ${r.summary}` : `${r.title}. ${r.summary}` })),
      ...input.decisions.slice(0, 2).map((d) => ({ tone: "decision", tag: "Waiting on you", text: d.title })),
      ...input.shipped.slice(0, 2).map((s) => ({ tone: "ok", tag: "Shipped", text: `${s.title}: ${s.status}` })),
    ].slice(0, 4),
  );
</script>

<div class="w" data-testid="brief-catchup">
  <div class="eyebrow" style="color:var(--b-sun)">Welcome back · {daysAway} days at a glance</div>
  <div class="greet">Morning{input.userName ? `, ${input.userName}` : ""}.<br /><span>Here's what changed.</span></div>
  <div class="cu">
    {#each items as it, i (i)}
      <div><span class="tone-{it.tone}">{it.tag}</span>{it.text}</div>
    {/each}
  </div>
  <p class="sub end">Everything else can wait for a normal brief tomorrow.</p>
</div>

<style>
  .greet {
    font-size: 36px;
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1.05;
    margin-top: 12px;
  }
  .greet span {
    color: var(--b-sun);
  }
  .cu {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-top: 16px;
  }
  .cu div {
    padding: 12px 14px;
    border-radius: 16px;
    box-shadow: var(--b-well);
    background: rgba(255, 255, 255, 0.03);
    font-size: 12.5px;
    line-height: 1.3;
  }
  .cu span {
    display: block;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 6px;
  }
  .end {
    margin: auto 0 0;
  }
</style>
