<script lang="ts">
  import { DEFAULT_SKELETON_DELAY_MS } from '../lib/load-state';

  interface Props {
    rows?: number;
    avatar?: boolean;
    label?: string;
    delayMs?: number;
  }

  let {
    rows = 3,
    avatar = true,
    label = 'Loading',
    delayMs = DEFAULT_SKELETON_DELAY_MS,
  }: Props = $props();

  let visible = $state(false);

  $effect(() => {
    visible = false;
    const timeout = setTimeout(() => {
      visible = true;
    }, delayMs);
    return () => clearTimeout(timeout);
  });
</script>

{#if visible}
  <div class="row-skel" role="status" aria-label={label}>
    {#each Array(rows) as _, i (i)}
      <div class="row-skel-row" aria-hidden="true">
        {#if avatar}
          <span class="row-skel-avatar"></span>
        {/if}
        <span class="row-skel-bars">
          <span class="row-skel-bar" style={`width: ${72 - (i % 4) * 8}%`}></span>
          <span class="row-skel-bar" style={`width: ${46 - (i % 4) * 6}%`}></span>
        </span>
      </div>
    {/each}
  </div>
{/if}

<style>
  .row-skel {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
  }

  .row-skel-row {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    animation: row-skel-shimmer 1.2s ease-in-out infinite;
  }

  .row-skel-avatar {
    flex: 0 0 20px;
    width: 20px;
    height: 20px;
    border-radius: 999px;
    background: var(--v4-control-faint);
  }

  .row-skel-bars {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--v4-space-1);
    min-width: 0;
  }

  .row-skel-bar {
    display: block;
    height: 8px;
    border-radius: var(--v4-radius-button);
    background: var(--v4-inset);
  }

  @keyframes row-skel-shimmer {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .row-skel-row {
      animation: none;
    }
  }
</style>
