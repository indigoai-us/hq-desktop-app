<script lang="ts">
  /**
   * SetupIncompleteCard — shown at the top of Home when the HQ tree does not
   * exist yet (setup never finished). Offers the same two launch actions the
   * installer's final step does: open Claude Code with `/setup` pre-entered
   * (desktop deep link → CLI-in-terminal fallback) or open Codex in a
   * terminal at the HQ folder. REUSE, do not reimplement: the Claude Code
   * link is built by `buildClaudeCodeUrl` and dispatched through
   * `adapter.shell.openClaudeCodeLink`; the terminal launches go through
   * `adapter.shell.launchClaudeCode` / `launchCliInTerminal` — the exact
   * commands the onboarding wizard uses.
   *
   * Self-fetching on purpose — HomePage stays presentational, and this card
   * renders nothing on a fully set-up machine. It checks `getSetupStatus`
   * (fresh per call) rather than the startup-cached lifecycle state, so
   * finishing setup mid-session makes the card disappear on next mount.
   *
   * Platform gating: setup + app-launching are desktop-only. When the host
   * reports the setup status as unavailable (web), the card stays hidden —
   * there is nothing to finish from a browser.
   */
  import { onMount } from "svelte";
  import type { SettingsApi, ShellApi } from "@hq/platform";
  import { buildClaudeCodeUrl } from "./claude-code-link";
  import {
    codexAvailable,
    resolveClaudeLaunchPath,
    SETUP_DEEP_LINK_PROMPT,
    SETUP_PROMPT,
    type AiTools,
  } from "./setup-launch";
  import { SETUP_BOT_COPY, type SetupBotLauncher } from "../chat/setup-bot";

  interface Props {
    /** Platform seam slices (see @hq/platform PlatformAdapter). */
    settings: Pick<SettingsApi, "getSetupStatus">;
    shell: Pick<
      ShellApi,
      | "detectAiTools"
      | "openClaudeCodeLink"
      | "launchClaudeCode"
      | "launchCliInTerminal"
    >;
    /**
     * SETUP AS A BOT (bots v2, step 3). With a launcher, the card's primary
     * action opens the setup bot's conversation — or creates it when this Mac
     * has a coding tool signed in. The tool launches below stay as they are:
     * they are the way through when no runtime is signed in (or the create
     * fails), and the card must never dead-end.
     */
    setupBot?: SetupBotLauncher | null;
  }

  let { settings, shell, setupBot = null }: Props = $props();

  /** The bot path can act: open the one that exists, or make one. */
  const botAction = $derived(Boolean(setupBot && (setupBot.existing || setupBot.ready)));
  let botBusy = $state(false);
  let botError = $state<string | null>(null);

  async function runSetupBot(): Promise<void> {
    if (!setupBot || botBusy) return;
    botBusy = true;
    botError = null;
    try {
      const result = await setupBot.start();
      if (!result.ok) botError = result.reason;
    } catch (err) {
      botError = err instanceof Error ? err.message : String(err);
    } finally {
      botBusy = false;
    }
  }

  interface SetupStatus {
    hqRootValid: boolean;
    configured: boolean;
    hqFolderPath: string;
  }

  let status = $state<SetupStatus | null>(null);
  let aiTools = $state<AiTools | null>(null);
  let launching = $state<"claude" | "codex" | null>(null);
  let launchError = $state<string | null>(null);
  let promptCopied = $state(false);

  const show = $derived(status !== null && !status.hqRootValid);

  onMount(async () => {
    const res = await settings.getSetupStatus();
    // Status unavailable (web) or errored — stay hidden rather than false-alarm.
    status = res.ok ? (res.value as unknown as SetupStatus) : null;
  });

  async function ensureAiTools(): Promise<AiTools | null> {
    if (aiTools) return aiTools;
    const res = await shell.detectAiTools();
    aiTools = res.ok ? (res.value as unknown as AiTools) : null;
    return aiTools;
  }

  function failureMessage(
    res: { ok: false; reason: string; message?: string },
    what: string,
  ): string {
    if (res.reason === "unavailable") {
      return `${what} isn't available in this app. Use the HQ desktop app to finish setup.`;
    }
    return `Could not open ${what}: ${res.message ?? "the command failed."}`;
  }

  async function launchClaude() {
    if (!status) return;
    launchError = null;
    launching = "claude";
    try {
      const path = resolveClaudeLaunchPath(await ensureAiTools());
      if (path === "deep-link") {
        const res = await shell.openClaudeCodeLink(
          buildClaudeCodeUrl({
            folder: status.hqFolderPath,
            // NOT SETUP_PROMPT: a deep-link folder is untrusted when Claude
            // Desktop scans skills, so the project `/setup` skill does not
            // exist in the session this link opens.
            prompt: SETUP_DEEP_LINK_PROMPT,
          }),
        );
        if (!res.ok) launchError = failureMessage(res, "Claude Code");
      } else if (path === "cli") {
        const res = await shell.launchClaudeCode(status.hqFolderPath);
        if (!res.ok) launchError = failureMessage(res, "Claude Code");
      } else {
        launchError =
          "Claude Code was not detected. Open your HQ folder in Claude Code and run /setup.";
      }
    } finally {
      launching = null;
    }
  }

  async function launchCodex() {
    if (!status) return;
    launchError = null;
    launching = "codex";
    try {
      if (codexAvailable(await ensureAiTools())) {
        const res = await shell.launchCliInTerminal({
          path: status.hqFolderPath,
          tool: "codex",
        });
        if (!res.ok) launchError = failureMessage(res, "Codex");
      } else {
        launchError =
          "Codex CLI was not detected. Open your HQ folder in Codex and run /setup.";
      }
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
      {#if botAction}
        <p class="setup-body" data-testid="setup-card-bot-body">{SETUP_BOT_COPY.cardBody}</p>
      {:else}
        <p class="setup-body">
          Your HQ folder isn't ready yet. Open your coding tool and run
          <code>/setup</code> to finish — the prompt comes pre-entered.
        </p>
      {/if}
      {#if botError}
        <p class="setup-error" role="alert" data-testid="setup-card-bot-error">{botError}</p>
      {/if}
      {#if launchError}
        <p class="setup-error" role="alert">{launchError}</p>
      {/if}
    </div>
    <div class="setup-actions">
      {#if botAction}
        <button
          type="button"
          class="setup-btn primary"
          disabled={botBusy}
          onclick={() => void runSetupBot()}
          data-testid="setup-open-bot"
        >
          {botBusy ? SETUP_BOT_COPY.starting : setupBot!.existing ? SETUP_BOT_COPY.open : SETUP_BOT_COPY.create}
        </button>
      {/if}
      <button
        type="button"
        class="setup-btn"
        class:primary={!botAction}
        disabled={launching !== null}
        onclick={launchClaude}
        data-testid="setup-open-claude"
      >
        {launching === "claude" ? "Opening…" : "Open in Claude Code"}
      </button>
      <button
        type="button"
        class="setup-btn"
        disabled={launching !== null}
        onclick={launchCodex}
        data-testid="setup-open-codex"
      >
        {launching === "codex" ? "Opening…" : "Open in Codex"}
      </button>
      <button type="button" class="setup-btn ghost" onclick={copySetupPrompt}>
        {promptCopied ? "Copied" : "Copy /setup"}
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
