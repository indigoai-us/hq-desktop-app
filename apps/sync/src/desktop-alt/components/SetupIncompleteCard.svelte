<script lang="ts">
  /**
   * SetupIncompleteCard — shown at the top of Home when the HQ tree does not
   * exist yet (setup never finished). Offers the same two launch actions the
   * installer's final step does: open Claude Code with `/setup` pre-entered
   * (desktop deep link → CLI-in-terminal fallback) or open Codex in a
   * terminal at the HQ folder. REUSE, do not reimplement: the Claude Code
   * link is built by `buildClaudeCodeUrl` and dispatched through
   * `open_claude_code_link`; the terminal launches go through
   * `launch_claude_code` / `launch_cli_in_terminal` — the exact commands the
   * onboarding wizard uses.
   *
   * Self-fetching on purpose — HomePage stays presentational, and this card
   * renders nothing on a fully set-up machine. It checks `get_setup_status`
   * (fresh per call) rather than `get_lifecycle_state` (cached at startup),
   * so finishing setup mid-session makes the card disappear on next mount.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import type { AiTools } from '../../lib/onboarding-summary';
  import {
    codexAvailable,
    resolveClaudeLaunchPath,
    SETUP_PROMPT,
  } from '../lib/setup-launch';

  interface SetupStatus {
    hqRootValid: boolean;
    configured: boolean;
    hqFolderPath: string;
  }

  let status = $state<SetupStatus | null>(null);
  let aiTools = $state<AiTools | null>(null);
  let launching = $state<'claude' | 'codex' | null>(null);
  let launchError = $state<string | null>(null);
  let promptCopied = $state(false);

  const show = $derived(status !== null && !status.hqRootValid);

  onMount(async () => {
    try {
      status = await invoke<SetupStatus>('get_setup_status');
    } catch {
      // Status unavailable — stay hidden rather than false-alarm.
      status = null;
    }
  });

  async function ensureAiTools(): Promise<AiTools | null> {
    if (aiTools) return aiTools;
    try {
      aiTools = await invoke<AiTools>('detect_ai_tools');
    } catch {
      aiTools = null;
    }
    return aiTools;
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function launchClaude() {
    if (!status) return;
    launchError = null;
    launching = 'claude';
    try {
      const path = resolveClaudeLaunchPath(await ensureAiTools());
      if (path === 'deep-link') {
        await invoke('open_claude_code_link', {
          url: buildClaudeCodeUrl({
            folder: status.hqFolderPath,
            prompt: SETUP_PROMPT,
          }),
        });
      } else if (path === 'cli') {
        await invoke('launch_claude_code', { path: status.hqFolderPath });
      } else {
        launchError =
          'Claude Code was not detected. Open your HQ folder in Claude Code and run /setup.';
      }
    } catch (err) {
      launchError = `Could not open Claude Code: ${errorMessage(err)}`;
    } finally {
      launching = null;
    }
  }

  async function launchCodex() {
    if (!status) return;
    launchError = null;
    launching = 'codex';
    try {
      if (codexAvailable(await ensureAiTools())) {
        await invoke('launch_cli_in_terminal', {
          path: status.hqFolderPath,
          tool: 'codex',
        });
      } else {
        launchError =
          'Codex CLI was not detected. Open your HQ folder in Codex and run /setup.';
      }
    } catch (err) {
      launchError = `Could not open Codex: ${errorMessage(err)}`;
    } finally {
      launching = null;
    }
  }

  async function copySetupPrompt() {
    try {
      await navigator.clipboard.writeText(SETUP_PROMPT);
      promptCopied = true;
      setTimeout(() => (promptCopied = false), 1800);
    } catch {
      // Clipboard unavailable — nothing useful to surface.
    }
  }
</script>

{#if show}
  <div
    class="setup-card"
    role="region"
    aria-label="Finish setting up HQ"
    data-testid="setup-incomplete-card"
  >
    <div class="setup-copy">
      <h2 class="setup-title">Finish setting up HQ</h2>
      <p class="setup-body">
        Your HQ folder isn't ready yet. Open your agent and run
        <code>/setup</code> to finish — the prompt comes pre-entered.
      </p>
      {#if launchError}
        <p class="setup-error" role="alert">{launchError}</p>
      {/if}
    </div>
    <div class="setup-actions">
      <button
        type="button"
        class="setup-btn primary"
        disabled={launching !== null}
        onclick={launchClaude}
        data-testid="setup-open-claude"
      >
        {launching === 'claude' ? 'Opening…' : 'Open in Claude Code'}
      </button>
      <button
        type="button"
        class="setup-btn"
        disabled={launching !== null}
        onclick={launchCodex}
        data-testid="setup-open-codex"
      >
        {launching === 'codex' ? 'Opening…' : 'Open in Codex'}
      </button>
      <button type="button" class="setup-btn ghost" onclick={copySetupPrompt}>
        {promptCopied ? 'Copied' : 'Copy /setup'}
      </button>
    </div>
  </div>
{/if}

<style>
  .setup-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--row-active);
  }

  .setup-copy {
    min-width: 220px;
    flex: 1 1 260px;
  }

  .setup-title {
    margin: 0 0 2px;
    font-size: var(--text-md);
    font-weight: 700;
    color: var(--fg);
  }

  .setup-body {
    margin: 0;
    font-size: var(--text-base);
    color: var(--muted-2);
  }

  .setup-body code {
    font-family: var(--font-mono, monospace);
    color: var(--fg);
  }

  .setup-error {
    margin: var(--space-1) 0 0;
    font-size: var(--text-base);
    color: var(--red, #e5484d);
  }

  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .setup-btn {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-2);
    font: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }

  .setup-btn:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--row-hover);
    color: var(--fg);
  }

  .setup-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .setup-btn:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }

  .setup-btn.primary {
    border-color: var(--blue);
    color: var(--fg);
  }

  .setup-btn.ghost {
    border-color: transparent;
  }
</style>
