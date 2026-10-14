<script lang="ts">
  import ReadLoader from "./ReadLoader.svelte";

  interface Props {
    label: string;
    value: string | number;
    hint?: string | null;
    loading?: boolean;
  }

  let { label, value, hint = null, loading = false }: Props = $props();
</script>

<article class="stat-tile" aria-busy={loading}>
  {#if loading}
    <span class="stat-label">{label}</span>
    <ReadLoader testid="stat-tile-loading" />
  {:else}
    <span class="stat-label">{label}</span>
    <strong>{value}</strong>
    {#if hint}
      <span class="stat-hint">{hint}</span>
    {/if}
  {/if}
</article>

<style>
  .stat-tile {
    display: grid;
    align-content: start;
    gap: var(--space-1);
    min-width: 0;
    padding: var(--space-3) var(--space-3) calc(var(--space-3) - 1px);
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .stat-label,
  .stat-hint {
    min-width: 0;
    overflow: hidden;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0.06em;
    line-height: 14px;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }

  strong {
    min-width: 0;
    overflow: hidden;
    color: var(--fg);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat-hint {
    font-weight: 600;
  }

</style>
