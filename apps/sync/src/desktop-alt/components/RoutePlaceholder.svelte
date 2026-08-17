<script lang="ts">
  interface Props {
    label: string;
    error?: unknown;
    onretry?: () => void;
  }

  let { label, error = null, onretry }: Props = $props();
</script>

{#if error}
  <section class="route-state route-error" role="alert" aria-live="assertive">
    <span class="route-state-dot" aria-hidden="true"></span>
    <h1>{label} didn’t load</h1>
    <p>Your HQ data is safe. Retry the view or reopen the desktop window.</p>
    {#if onretry}
      <button type="button" onclick={onretry}>Retry</button>
    {/if}
  </section>
{:else}
  <section class="route-state route-loading" aria-label={`Loading ${label}`} aria-busy="true">
    <span class="route-skeleton wide"></span>
    <span class="route-skeleton"></span>
    <span class="route-skeleton short"></span>
  </section>
{/if}

<style>
  .route-state {
    display: grid;
    align-content: start;
    gap: 10px;
    min-height: 180px;
    padding: 18px 0;
  }

  .route-loading {
    width: min(620px, 100%);
  }

  .route-skeleton {
    display: block;
    width: 72%;
    height: 12px;
    border-radius: var(--v4-radius-pill);
    background: var(--v4-control-faint);
    animation: route-pulse 1.1s ease-in-out infinite;
  }

  .route-skeleton.wide { width: 100%; height: 84px; border-radius: var(--v4-radius-card); }
  .route-skeleton.short { width: 44%; }

  .route-error {
    justify-items: start;
    width: min(460px, 100%);
  }

  .route-state-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--v4-error);
  }

  .route-error h1,
  .route-error p { margin: 0; }
  .route-error h1 { color: var(--v4-text-1); font-size: var(--text-lg); font-weight: 500; }
  .route-error p { color: var(--v4-text-2); font-size: var(--text-base); line-height: 1.5; }

  .route-error button {
    height: 30px;
    padding: 0 12px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font: inherit;
    font-size: var(--text-base);
    font-weight: 500;
    cursor: pointer;
  }

  @keyframes route-pulse { 50% { opacity: 0.48; } }
  @media (prefers-reduced-motion: reduce) { .route-skeleton { animation: none; } }
</style>
