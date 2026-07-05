<script lang="ts">
  import * as Sentry from '@sentry/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import type { Component } from 'svelte';
  import type { InstallManifest } from '../lib/onboarding-setup';

  interface Props {
    component: Component<any>;
    windowLabel?: string;
  }

  let { component: RootComponent, windowLabel = 'main' }: Props = $props();

  let boundaryError = $state<unknown>(null);
  let recoveredPath = $state<string | null>(null);
  let revealError = $state<string | null>(null);
  let recoveringPath = false;

  function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  async function recoverInstallPath(): Promise<void> {
    if (recoveringPath || recoveredPath) return;
    recoveringPath = true;
    try {
      const manifest = await invoke<InstallManifest>('read_install_manifest');
      if (manifest.installPath) {
        recoveredPath = manifest.installPath;
        recoveringPath = false;
        return;
      }
    } catch {
      // best effort only
    }

    try {
      const path = await invoke<string>('resolve_hq_path');
      if (path) recoveredPath = path;
    } catch {
      // best effort only
    } finally {
      recoveringPath = false;
    }
  }

  function handleBoundaryError(error: unknown, reset: () => void): void {
    void reset;
    boundaryError = error;
    console.error('[GlobalErrorBoundary]', error);
    Sentry.withScope((scope) => {
      scope.setTag('window_label', windowLabel);
      Sentry.captureException(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    });
    void recoverInstallPath();
  }

  function handleStartOver(reset?: () => void): void {
    void reset;
    window.location.reload();
  }

  async function handleRevealFolder(): Promise<void> {
    if (!recoveredPath) return;
    revealError = null;
    try {
      await invoke('reveal_folder', { path: recoveredPath });
    } catch (error) {
      revealError = errorMessage(error);
    }
  }
</script>

<svelte:boundary onerror={handleBoundaryError} failed={renderFailure}>
  <RootComponent />
</svelte:boundary>

{#snippet renderFailure(error: unknown, reset: () => void)}
  <main class="error-shell" data-window={windowLabel}>
    <section class="error-card" role="alert" aria-labelledby="global-error-title">
      <div>
        <h1 id="global-error-title">Something went wrong</h1>
        <p>HQ hit an unexpected error. Your files may still be on disk.</p>
      </div>

      <div class="error-detail">
        <span>Error</span>
        <p>{errorMessage(boundaryError ?? error)}</p>
      </div>

      {#if recoveredPath}
        <div class="error-detail">
          <span>Recovered HQ path</span>
          <p class="path">{recoveredPath}</p>
        </div>
      {/if}

      {#if revealError}
        <p class="reveal-error">Could not reveal folder: {revealError}</p>
      {/if}

      <div class="actions">
        <button type="button" class="primary" onclick={() => handleStartOver(reset)}>Start over</button>
        {#if recoveredPath}
          <button type="button" onclick={handleRevealFolder}>Reveal HQ folder</button>
        {/if}
      </div>
    </section>
  </main>
{/snippet}

<style>
  .error-shell {
    box-sizing: border-box;
    min-height: 100vh;
    width: 100vw;
    display: grid;
    place-items: center;
    padding: 24px;
    background: #09090b;
    color: #fafafa;
    font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
  }

  .error-shell *,
  .error-shell *::before,
  .error-shell *::after {
    box-sizing: border-box;
  }

  .error-card {
    width: min(520px, 100%);
    display: flex;
    flex-direction: column;
    gap: 18px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.06);
    padding: 22px;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
  }

  h1 {
    margin: 0;
    color: #ffffff;
    font-size: 24px;
    font-weight: 600;
    line-height: 32px;
    letter-spacing: 0;
  }

  p {
    margin: 6px 0 0;
    color: #d4d4d8;
    font-size: 14px;
    line-height: 20px;
  }

  .error-detail {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.26);
    padding: 10px 12px;
  }

  .error-detail span {
    display: block;
    color: #a1a1aa;
    font-size: 12px;
    line-height: 16px;
  }

  .error-detail p {
    margin-top: 4px;
    overflow-wrap: anywhere;
    color: #f4f4f5;
  }

  .error-detail .path {
    font-family: ui-monospace, 'SF Mono', Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
    line-height: 17px;
    user-select: all;
  }

  .reveal-error {
    color: #fca5a5;
    font-size: 12px;
    line-height: 16px;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  button {
    appearance: none;
    border: 0;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.12);
    color: #f4f4f5;
    cursor: pointer;
    font: inherit;
    font-size: 14px;
    line-height: 20px;
    padding: 9px 14px;
  }

  button.primary {
    background: #ffffff;
    color: #09090b;
  }

  button:hover {
    filter: brightness(1.08);
  }

  button:focus-visible {
    outline: 2px solid #ffffff;
    outline-offset: 2px;
  }
</style>
