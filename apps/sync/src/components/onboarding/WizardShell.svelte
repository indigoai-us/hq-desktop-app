<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { WizardStep } from '../../lib/onboarding-wizard';

  interface Props {
    currentStep: number;
    steps: WizardStep[];
    canBack: boolean;
    canNext: boolean;
    nextLabel?: string;
    showFooter?: boolean;
    onback?: () => void;
    onnext?: () => void;
    children?: Snippet;
  }

  let {
    currentStep,
    steps,
    canBack,
    canNext,
    nextLabel = 'Continue',
    showFooter = true,
    onback,
    onnext,
    children,
  }: Props = $props();
</script>

<section class="wizard-shell" aria-label="HQ onboarding">
  <nav class="wizard-steps" aria-label="Onboarding progress">
    {#each steps as step}
      <div
        class="wizard-step"
        class:done={step.index < currentStep}
        class:current={step.index === currentStep}
        class:upcoming={step.index > currentStep}
        aria-current={step.index === currentStep ? 'step' : undefined}
      >
        <span class="step-index">{step.index}</span>
        <span class="step-label">{step.label}</span>
      </div>
    {/each}
  </nav>

  <div class="wizard-body">
    <main class="wizard-content">
      {@render children?.()}
    </main>

    {#if showFooter}
      <footer class="wizard-footer">
        <button
          type="button"
          class="secondary-button"
          disabled={!canBack}
          onclick={onback}
        >
          Back
        </button>
        <button
          type="button"
          class="primary-button"
          disabled={!canNext}
          onclick={onnext}
        >
          {nextLabel}
        </button>
      </footer>
    {/if}
  </div>
</section>

<style>
  .wizard-shell {
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr);
    width: min(720px, calc(100vw - var(--space-8, 32px)));
    min-height: 420px;
    overflow: hidden;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-xl, 18px);
    background: var(--popover-surface, rgba(255, 255, 255, 0.08));
    box-shadow:
      inset 0 1px 0 var(--popover-highlight, rgba(255, 255, 255, 0.34)),
      0 24px 70px rgba(0, 0, 0, 0.28);
  }

  .wizard-steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding: var(--space-5, 20px) var(--space-4, 16px);
    border-right: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.11));
    background: rgba(255, 255, 255, 0.04);
  }

  .wizard-step {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    align-items: center;
    gap: var(--space-2, 8px);
    min-height: 32px;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-sm, 13px);
    line-height: 1.2;
  }

  .step-index {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: 999px;
    background: transparent;
    font-size: var(--text-xs, 13px);
    font-weight: 650;
  }

  .step-label {
    min-width: 0;
    overflow-wrap: anywhere;
    font-weight: 550;
  }

  .wizard-step.done,
  .wizard-step.current {
    color: var(--popover-text-heading, #ffffff);
  }

  .wizard-step.done .step-index {
    background: var(--popover-surface-strong, rgba(255, 255, 255, 0.16));
  }

  .wizard-step.current .step-index {
    background: var(--popover-primary, #ffffff);
    border-color: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
  }

  .wizard-step.upcoming {
    opacity: 0.72;
  }

  .wizard-body {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
  }

  .wizard-content {
    display: flex;
    align-items: center;
    min-width: 0;
    padding: var(--space-6, 24px);
  }

  .wizard-footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2, 8px);
    padding: var(--space-4, 16px) var(--space-6, 24px);
    border-top: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.11));
  }

  button {
    appearance: none;
    min-width: 84px;
    min-height: 34px;
    border-radius: var(--radius-sm, 8px);
    font: inherit;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      color 0.12s ease,
      opacity 0.12s ease;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .secondary-button {
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    background: transparent;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
  }

  .secondary-button:hover:not(:disabled) {
    background: var(--popover-action-hover, rgba(255, 255, 255, 0.1));
  }

  .primary-button {
    border: 1px solid var(--popover-primary, #ffffff);
    background: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
  }

  .primary-button:hover:not(:disabled) {
    background: var(--popover-primary-hover, rgba(255, 255, 255, 0.9));
  }

  @media (max-width: 640px) {
    .wizard-shell {
      grid-template-columns: 1fr;
      width: 100%;
      min-height: min(560px, calc(100vh - var(--space-8, 32px)));
    }

    .wizard-steps {
      flex-direction: row;
      overflow-x: auto;
      padding: var(--space-4, 16px);
      border-right: 0;
      border-bottom: 1px solid var(--popover-divider, rgba(255, 255, 255, 0.11));
    }

    .wizard-step {
      grid-template-columns: 22px auto;
      flex: 0 0 auto;
    }

    .wizard-content {
      padding: var(--space-5, 20px);
    }

    .wizard-footer {
      padding: var(--space-4, 16px) var(--space-5, 20px);
    }
  }
</style>
