<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onMount } from 'svelte';
  import { friendlyPath, homeDirFromDefaultHqPath } from '../../lib/onboarding-path';

  interface Props {
    installPath: string | null;
    oninstallpathchange?: (path: string | null) => void;
  }

  interface DetectHqResult {
    exists?: boolean;
    looksLikeHq?: boolean;
    looks_like_hq?: boolean;
    isHq?: boolean;
    is_hq?: boolean;
    nonEmpty?: boolean;
    non_empty?: boolean;
  }

  type Notice = {
    tone: 'error' | 'warning';
    text: string;
  };

  let { installPath, oninstallpathchange }: Props = $props();

  let resolvedPath = $state<string | null>(null);
  let homeDir = $state<string | null>(null);
  let notice = $state<Notice | null>(null);
  let busy = $state(false);

  const displayPath = $derived(
    resolvedPath ? friendlyPath(resolvedPath, homeDir) : 'Resolving ~/hq...',
  );
  const buttonLabel = $derived(busy ? 'Checking...' : 'Change…');

  $effect(() => {
    if (!installPath || resolvedPath) return;
    resolvedPath = installPath;
    homeDir = homeDirFromDefaultHqPath(installPath);
  });

  function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }

  async function invokeCommand<T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> {
    if (typeof invoke !== 'function') {
      throw new Error('The desktop bridge is not available in this environment.');
    }
    return invoke<T>(command, args);
  }

  function detectLooksLikeHq(result: DetectHqResult): boolean {
    return Boolean(result.looksLikeHq ?? result.looks_like_hq ?? result.isHq ?? result.is_hq);
  }

  function detectNonEmpty(result: DetectHqResult): boolean {
    return Boolean(result.nonEmpty ?? result.non_empty);
  }

  function acceptPath(path: string) {
    resolvedPath = path;
    homeDir = homeDir ?? homeDirFromDefaultHqPath(path);
    notice = null;
    oninstallpathchange?.(path);
  }

  function rejectPath(text: string, tone: Notice['tone'] = 'error') {
    notice = { tone, text };
  }

  onMount(() => {
    let cancelled = false;

    async function resolveDefaultPath() {
      busy = true;
      notice = null;
      try {
        const path = await invokeCommand<string>('resolve_hq_path');
        if (cancelled) return;
        homeDir = homeDirFromDefaultHqPath(path);
        acceptPath(path);
      } catch (err) {
        if (cancelled) return;
        resolvedPath = null;
        oninstallpathchange?.(null);
        rejectPath(`HQ could not prepare ~/hq. ${errorMessage(err)}`);
      } finally {
        if (!cancelled) busy = false;
      }
    }

    void resolveDefaultPath();

    return () => {
      cancelled = true;
    };
  });

  async function chooseFolder() {
    busy = true;
    notice = null;

    try {
      const picked = await invokeCommand<string | null>('pick_folder');
      if (!picked) return;

      const [detection, writable] = await Promise.all([
        invokeCommand<DetectHqResult>('detect_hq', { path: picked }),
        invokeCommand<boolean>('check_writable', { path: picked }),
      ]);

      if (!writable) {
        rejectPath(`${friendlyPath(picked, homeDir)} is not writable. Choose another folder.`);
        return;
      }

      if (detection.exists && !detectLooksLikeHq(detection) && detectNonEmpty(detection)) {
        rejectPath(
          `${friendlyPath(picked, homeDir)} already has files and does not look like an HQ folder.`,
          'warning',
        );
        return;
      }

      acceptPath(picked);
    } catch (err) {
      rejectPath(`The folder could not be checked. ${errorMessage(err)}`);
    } finally {
      busy = false;
    }
  }
</script>

<div class="directory-screen" data-testid="onboarding-directory">
  <div class="directory-copy">
    <h1>Where should HQ live?</h1>
    <p>HQ uses ~/hq by default. Choose a different folder if you keep your work somewhere else.</p>
  </div>

  <div class="path-row">
    <div class="path-meta">
      <span class="path-label">Install location</span>
      <span class="path-value" title={resolvedPath ?? undefined}>{displayPath}</span>
    </div>
    <button type="button" disabled={busy} onclick={chooseFolder}>{buttonLabel}</button>
  </div>

  {#if notice}
    <p class:error={notice.tone === 'error'} class:warning={notice.tone === 'warning'} class="notice" role="status">
      {notice.text}
    </p>
  {/if}
</div>

<style>
  .directory-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-5, 20px);
    width: 100%;
    max-width: 500px;
  }

  .directory-copy {
    display: flex;
    flex-direction: column;
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

  .path-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3, 12px);
    min-width: 0;
    padding: var(--space-4, 16px);
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-md, 10px);
    background: var(--popover-surface, rgba(255, 255, 255, 0.08));
  }

  .path-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1, 4px);
    min-width: 0;
  }

  .path-label {
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    line-height: 1.25;
  }

  .path-value {
    min-width: 0;
    overflow: hidden;
    color: var(--popover-text-heading, #ffffff);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace);
    font-size: var(--text-base, 13px);
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  button {
    appearance: none;
    min-width: 88px;
    min-height: 34px;
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.18));
    border-radius: var(--radius-sm, 8px);
    background: transparent;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font: inherit;
    font-size: var(--text-sm, 13px);
    font-weight: 650;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      opacity 0.12s ease;
  }

  button:hover:not(:disabled) {
    background: var(--popover-action-hover, rgba(255, 255, 255, 0.1));
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .notice {
    padding: var(--space-3, 12px);
    border: 1px solid var(--popover-notice-border, rgba(255, 255, 255, 0.16));
    border-radius: var(--radius-sm, 8px);
    background: var(--popover-notice-bg, rgba(255, 255, 255, 0.05));
    color: var(--popover-notice, rgba(255, 255, 255, 0.65));
  }

  .notice.error {
    border-color: color-mix(in srgb, var(--popover-danger, #ef4444) 42%, transparent);
    color: var(--popover-danger, #ef4444);
  }

  .notice.warning {
    color: var(--popover-notice-strong, #ffffff);
  }

  @media (max-width: 520px) {
    .path-row {
      grid-template-columns: 1fr;
      align-items: stretch;
    }

    button {
      width: 100%;
    }
  }
</style>
