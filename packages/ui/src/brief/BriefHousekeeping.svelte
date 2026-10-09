<script lang="ts">
  /**
   * Housekeeping: what the run cleaned up by itself, and the cleanups it
   * proposes. Proposals are never run here; each one launches its prompt in a
   * session through the brief's launch seam, where the person confirms it.
   */
  import { ENGINES, useBrief } from "./brief-context.svelte.js";
  import type { BriefHousekeeping } from "./brief-run-files.js";

  let { housekeeping }: { housekeeping: BriefHousekeeping } = $props();
  const brief = useBrief();
  const failed = $derived(housekeeping.tasks.filter((t) => !t.ok));
  const engineLabel = $derived(ENGINES.find((e) => e.id === brief.engine)?.label ?? "Claude");
</script>

<section class="w hk" data-testid="brief-housekeeping" aria-label="Housekeeping">
  <div class="eyebrow">Housekeeping</div>
  {#if housekeeping.tasks.length}
    <p class="tasks" data-testid="brief-housekeeping-tasks">
      {housekeeping.tasks.length - failed.length} of {housekeeping.tasks.length} checks ran clean{#if failed.length}. Did not finish: {failed.map((t) => t.name).join(", ")}{/if}.
    </p>
  {/if}
  {#if housekeeping.proposals.length}
    <ul class="props">
      {#each housekeeping.proposals as p (p.id)}
        <li data-testid="brief-housekeeping-proposal">
          <div class="txt">
            <div class="title">{p.title}</div>
            {#if p.frees || p.risk}
              <div class="meta">{p.frees}{p.frees && p.risk ? " · " : ""}{#if p.risk}Risk: {p.risk}{/if}</div>
            {/if}
            {#if brief.notes[p.id]}<div class="note">{brief.notes[p.id]}</div>{/if}
          </div>
          <button
            type="button"
            class="go"
            disabled={brief.cleared[p.id]}
            onclick={() => void brief.start(p.id, p.prompt)}
            data-testid="brief-housekeeping-launch"
          >{brief.cleared[p.id] ? "Started" : `Start in ${engineLabel}`}</button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="tasks">Nothing to clean up.</p>
  {/if}
</section>

<style>
  .hk {
    margin-top: var(--b-gap);
  }
  .tasks {
    margin: 8px 0 0;
    color: var(--b-t2);
    font-size: 13px;
  }
  .props {
    list-style: none;
    margin: 10px 0 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }
  li {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-radius: 12px;
    box-shadow: var(--b-well);
  }
  .txt {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 13px;
    color: var(--b-t1);
  }
  .meta,
  .note {
    font-size: 13px;
    color: var(--b-t3);
    margin-top: 2px;
  }
  .go {
    flex: none;
    font: inherit;
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 0;
    color: var(--b-t1);
    background: var(--b-card-hi);
    box-shadow: var(--b-raise);
    cursor: pointer;
  }
  .go:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
