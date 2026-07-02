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
  <!-- Titlebar drag strip — the only draggable region on the frameless window. -->
  <div class="wizard-titlebar" data-tauri-drag-region></div>

  <div class="wizard-body">
    <!-- Left rail — vertical numbered step nav, mirroring the hq-installer
         ProgressIndicator sidebar. -->
    <nav class="wizard-rail" aria-label="Onboarding progress">
      <ol class="rail-steps">
        {#each steps as step}
          <li
            class="rail-step"
            class:done={step.index < currentStep}
            class:current={step.index === currentStep}
            class:upcoming={step.index > currentStep}
            aria-current={step.index === currentStep ? 'step' : undefined}
          >
            <span class="rail-index">{step.index}</span>
            <span class="rail-label">{step.label}</span>
            {#if step.index < currentStep}
              <svg class="rail-check" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="2.5,6.5 5,9 9.5,3.5" />
              </svg>
            {/if}
          </li>
        {/each}
      </ol>
    </nav>

    <!-- Content + glass footer -->
    <main class="wizard-main">
      <div class="wizard-content">
        <div class="wizard-content-inner">
          {@render children?.()}
        </div>
      </div>

      {#if showFooter}
        <footer class="wizard-footer">
          <button
            type="button"
            class="pill-button secondary"
            disabled={!canBack}
            onclick={onback}
          >
            Back
          </button>
          <button
            type="button"
            class="pill-button primary"
            disabled={!canNext}
            onclick={onnext}
          >
            {nextLabel}
          </button>
        </footer>
      {/if}
    </main>
  </div>
</section>

<style>
  .wizard-shell {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .wizard-titlebar {
    flex: 0 0 auto;
    height: 34px;
    width: 100%;
  }

  .wizard-body {
    flex: 1 1 auto;
    display: flex;
    min-width: 0;
    min-height: 0;
  }

  /* ── Left step rail ─────────────────────────────────────────────────── */
  .wizard-rail {
    flex: 0 0 216px;
    box-sizing: border-box;
    padding: 8px 20px 24px;
    border-right: 1px solid var(--popover-divider);
    background: rgba(0, 0, 0, 0.28);
  }

  .rail-steps {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .rail-step {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) 14px;
    align-items: center;
    gap: 10px;
    min-height: 30px;
    padding: 4px 8px 4px 6px;
    border-left: 2px solid transparent;
    color: rgba(255, 255, 255, 0.34);
    font-size: 12px;
    font-weight: 300;
    line-height: 1.2;
  }

  .rail-index {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .rail-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .rail-check {
    width: 12px;
    height: 12px;
    opacity: 0.7;
  }

  .rail-step.done {
    color: rgba(255, 255, 255, 0.75);
  }

  .rail-step.current {
    border-left-color: #ffffff;
    color: #ffffff;
    font-weight: 500;
  }

  /* ── Content + footer ──────────────────────────────────────────────── */
  .wizard-main {
    position: relative;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: rgba(255, 255, 255, 0.015);
  }

  .wizard-content {
    flex: 1 1 auto;
    overflow: auto;
    padding: 40px 44px 104px;
  }

  .wizard-content-inner {
    width: 100%;
    max-width: 560px;
  }

  .wizard-footer {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding: 18px 44px;
    background: rgba(255, 255, 255, 0.04);
    border-top: 1px solid var(--popover-divider);
    backdrop-filter: blur(20px) saturate(1.4);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
  }

  /* ── Pill buttons (hq-installer style) ─────────────────────────────── */
  .pill-button {
    appearance: none;
    min-width: 92px;
    min-height: 36px;
    padding: 0 20px;
    border-radius: 999px;
    font: inherit;
    font-size: 13px;
    font-weight: 550;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      color 0.12s ease,
      opacity 0.12s ease;
  }

  .pill-button:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  .pill-button.secondary {
    border: 1px solid var(--popover-border);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.86);
  }

  .pill-button.secondary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.12);
  }

  .pill-button.primary {
    border: 1px solid #ffffff;
    background: #ffffff;
    color: #09090b;
  }

  .pill-button.primary:hover:not(:disabled) {
    background: #f4f4f5;
  }

  @media (max-width: 720px) {
    .wizard-rail {
      flex-basis: 168px;
      padding: 8px 12px 20px;
    }

    .wizard-content {
      padding: 28px 24px 96px;
    }

    .wizard-footer {
      padding: 16px 24px;
    }
  }
</style>
