<script lang="ts">
  /**
   * WorkHappensExplainer — the one-time first-open card that answers the
   * question every new user silently asks this window: "is this where I
   * work?"
   *
   * It is not. The desktop window syncs and shows; the doing happens in the
   * AI tools. Nothing else in the window says that at the moment it matters —
   * the first open — so people try to work HERE, hit surfaces with no
   * authoring affordances, and read the product as broken or empty.
   *
   * Shown once at the top of Home, dismissed forever via localStorage (a
   * per-device teaching moment, not synced state). It reuses the exact launch
   * plumbing of the title-bar cluster / installer: deep link for Claude
   * desktop, CLI-in-terminal fallbacks, ChatGPT-bundled Codex via
   * `launch_codex_desktop`.
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { buildClaudeCodeUrl } from '../../lib/claude-code-link';
  import type { AiTools } from '../../lib/onboarding-summary';

  const DISMISS_KEY = 'hq.workHappensExplainer.dismissed';

  interface Props {
    /** Absolute HQ root the launched session opens in. */
    folder: string;
  }

  let { folder }: Props = $props();

  let dismissed = $state(true);
  /** Setup gate: this card's launches open a session in the HQ folder and
   *  hard-error when the folder is not ready. On an unfinished machine the
   *  right teacher is SetupIncompleteCard (its buttons pre-enter /setup),
   *  so this card stays hidden until the root is valid. */
  let hqReady = $state(false);
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
      dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      // Storage unavailable — show the card; worst case it repeats.
      dismissed = false;
    }
    if (dismissed) return;
    try {
      const status = await invoke<{ hqRootValid: boolean }>('get_setup_status');
      hqReady = Boolean(status?.hqRootValid);
    } catch {
      // Status unavailable — stay hidden; SetupIncompleteCard owns ambiguity.
      hqReady = false;
    }
    if (!hqReady) return;
    try {
      tools = await invoke<AiTools>('detect_ai_tools');
    } catch {
      tools = null;
    }
  });

  function dismiss() {
    dismissed = true;
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Non-fatal — the card just reappears next launch.
    }
  }

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  async function launchClaude() {
    if (!folder || launching) return;
    launching = 'claude';
    launchError = null;
    try {
      if (tools?.claude_desktop) {
        await invoke('open_claude_code_link', {
          url: buildClaudeCodeUrl({ folder, prompt: '' }),
        });
      } else {
        await invoke('launch_claude_code', { path: folder });
      }
      dismiss();
    } catch (err) {
      launchError = `Could not open Claude Code: ${errorMessage(err)}`;
    } finally {
      launching = null;
    }
  }

  async function launchCodex() {
    if (!folder || launching) return;
    launching = 'codex';
    launchError = null;
    try {
      if (tools?.codex_desktop) {
        await invoke('launch_codex_desktop');
      } else {
        await invoke('launch_cli_in_terminal', { path: folder, tool: 'codex' });
      }
      dismiss();
    } catch (err) {
      launchError = `Could not open Codex: ${errorMessage(err)}`;
    } finally {
      launching = null;
    }
  }
</script>

{#if !dismissed && hqReady}
  <div
    class="explainer"
    role="region"
    aria-label="Where work happens"
    data-testid="work-happens-explainer"
  >
    <div class="explainer-copy">
      <h2 class="explainer-title">This window is your team's shared memory</h2>
      <p class="explainer-body">
        HQ keeps everything synced and lets you browse what your team is making
        — projects, goals, meetings, files. The work itself happens in your AI
        tools: open one below and everything you do there shows up here.
      </p>
      {#if launchError}
        <p class="explainer-error" role="alert">{launchError}</p>
      {/if}
    </div>
    <div class="explainer-actions">
      {#if claudeAvailable}
        <button
          type="button"
          class="explainer-btn primary"
          data-testid="explainer-open-claude"
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
          class="explainer-btn"
          data-testid="explainer-open-codex"
          disabled={launching !== null}
          aria-busy={launching === 'codex'}
          onclick={() => void launchCodex()}
        >
          {launching === 'codex' ? 'Opening…' : 'Open in Codex'}
        </button>
      {/if}
      <button
        type="button"
        class="explainer-btn ghost"
        data-testid="explainer-dismiss"
        onclick={dismiss}
      >
        Got it
      </button>
    </div>
  </div>
{/if}

<style>
  .explainer {
    margin: var(--space-4, 16px) var(--space-4, 16px) 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3, 12px);
    padding: var(--space-4, 16px) var(--space-4, 16px);
    border: 1px solid var(--v4-hairline, rgba(255, 255, 255, 0.12));
    border-radius: var(--v4-radius-card, 10px);
    background: var(--v4-raised, rgba(255, 255, 255, 0.04));
  }

  .explainer-copy {
    min-width: 260px;
    flex: 1 1 320px;
  }

  .explainer-title {
    margin: 0 0 4px;
    font-size: var(--type-title, 14px);
    font-weight: 700;
    color: var(--v4-text-1, inherit);
  }

  .explainer-body {
    margin: 0;
    font-size: var(--type-body, 12px);
    line-height: 1.5;
    color: var(--v4-text-2, inherit);
    max-width: 560px;
  }

  .explainer-error {
    margin: 6px 0 0;
    font-size: var(--type-metadata, 10px);
    color: var(--v4-text-2, inherit);
  }

  .explainer-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .explainer-btn {
    flex: 0 0 auto;
    height: 32px;
    padding: 0 16px;
    border: 1px solid var(--v4-hairline, rgba(255, 255, 255, 0.14));
    border-radius: var(--v4-radius-button, 7px);
    background: transparent;
    color: var(--v4-text-1, inherit);
    font: inherit;
    font-size: var(--type-body, 12px);
    font-weight: 650;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms ease,
      border-color 140ms ease;
  }

  .explainer-btn:hover:not(:disabled) {
    background: var(--v4-hover, rgba(255, 255, 255, 0.06));
  }

  .explainer-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .explainer-btn:focus-visible {
    outline: 2px solid var(--v4-accent, #4c8dff);
    outline-offset: 2px;
  }

  .explainer-btn.primary {
    border-color: transparent;
    background: var(--v4-accent, #4c8dff);
    color: var(--v4-accent-fg, #fff);
  }

  .explainer-btn.primary:hover:not(:disabled) {
    filter: brightness(1.08);
    background: var(--v4-accent, #4c8dff);
  }

  .explainer-btn.ghost {
    border-color: transparent;
    color: var(--v4-text-2, inherit);
  }
</style>
