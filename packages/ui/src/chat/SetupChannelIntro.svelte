<script lang="ts">
  /**
   * SetupChannelIntro — the getting-started header of the synthetic #setup
   * support channel in the live desktop shell: welcome cards, resource
   * links, and the three launch actions (Claude Code / Codex / Grok Build).
   *
   * REUSE, do not reimplement: launch paths mirror SetupIncompleteCard —
   * Claude Code goes desktop deep link (`buildClaudeCodeUrl` →
   * `shell.openClaudeCodeLink`) then CLI (`shell.launchClaudeCode`); Codex
   * goes ChatGPT desktop app first (`shell.launchCodexWorkspace` — workspace
   * loaded + `/setup` pre-typed) then CLI terminal
   * (`shell.launchCliInTerminal`), clipboard copy as last resort; Grok goes
   * through `shell.launchCliInTerminal`. The HQ folder path
   * comes from `settings.getSetupStatus`. The live message thread + composer
   * below this header are the shell's standard ChannelConversation pipeline
   * with channelId "setup" — this component owns only the intro.
   */
  import { onMount } from "svelte";
  import type { SettingsApi, ShellApi } from "@hq/platform";
  import { buildClaudeCodeUrl } from "../settings/claude-code-link";
  import {
    resolveClaudeLaunchPath,
    resolveCodexLaunchPath,
    SETUP_PROMPT,
    type AiTools,
  } from "../settings/setup-launch";
  import {
    SETUP_LAUNCH_COMMANDS,
    SETUP_WELCOME_MESSAGES,
  } from "./setup-channel";

  interface Props {
    /** Platform seam slices (see @hq/platform PlatformAdapter). */
    settings: Pick<SettingsApi, "getSetupStatus">;
    shell: Pick<
      ShellApi,
      | "detectAiTools"
      | "openClaudeCodeLink"
      | "launchClaudeCode"
      | "launchCodexWorkspace"
      | "launchCliInTerminal"
    >;
    /** Open an external URL via the host (system browser). */
    onopenurl?: (url: string) => void;
  }

  let { settings, shell, onopenurl }: Props = $props();

  type LaunchKey = "claude" | "codex" | "grok";

  let hqFolderPath = $state("");
  let aiTools = $state<AiTools | null>(null);
  let launching = $state<LaunchKey | null>(null);
  let launchErrors = $state<Partial<Record<LaunchKey, string>>>({});

  const canLaunch = $derived(hqFolderPath.trim().length > 0);

  onMount(async () => {
    const res = await settings.getSetupStatus();
    if (res.ok) {
      const status = res.value as { hqFolderPath?: string } | null;
      hqFolderPath = status?.hqFolderPath?.trim() ?? "";
    }
  });

  async function ensureAiTools(): Promise<AiTools | null> {
    if (aiTools) return aiTools;
    const res = await shell.detectAiTools();
    aiTools = res.ok ? (res.value as unknown as AiTools) : null;
    return aiTools;
  }

  function setLaunchError(key: LaunchKey, message: string | null): void {
    launchErrors = { ...launchErrors, [key]: message ?? undefined };
  }

  function failureMessage(
    res: { ok: false; reason: string; message?: string },
    what: string,
  ): string {
    if (res.reason === "unavailable") {
      return `${what} isn't available in this app. Use the HQ desktop app.`;
    }
    return `Could not open ${what}: ${res.message ?? "the command failed."}`;
  }

  async function launchClaude(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError("claude", null);
    launching = "claude";
    try {
      const path = resolveClaudeLaunchPath(await ensureAiTools());
      if (path === "deep-link") {
        const res = await shell.openClaudeCodeLink(
          buildClaudeCodeUrl({
            folder: hqFolderPath,
            prompt: SETUP_LAUNCH_COMMANDS.claude.prompt,
          }),
        );
        if (!res.ok) setLaunchError("claude", failureMessage(res, "Claude Code"));
      } else if (path === "cli") {
        const res = await shell.launchClaudeCode(hqFolderPath);
        if (!res.ok) setLaunchError("claude", failureMessage(res, "Claude Code"));
      } else {
        setLaunchError(
          "claude",
          `Claude Code was not detected. Open your HQ folder in Claude Code and run ${SETUP_PROMPT}.`,
        );
      }
    } finally {
      launching = null;
    }
  }

  async function launchCodex(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError("codex", null);
    launching = "codex";
    try {
      const tools = await ensureAiTools();
      const path = resolveCodexLaunchPath(tools);
      // Cascade: ChatGPT desktop app's Codex surface (workspace + /setup
      // pre-typed) → codex CLI in a terminal → clipboard copy of the prompt.
      if (path === "desktop") {
        const res = await shell.launchCodexWorkspace(
          hqFolderPath,
          SETUP_LAUNCH_COMMANDS.codex.prompt,
        );
        if (res.ok) return;
        // Desktop launch failed — fall through to the terminal CLI if one
        // is on PATH, otherwise surface the failure.
        if (!tools?.codex_cli) {
          setLaunchError("codex", failureMessage(res, "Codex"));
          return;
        }
      }
      if (path !== "none") {
        const res = await shell.launchCliInTerminal({
          path: hqFolderPath,
          tool: SETUP_LAUNCH_COMMANDS.codex.kind,
        });
        if (!res.ok) setLaunchError("codex", failureMessage(res, "Codex"));
        return;
      }
      let copied = false;
      try {
        await navigator.clipboard.writeText(SETUP_PROMPT);
        copied = true;
      } catch {
        copied = false;
      }
      setLaunchError(
        "codex",
        copied
          ? `Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run ${SETUP_PROMPT} — the prompt was copied to your clipboard.`
          : `Codex was not detected. Open your HQ folder in the ChatGPT app's Codex tab (or the codex CLI) and run ${SETUP_PROMPT}.`,
      );
    } finally {
      launching = null;
    }
  }

  async function launchGrok(): Promise<void> {
    if (!canLaunch || launching) return;
    setLaunchError("grok", null);
    launching = "grok";
    try {
      const res = await shell.launchCliInTerminal({
        path: hqFolderPath,
        tool: SETUP_LAUNCH_COMMANDS.grok.tool,
      });
      if (!res.ok) setLaunchError("grok", failureMessage(res, "Grok Build"));
    } finally {
      launching = null;
    }
  }

  function openResourceLink(event: MouseEvent, href: string): void {
    event.preventDefault();
    if (!/^https?:/i.test(href)) return;
    onopenurl?.(href);
  }
</script>

<section
  class="setup-intro"
  aria-label="Getting started with HQ Desktop"
  data-testid="setup-channel-intro"
>
  <div class="welcome-list">
    {#each SETUP_WELCOME_MESSAGES as message (message.id)}
      <article class="welcome-card" data-welcome-id={message.id}>
        <span class="welcome-author">HQ</span>
        <div class="welcome-bubble">
          {#if message.title}
            <h3 class="welcome-title">{message.title}</h3>
          {/if}
          <p class="welcome-body">{message.body}</p>
          {#if message.links?.length}
            <ul class="welcome-links">
              {#each message.links as link (link.href)}
                <li>
                  <a
                    class="welcome-link"
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    onclick={(event) => openResourceLink(event, link.href)}
                  >
                    {link.label}
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </article>
    {/each}
  </div>

  <div class="setup-actions">
    <div class="setup-action">
      <button
        type="button"
        class="launch-btn primary"
        data-testid="setup-launch-claude"
        disabled={!canLaunch || launching !== null}
        aria-busy={launching === "claude"}
        onclick={() => void launchClaude()}
      >
        {launching === "claude" ? "Opening…" : "Open setup in Claude Code"}
      </button>
      {#if launchErrors.claude}
        <p class="launch-error" role="alert">{launchErrors.claude}</p>
      {/if}
    </div>
    <div class="setup-action">
      <button
        type="button"
        class="launch-btn"
        data-testid="setup-launch-codex"
        disabled={!canLaunch || launching !== null}
        aria-busy={launching === "codex"}
        onclick={() => void launchCodex()}
      >
        {launching === "codex" ? "Opening…" : "Open setup in Codex"}
      </button>
      {#if launchErrors.codex}
        <p class="launch-error" role="alert">{launchErrors.codex}</p>
      {/if}
    </div>
    <div class="setup-action">
      <button
        type="button"
        class="launch-btn"
        data-testid="setup-launch-grok"
        disabled={!canLaunch || launching !== null}
        aria-busy={launching === "grok"}
        onclick={() => void launchGrok()}
      >
        {launching === "grok" ? "Opening…" : "Open setup in Grok Build (terminal)"}
      </button>
      {#if launchErrors.grok}
        <p class="launch-error" role="alert">{launchErrors.grok}</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .setup-intro {
    flex: 0 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-4, 1rem) var(--space-4, 1.25rem)
      var(--space-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--space-3, 0.875rem);
    border-bottom: 1px solid var(--border);
  }

  .welcome-list {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2, 0.625rem);
  }

  .welcome-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: min(80%, 420px);
  }

  .welcome-author {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--muted-2);
    margin: 0 0.25rem 0.125rem;
  }

  .welcome-bubble {
    padding: 0.5rem 0.75rem;
    border-radius: 16px;
    border-bottom-left-radius: 4px;
    background: var(--row-hover);
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .welcome-title {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg);
  }

  .welcome-body {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--fg);
  }

  .welcome-links {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .welcome-link {
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--fg);
    text-decoration: underline;
    text-underline-offset: 0.125rem;
  }

  .welcome-link:hover {
    color: var(--muted-2);
  }

  .setup-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-2, 0.5rem);
  }

  .setup-action {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 100%;
  }

  .launch-btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 7px);
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

  .launch-btn:hover:not(:disabled) {
    border-color: var(--border-strong);
    background: var(--row-hover);
    color: var(--fg);
  }

  .launch-btn.primary {
    border-color: var(--blue);
    color: var(--fg);
  }

  .launch-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .launch-btn:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }

  .launch-error {
    margin: 0;
    max-width: 22rem;
    font-size: var(--text-base);
    line-height: 1.4;
    color: var(--red, #e5484d);
  }
</style>
