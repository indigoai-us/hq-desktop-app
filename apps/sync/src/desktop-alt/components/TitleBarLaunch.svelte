<script lang="ts">
  /**
   * TitleBarLaunch — the standing "Open in Claude Code" / "Open in Codex"
   * cluster in the main window's title bar.
   *
   * The launch paths are the installer's, not a reimplementation: Claude
   * prefers the desktop deep link (`buildClaudeCodeUrl` →
   * `open_claude_code_link`, an empty prompt so the session just opens at the
   * HQ root) and falls back to `launch_claude_code`; Codex prefers
   * `launch_codex_desktop` (whose `open -a Codex` LaunchServices lookup
   * resolves to the ChatGPT-bundled build) and falls back to
   * `launch_cli_in_terminal`. Only detected tools render — this is a launch
   * surface for a configured machine, not the onboarding Ready screen, so it
   * never advertises installs.
   *
   * Detection runs once per mount. `detect_ai_tools` shells a login shell per
   * CLI probe, so the buttons appear when the answer arrives rather than
   * blocking the title bar.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import type { AiTools } from '../../lib/onboarding-summary';

  interface Props {
    /** Absolute HQ root the session opens in. Empty = still loading config;
     *  the cluster suppresses itself rather than launching into $HOME. */
    folder: string;
  }

  let { folder }: Props = $props();

  let tools = $state<AiTools | null>(null);
  let launching = $state<'claude' | 'codex' | null>(null);
  let launchError = $state<string | null>(null);

  const claudeAvailable = $derived(
    Boolean(tools && (tools.claude_desktop || tools.claude_cli)),
  );
  const codexAvailable = $derived(
    Boolean(tools && (tools.codex_desktop || tools.codex_cli)),
  );

  onMount(async () => {
    try {
      tools = await invoke<AiTools>('detect_ai_tools');
    } catch {
      // Detection unavailable — render nothing rather than dead buttons.
      tools = null;
    }
  });

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function flashError(message: string) {
    launchError = message;
    setTimeout(() => (launchError = null), 4000);
  }

  async function launchClaude() {
    if (!folder || launching) return;
    launching = 'claude';
    try {
      if (tools?.claude_desktop) {
        await invoke('open_claude_code_link', {
          url: buildClaudeCodeUrl({ folder, prompt: '' }),
        });
      } else {
        await invoke('launch_claude_code', { path: folder });
      }
    } catch (err) {
      flashError(`Could not open Claude Code: ${errorMessage(err)}`);
    } finally {
      launching = null;
    }
  }

  async function launchCodex() {
    if (!folder || launching) return;
    launching = 'codex';
    try {
      // `codex app <folder>` opens the DESKTOP app with the folder loaded —
      // the only launch that does (verified: the bare codex:// deep link and
      // folder-as-open-document both leave the app on "Choose project").
      // Bare desktop open stays as the no-CLI fallback: an app without your
      // project beats nothing at all.
      if (tools?.codex_cli) {
        await invoke('launch_codex_workspace', { path: folder });
      } else {
        await invoke('launch_codex_desktop');
      }
    } catch (err) {
      flashError(`Could not open Codex: ${errorMessage(err)}`);
    } finally {
      launching = null;
    }
  }
</script>

{#if folder && (claudeAvailable || codexAvailable)}
  <div class="launch-cluster" data-tauri-drag-region="false" data-testid="titlebar-launch">
    {#if launchError}
      <span class="launch-error" role="alert" title={launchError}>{launchError}</span>
    {/if}
    {#if claudeAvailable}
      <button
        type="button"
        class="launch-btn primary"
        data-testid="titlebar-open-claude"
        disabled={launching !== null}
        aria-busy={launching === 'claude'}
        onclick={() => void launchClaude()}
      >
        {launching === 'claude' ? 'Opening…' : 'Open in Claude Code'}
      </button>
    {/if}
    {#if codexAvailable}
      <button
        type="button"
        class="launch-btn"
        data-testid="titlebar-open-codex"
        disabled={launching !== null}
        aria-busy={launching === 'codex'}
        onclick={() => void launchCodex()}
      >
        {launching === 'codex' ? 'Opening…' : 'Open in Codex'}
      </button>
    {/if}
  </div>
{/if}

<style>
  .launch-cluster {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
  }

  /* Deliberately louder than .v4-action: these are the two "start working"
     doors — big and obvious was the ask. Height stays inside the 28px chrome
     row so the title bar doesn't grow. */
  .launch-btn {
    flex: 0 0 auto;
    height: 28px;
    padding: 0 14px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button, 7px);
    background: var(--v4-raised, transparent);
    color: var(--v4-text-1, inherit);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease,
      color 140ms ease;
  }

  .launch-btn:hover:not(:disabled) {
    border-color: var(--v4-hairline-strong, var(--v4-hairline));
    background: var(--v4-hover, var(--v4-raised));
  }

  .launch-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .launch-btn:focus-visible {
    outline: 2px solid var(--v4-accent, #4c8dff);
    outline-offset: 2px;
  }

  .launch-btn.primary {
    border-color: transparent;
    background: var(--v4-accent, #4c8dff);
    color: var(--v4-accent-fg, #fff);
  }

  .launch-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
    background: var(--v4-accent, #4c8dff);
  }

  .launch-error {
    max-width: 220px;
    overflow: hidden;
    color: var(--v4-error, #e5484d);
    font-size: var(--type-metadata, 10px);
    font-weight: 550;
    line-height: 1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
