<script lang="ts">
  import type { FailedStageDetail } from '../../lib/onboarding-setup';
  import { friendlyPath, homeDirFromDefaultHqPath } from '../../lib/onboarding-path';

  interface Props {
    installPath: string | null;
    failedStages?: FailedStageDetail[];
    onfinish?: () => void;
  }

  let { installPath, failedStages = [], onfinish }: Props = $props();

  const displayPath = $derived(
    installPath ? friendlyPath(installPath, homeDirFromDefaultHqPath(installPath)) : null,
  );
  const needsAttention = $derived(failedStages.length > 0);
</script>

<div class="summary-screen" data-testid="onboarding-summary">
  <div class:success-mark={!needsAttention} class:attention-mark={needsAttention} aria-hidden="true">
    {#if needsAttention}
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M12 7v6" />
        <path d="M12 17.5h.01" />
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" focusable="false">
        <path d="M5 12.5 10 17l9-10" />
      </svg>
    {/if}
  </div>

  <div class="summary-copy">
    <h1>{needsAttention ? 'HQ needs attention' : "You're all set"}</h1>
    <p>
      {#if displayPath}HQ is installed at <span class="path-value">{displayPath}</span>.{:else}HQ is installed.{/if}
    </p>
    <p class="muted">HQ runs in your menu bar.</p>
  </div>

  {#if needsAttention}
    <section class="attention-card" aria-label="Needs attention">
      <h2>Needs attention</h2>
      <ul>
        {#each failedStages as stage}
          <li>
            <strong>{stage.label}</strong>
            <span>{stage.message}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <button type="button" onclick={() => onfinish?.()}>Open HQ</button>
</div>

<style>
  .summary-screen {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-5, 20px);
    width: 100%;
    max-width: 460px;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
  }

  .success-mark {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border: 1px solid rgba(125, 211, 168, 0.55);
    border-radius: 999px;
    background: rgba(125, 211, 168, 0.14);
    color: #9ae6b9;
    box-shadow: 0 0 0 6px rgba(125, 211, 168, 0.08);
  }

  .attention-mark {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border: 1px solid rgba(245, 196, 107, 0.58);
    border-radius: 999px;
    background: rgba(245, 196, 107, 0.14);
    color: #f7d38b;
    box-shadow: 0 0 0 6px rgba(245, 196, 107, 0.08);
  }

  svg {
    width: 28px;
    height: 28px;
  }

  path {
    fill: none;
    stroke: currentColor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .summary-copy {
    display: grid;
    gap: var(--space-3, 12px);
  }

  h1 {
    margin: 0;
    color: var(--popover-text-heading, #ffffff);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
  }

  p {
    margin: 0;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-base, 13px);
    font-weight: 400;
    line-height: 1.6;
  }

  .muted {
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
  }

  .path-value {
    color: var(--popover-text-heading, #ffffff);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace);
    overflow-wrap: anywhere;
  }

  .attention-card {
    display: grid;
    gap: var(--space-3, 12px);
    width: 100%;
    padding: var(--space-4, 16px);
    border: 1px solid rgba(245, 196, 107, 0.34);
    border-radius: var(--radius-sm, 8px);
    background: rgba(245, 196, 107, 0.1);
  }

  h2 {
    margin: 0;
    color: #f7d38b;
    font-size: var(--text-sm, 13px);
    font-weight: 750;
    line-height: 1.25;
  }

  ul {
    display: grid;
    gap: var(--space-2, 8px);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

  strong {
    color: var(--popover-text-heading, #ffffff);
    font-size: var(--text-sm, 13px);
    line-height: 1.25;
  }

  li span {
    min-width: 0;
    color: rgba(255, 238, 204, 0.82);
    font-size: var(--text-xs, 12px);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  button {
    appearance: none;
    min-width: 116px;
    min-height: 36px;
    padding: 0 22px;
    border: 1px solid var(--popover-primary, #ffffff);
    border-radius: 999px;
    background: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
    font: inherit;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      opacity 0.12s ease;
  }

  button:hover {
    background: var(--popover-primary-hover, rgba(255, 255, 255, 0.9));
  }

  button:focus-visible {
    outline: 2px solid var(--popover-highlight, rgba(255, 255, 255, 0.34));
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    h1 {
      font-size: 24px;
    }
  }
</style>
