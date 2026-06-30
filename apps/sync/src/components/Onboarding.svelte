<script lang="ts">
  import {
    onboardingHeadline,
    type LifecycleState,
  } from '../lib/lifecycle';

  let { state }: { state: LifecycleState | string } = $props();
</script>

<div class="onboarding-stub" data-testid="onboarding-stub">
  <section class="onboarding-panel">
    <div class="onboarding-mark">HQ</div>
    <h1>{onboardingHeadline(state)}</h1>
    <p class="subtitle">We are preparing this device for your HQ workspace.</p>
    <p class="note">Onboarding wizard coming soon.</p>
  </section>
</div>

<style>
  .onboarding-stub {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100vw;
    height: 100vh;
    box-sizing: border-box;
    padding: var(--space-4, 16px);
    background: var(--popover-bg, rgba(18, 18, 20, 0.68));
    backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    -webkit-backdrop-filter: var(--popover-blur, blur(28px) saturate(1.45));
    color: var(--popover-text, #e0e0e0);
    overflow: hidden;
    border-radius: var(--radius-xl, 18px);
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    box-shadow: inset 0 1px 0 var(--popover-highlight, rgba(255, 255, 255, 0.34));
  }

  .onboarding-panel {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 300px;
    text-align: center;
  }

  .onboarding-mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: var(--space-4, 16px);
    border-radius: var(--radius-md, 10px);
    background: var(--popover-surface-strong, rgba(255, 255, 255, 0.16));
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    color: var(--popover-text-heading, #ffffff);
    font-size: var(--text-sm, 13px);
    font-weight: 700;
  }

  h1 {
    margin: 0;
    color: var(--popover-text-heading, #ffffff);
    font-size: var(--text-lg, 18px);
    font-weight: 650;
    line-height: 1.25;
  }

  .subtitle {
    margin: var(--space-2, 8px) 0 0;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-base, 13px);
    line-height: 1.45;
  }

  .note {
    margin: var(--space-4, 16px) 0 0;
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-sm, 13px);
    line-height: 1.4;
  }
</style>
