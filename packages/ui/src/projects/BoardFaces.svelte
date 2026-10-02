<script lang="ts">
  /** Stacked faces: circles for humans, rounded squares for bots (US-023). */
  import type { BoardFace } from "./board-faces.js";

  let { faces }: { faces: readonly BoardFace[] } = $props();
</script>

{#if faces.length > 0}
  <span
    class="faces"
    data-testid="board-faces"
    aria-label={faces.map((f) => `${f.label} (${f.kind === "bot" ? "bot" : "person"})`).join(", ")}
  >
    {#each faces as face, index (`${face.kind}-${face.label}-${index}`)}
      <span
        class="mini"
        class:sq={face.kind === "bot"}
        data-kind={face.kind}
        title={face.label}
        aria-hidden="true">{face.mark}</span
      >
    {/each}
  </span>
{/if}

<style>
  .faces {
    display: inline-flex;
    flex: none;
    align-items: center;
  }
  .mini {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1.5px solid var(--v4-ground);
    background: var(--v4-control-border);
    color: var(--v4-text-2);
    font-size: 8px;
    font-weight: 600;
    line-height: 1;
  }
  .mini + .mini {
    margin-left: -5px;
  }
  .mini.sq {
    border-radius: 5px;
  }
</style>
