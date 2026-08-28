<script lang="ts">
  /**
   * Compact "desktop view moved" overlay. Ghost layout: typography, spacing,
   * and opacity — no rounded/filled/bordered card chrome. CTA buttons may be
   * filled and rounded.
   */
  import { invoke } from '@tauri-apps/api/core';
  import {
    installHqWork,
    launchHqWork,
    type HqWorkInvoker,
  } from '../lib/hq-work';

  interface Props {
    firstShow?: boolean;
    invokeFn?: HqWorkInvoker;
  }

  let {
    firstShow = true,
    invokeFn = invoke as HqWorkInvoker,
  }: Props = $props();

  let installed = $state(false);
  let installing = $state(false);
  let error = $state<string | null>(null);

  function errorMessage(err: unknown): string {
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.message;
    return String(err);
  }

  async function onInstall() {
    if (installing) return;
    installing = true;
    error = null;
    try {
      await installHqWork(invokeFn);
      installed = true;
    } catch (err) {
      error = errorMessage(err);
    } finally {
      installing = false;
    }
  }

  async function onOpen() {
    error = null;
    try {
      await launchHqWork(invokeFn, null);
    } catch (err) {
      error = errorMessage(err);
    }
  }
</script>

<section
  class="handoff"
  class:emphasis={firstShow}
  data-testid="hq-work-handoff-card"
  aria-label="The HQ desktop view moved"
>
  <h2 class="title">The HQ desktop view moved</h2>
  <p class="body">
    HQ Work is the desktop app now. Install it to open the desktop view from
    here.
  </p>
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  <div class="actions">
    {#if installed}
      <button
        type="button"
        class="cta"
        data-testid="hq-work-handoff-open"
        onclick={() => void onOpen()}
      >
        Open
      </button>
    {:else}
      <button
        type="button"
        class="cta"
        data-testid="hq-work-handoff-install"
        disabled={installing}
        aria-busy={installing}
        onclick={() => void onInstall()}
      >
        {installing ? 'Installing…' : 'Install'}
      </button>
    {/if}
  </div>
</section>

<style>
  /* Ghost layout: padding only. No radius + fill + border combo on this wrapper. */
  .handoff {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px 16px 18px;
    box-sizing: border-box;
    min-height: 100%;
  }

  .title {
    margin: 0;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--pop-text, var(--fg, #111));
  }

  .handoff.emphasis .title {
    font-weight: 720;
  }

  .body {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--pop-muted, var(--muted-2, rgba(0, 0, 0, 0.55)));
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: var(--popover-danger, #dc2626);
  }

  .actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }

  .cta {
    padding: 8px 14px;
    border: 0;
    border-radius: 8px;
    background: var(--pop-text, #111);
    color: var(--pop-bg, #fff);
    font: inherit;
    font-size: 13px;
    font-weight: 650;
    cursor: pointer;
  }

  .cta:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .cta:focus-visible {
    outline: 2px solid var(--pop-accent, #0a84ff);
    outline-offset: 2px;
  }
</style>
