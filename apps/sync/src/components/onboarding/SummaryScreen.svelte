<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { onMount } from 'svelte';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import type { FailedStageDetail } from '../../lib/onboarding-setup';
  import { friendlyPath, homeDirFromDefaultHqPath } from '../../lib/onboarding-path';
  import {
    NO_AI_TOOLS,
    cliTerminalLabel,
    markToolUnavailable,
    readyCommandFor,
    summaryLaunchState,
    type AiTools,
  } from '../../lib/onboarding-summary';

  const CLAUDE_DESKTOP_QUICKSTART_URL =
    'https://code.claude.com/docs/en/desktop-quickstart';
  const AI_TOOLS_POLL_MS = 3000;

  interface Props {
    installPath: string | null;
    failedStages?: FailedStageDetail[];
    onfinish?: () => void | Promise<void>;
  }

  let { installPath, failedStages = [], onfinish }: Props = $props();

  let aiTools = $state<AiTools | null>(null);
  let detectionFailed = $state(false);
  let probeInFlight = false;
  let detectorMounted = false;
  let launching = $state<'claude-desktop' | 'cli' | null>(null);
  let launchError = $state<string | null>(null);
  let revealError = $state<string | null>(null);
  let revealingFolder = $state(false);
  let commandCopied = $state(false);
  let pathCopied = $state(false);
  let importPromptCopied = $state(false);

  const displayPath = $derived(
    installPath ? friendlyPath(installPath, homeDirFromDefaultHqPath(installPath)) : '~/hq',
  );
  const needsAttention = $derived(failedStages.length > 0);
  const launchState = $derived(summaryLaunchState(aiTools));
  const manualCommand = $derived(readyCommandFor(installPath, aiTools));
  const canLaunchTerminal = $derived(Boolean(installPath));

  async function probeAiTools() {
    if (probeInFlight) return;
    probeInFlight = true;
    try {
      const tools = await invoke<AiTools>('detect_ai_tools');
      if (detectorMounted) {
        detectionFailed = false;
        aiTools = tools;
      }
    } catch {
      if (detectorMounted) {
        detectionFailed = true;
        aiTools = NO_AI_TOOLS;
      }
    } finally {
      probeInFlight = false;
    }
  }

  onMount(() => {
    detectorMounted = true;
    void probeAiTools();
    return () => {
      detectorMounted = false;
    };
  });

  $effect(() => {
    if (aiTools?.any !== false) return;
    const intervalId = window.setInterval(() => {
      void probeAiTools();
    }, AI_TOOLS_POLL_MS);
    return () => window.clearInterval(intervalId);
  });

  async function copyText(text: string, setCopied: (value: boolean) => void) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard failures are silent; the value stays visible and selectable.
    }
  }

  async function handleCopyCommand() {
    await copyText(manualCommand, (value) => (commandCopied = value));
  }

  async function handleCopyPath() {
    await copyText(installPath ?? '~/hq', (value) => (pathCopied = value));
  }

  async function handleCopyImportPrompt() {
    await copyText('/import-claude', (value) => (importPromptCopied = value));
  }

  async function handleRevealFolder() {
    launchError = null;
    revealError = null;
    revealingFolder = true;
    try {
      await invoke('reveal_folder', { path: installPath ?? '~/hq' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      revealError = `Could not reveal HQ folder: ${msg}`;
    } finally {
      revealingFolder = false;
    }
  }

  async function handleLaunchClaudeDesktop() {
    launchError = null;
    revealError = null;
    launching = 'claude-desktop';
    try {
      const url = buildClaudeCodeUrl({
        folder: installPath ?? '',
        prompt: '/setup',
      });
      await invoke('open_claude_code_link', { url });
      void onfinish?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      launchError = `Could not open Claude Desktop: ${msg}`;
      if (/Unable to find application|not installed/i.test(msg)) {
        aiTools = markToolUnavailable(aiTools, 'claude_desktop');
      }
    } finally {
      launching = null;
    }
  }

  async function handleLaunchCli() {
    if (launchState.kind !== 'cli' || !installPath) return;
    launchError = null;
    revealError = null;
    launching = 'cli';
    try {
      if (launchState.tool === 'claude') {
        await invoke('launch_claude_code', { path: installPath });
      } else {
        await invoke('launch_cli_in_terminal', {
          path: installPath,
          tool: launchState.tool,
        });
      }
      void onfinish?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      launchError = `Could not open Terminal: ${msg}`;
      const unavailableKey =
        launchState.tool === 'claude'
          ? 'claude_cli'
          : launchState.tool === 'codex'
            ? 'codex_cli'
            : 'grok_cli';
      aiTools = markToolUnavailable(aiTools, unavailableKey);
    } finally {
      launching = null;
    }
  }

  async function handleDownloadClaude() {
    launchError = null;
    revealError = null;
    try {
      await openExternal(CLAUDE_DESKTOP_QUICKSTART_URL);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      launchError = `Could not open download page: ${msg}`;
    }
  }

  function handlePrimaryAction() {
    if (launchState.kind === 'claude-desktop') {
      void handleLaunchClaudeDesktop();
    } else if (launchState.kind === 'cli') {
      void handleLaunchCli();
    } else if (launchState.kind === 'download') {
      void handleDownloadClaude();
    } else {
      void handleCopyCommand();
    }
  }
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
      HQ is installed at <span class="path-value">{displayPath}</span>.
    </p>
    <p class="muted">HQ runs in your menu bar and stays synced automatically.</p>
  </div>

  {#if needsAttention}
    <section class="attention-card" aria-label="Needs attention">
      <h2>Needs attention</h2>
      <p class="attention-intro">
        Setup reached Done, but these steps need another pass from inside HQ.
      </p>
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

  <section class="open-panel" aria-label="Open HQ">
    <div class="panel-heading">
      <h2>Open HQ</h2>
      {#if aiTools === null}
        <span class="status-pill">Checking tools</span>
      {:else if aiTools.any}
        <span class="status-pill ready">Tool found</span>
      {:else}
        <span class="status-pill">No tool found</span>
      {/if}
    </div>

    <div class="value-block">
      <span class="value-label">HQ folder</span>
      <div class="value-row">
        <span class="value-text">{displayPath}</span>
        <button type="button" class="small-button" onclick={handleCopyPath}>
          {pathCopied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>

    <div class="value-block">
      <span class="value-label">Ready command</span>
      <div class="value-row">
        <span class="value-text">{manualCommand}</span>
        <button type="button" class="small-button" onclick={handleCopyCommand}>
          {commandCopied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>

    <div class="panel-actions">
      <button
        type="button"
        class="primary-action"
        disabled={launching !== null || (launchState.kind === 'cli' && !canLaunchTerminal)}
        onclick={handlePrimaryAction}
      >
        {#if launching === 'claude-desktop' && launchState.kind === 'claude-desktop'}
          Opening...
        {:else if launching === 'cli' && launchState.kind === 'cli'}
          Opening...
        {:else}
          {launchState.label}
        {/if}
      </button>
      <button
        type="button"
        class="secondary-action"
        disabled={revealingFolder}
        onclick={handleRevealFolder}
      >
        {revealingFolder ? 'Revealing...' : 'Reveal in Finder'}
      </button>
    </div>

    {#if launchState.kind === 'cli' && !canLaunchTerminal}
      <p class="hint">Copy the command above to open {cliTerminalLabel(launchState.tool)} from your HQ folder.</p>
    {:else if detectionFailed}
      <p class="hint">Tool detection failed. Use the folder and command above to open HQ manually.</p>
    {:else if launchState.kind === 'claude-desktop'}
      <p class="hint">
        Claude Desktop opens with /setup ready. If you prefer Terminal, copy the command above.
      </p>
    {:else if launchState.kind === 'download'}
      <p class="hint">
        No supported AI tool was detected. Download Claude, or use the folder and command above.
      </p>
    {:else if aiTools === null}
      <p class="hint">The command above is ready if detection takes a moment.</p>
    {/if}

    {#if launchState.kind === 'claude-desktop'}
      <p class="quiet-link">
        Need help? <button type="button" onclick={handleDownloadClaude}>Claude Desktop quickstart</button>
      </p>
    {/if}
  </section>

  <section class="handoff-card" aria-label="Import Claude setup">
    <h2>Import an existing Claude setup</h2>
    <p>
      If you already used Claude Code, run this inside HQ to bring over commands,
      skills, hooks, and policies.
    </p>
    <div class="value-row">
      <span class="value-text">/import-claude</span>
      <button type="button" class="small-button" onclick={handleCopyImportPrompt}>
        {importPromptCopied ? 'Copied' : 'Copy'}
      </button>
    </div>
  </section>

  {#if launchError || revealError}
    <div role="alert" class="error-card">
      {launchError ?? revealError}
    </div>
  {/if}

  <button type="button" class="finish-button" onclick={() => void onfinish?.()}>Open HQ</button>
</div>

<style>
  .summary-screen {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-5, 20px);
    width: 100%;
    max-width: 560px;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
  }

  .success-mark,
  .attention-mark {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: 999px;
  }

  .success-mark {
    border: 1px solid rgba(125, 211, 168, 0.55);
    background: rgba(125, 211, 168, 0.14);
    color: #9ae6b9;
    box-shadow: 0 0 0 6px rgba(125, 211, 168, 0.08);
  }

  .attention-mark {
    border: 1px solid rgba(245, 196, 107, 0.58);
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

  h1,
  h2,
  p {
    margin: 0;
  }

  h1 {
    color: var(--popover-text-heading, #ffffff);
    font-size: 28px;
    font-weight: 600;
    line-height: 1.15;
  }

  h2 {
    color: var(--popover-text-heading, #ffffff);
    font-size: var(--text-sm, 13px);
    font-weight: 750;
    line-height: 1.25;
  }

  p {
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font-size: var(--text-base, 13px);
    font-weight: 400;
    line-height: 1.6;
  }

  .muted,
  .hint,
  .quiet-link,
  .value-label {
    color: var(--popover-text-muted, rgba(255, 255, 255, 0.52));
  }

  .path-value,
  .value-text {
    color: var(--popover-text-heading, #ffffff);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace);
    overflow-wrap: anywhere;
  }

  .attention-card,
  .open-panel,
  .handoff-card,
  .error-card {
    box-sizing: border-box;
    width: 100%;
    border-radius: var(--radius-sm, 8px);
  }

  .attention-card {
    display: grid;
    gap: var(--space-3, 12px);
    padding: var(--space-4, 16px);
    border: 1px solid rgba(245, 196, 107, 0.34);
    background: rgba(245, 196, 107, 0.1);
  }

  .attention-card h2 {
    color: #f7d38b;
  }

  .attention-intro {
    color: rgba(255, 238, 204, 0.82);
    font-size: var(--text-xs, 12px);
    line-height: 1.45;
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

  .open-panel,
  .handoff-card {
    display: grid;
    gap: var(--space-3, 12px);
    padding: var(--space-4, 16px);
    border: 1px solid var(--popover-border, rgba(255, 255, 255, 0.12));
    background: rgba(255, 255, 255, 0.05);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .status-pill {
    flex: 0 0 auto;
    padding: 3px 8px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 999px;
    color: rgba(255, 255, 255, 0.62);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
  }

  .status-pill.ready {
    border-color: rgba(125, 211, 168, 0.34);
    color: #9ae6b9;
  }

  .value-block {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .value-label {
    font-size: var(--text-xs, 12px);
    line-height: 1.2;
  }

  .value-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 9px 10px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: var(--radius-sm, 8px);
    background: rgba(0, 0, 0, 0.24);
  }

  .value-text {
    min-width: 0;
    font-size: var(--text-xs, 12px);
    line-height: 1.45;
  }

  .panel-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }

  .primary-action,
  .secondary-action,
  .small-button,
  .finish-button {
    appearance: none;
    border-radius: 999px;
    font: inherit;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      opacity 0.12s ease;
  }

  .primary-action,
  .finish-button {
    min-height: 36px;
    padding: 0 20px;
    border: 1px solid var(--popover-primary, #ffffff);
    background: var(--popover-primary, #ffffff);
    color: var(--popover-primary-text, #111113);
    font-size: var(--text-sm, 13px);
    font-weight: 650;
  }

  .secondary-action,
  .small-button {
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.08);
    color: var(--popover-text-heading, #ffffff);
    font-size: var(--text-xs, 12px);
    font-weight: 600;
  }

  .secondary-action {
    min-height: 36px;
    padding: 0 16px;
  }

  .small-button {
    min-width: 58px;
    min-height: 28px;
    padding: 0 10px;
  }

  .primary-action:hover:not(:disabled),
  .finish-button:hover:not(:disabled) {
    background: var(--popover-primary-hover, rgba(255, 255, 255, 0.9));
  }

  .secondary-action:hover:not(:disabled),
  .small-button:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.14);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  button:focus-visible {
    outline: 2px solid var(--popover-highlight, rgba(255, 255, 255, 0.34));
    outline-offset: 2px;
  }

  .hint,
  .quiet-link,
  .handoff-card p {
    font-size: var(--text-xs, 12px);
    line-height: 1.45;
  }

  .quiet-link button {
    appearance: none;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--popover-text, rgba(255, 255, 255, 0.86));
    font: inherit;
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .error-card {
    padding: 10px 12px;
    border: 1px solid rgba(245, 196, 107, 0.24);
    background: rgba(245, 196, 107, 0.08);
    color: rgba(255, 238, 204, 0.86);
    font-size: var(--text-xs, 12px);
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  @media (max-width: 640px) {
    h1 {
      font-size: 24px;
    }

    .value-row {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
