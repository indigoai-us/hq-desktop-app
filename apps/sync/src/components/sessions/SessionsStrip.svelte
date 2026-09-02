<script lang="ts">
  /**
   * The one piece of chrome the chat allows itself: a sub-40px strip.
   *
   * Left is a sidebar toggle (the session list is a DRAWER, not a permanent
   * column — a chat surface with a list glued to its side is the thing the
   * owner rejected). Centre names the session in the only two terms that
   * matter, company and model. Right is "+" for a new one, and a phase dot.
   *
   * Presentation-pure: props in, callbacks out.
   */
  interface Props {
    title: string;
    /** 'idle' | 'working' | 'needs you' | 'ended' — already humanised. */
    phaseLabel?: string;
    phase?: 'starting' | 'idle' | 'working' | 'needsYou' | 'ended';
    drawerOpen?: boolean;
    ontoggledrawer?: () => void;
    onnew?: () => void;
  }

  let {
    title,
    phaseLabel = '',
    phase = 'idle',
    drawerOpen = false,
    ontoggledrawer,
    onnew,
  }: Props = $props();
</script>

<header class="strip" data-testid="sessions-strip">
  <button
    type="button"
    class="strip-button"
    aria-label="Sessions"
    aria-expanded={drawerOpen}
    data-testid="sessions-drawer-toggle"
    onclick={() => ontoggledrawer?.()}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" stroke="currentColor" stroke-width="1.1" />
      <path d="M6 2.8v10.4" stroke="currentColor" stroke-width="1.1" />
    </svg>
  </button>

  <h2 class="strip-title" data-testid="sessions-strip-title">{title}</h2>

  <div class="strip-right">
    {#if phaseLabel}
      <span class="phase" data-testid="sessions-phase" data-phase={phase}>
        <span class="dot" class:pulse={phase === 'working'} aria-hidden="true"></span>
        {phaseLabel}
      </span>
    {/if}
    <button
      type="button"
      class="strip-button"
      aria-label="New session"
      data-testid="sessions-new"
      onclick={() => onnew?.()}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path d="M7 2.4v9.2M2.4 7h9.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      </svg>
    </button>
  </div>
</header>

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
    height: 36px;
    padding: 0 var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
    font-family: var(--font-sans);
  }

  .strip-title {
    flex: 1;
    min-width: 0;
    margin: 0;
    text-align: center;
    font-size: var(--type-metadata);
    font-weight: 500;
    color: var(--v4-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .strip-right {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
  }

  .strip-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }

  .strip-button:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .phase {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-3);
  }

  .phase[data-phase='working'] .dot,
  .phase[data-phase='needsYou'] .dot {
    background: var(--v4-text-1);
  }

  .dot.pulse {
    animation: phase-pulse 1.4s ease-in-out infinite;
  }

  @keyframes phase-pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.pulse {
      animation: none;
    }
  }
</style>
