<script lang="ts">
  /** If you do one thing: the decision that unlocks the most. */
  import BriefLaunch from "./BriefLaunch.svelte";
  import { useBrief } from "./brief-context.svelte.js";
  import type { BriefDecision } from "./brief-types.js";

  let { decision, prompt }: { decision: BriefDecision; prompt: string | undefined } = $props();
  const brief = useBrief();
</script>

<div class="w c-violet" data-testid="brief-one-thing">
  <div class="eyebrow">If you do one thing</div>
  <div class="q">{decision.title}.{#if decision.detail?.unlocks.length} It unlocks {decision.detail.unlocks.length} more.{/if}</div>
  <div class="why">
    {#each decision.detail?.unlocks ?? [] as u (u.label)}<span class="tag">{u.label}</span>{/each}
    {#if prompt && !brief.cleared[decision.id]}<span class="go"><BriefLaunch id={decision.id} {prompt} compact /></span>{/if}
  </div>
</div>

<style>
  .q {
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.15;
    margin-top: 10px;
  }
  .why {
    display: flex;
    gap: 8px;
    margin-top: auto;
    flex-wrap: wrap;
    align-items: center;
  }
  .tag {
    font-family: var(--b-mono);
    font-size: 10px;
    padding: 5px 8px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.14);
  }
  .go {
    margin-left: auto;
  }
</style>
