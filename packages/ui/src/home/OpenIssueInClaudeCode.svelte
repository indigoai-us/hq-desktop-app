<script lang="ts">
  /**
   * OpenIssueInClaudeCode — error-oriented "open this in Claude Code" button
   * for the Core popover's sync trouble notices (PL-02).
   *
   * This is the `@hq/ui` port of the tray popover's `OpenInClaudeCodeButton`
   * (`apps/sync/src/components/OpenInClaudeCodeButton.svelte`). Same prompt
   * registry (`copy-prompts.ts`), same deep-link shape, same clipboard
   * fallback when Claude Code is not installed. The difference is the dispatch
   * seam: this one goes through the platform `ShellApi` rather than invoking
   * a Tauri command directly, so it also renders on hosts that are not Tauri.
   *
   * `folder` empty → the button suppresses itself, matching the tray
   * popover's contract (a session with no working directory would open Claude
   * Code in the wrong place).
   */
  import type { ShellApi } from "@hq/platform";
  import { buildClaudeCodeUrl } from "../files/claude-code-link.js";
  import { buildPrompt, type Issue } from "./copy-prompts.js";

  interface Props {
    /** Platform shell seam — the same `adapter.appShell` the popover holds. */
    shell: ShellApi;
    /** Issue descriptor. The prompt template per kind lives in copy-prompts. */
    issue: Issue;
    /** Absolute HQ root the session should `cwd` into (`config.hqFolderPath`).
     *  Empty → the button renders nothing. */
    folder: string;
    /** `inline` shows the label; `compact` hides it until hover. */
    variant?: "inline" | "compact";
    label?: string;
  }

  let {
    shell,
    issue,
    folder,
    variant = "inline",
    label = "Fix in Claude Code",
  }: Props = $props();

  let dispatched = $state(false);
  let dispatching = $state(false);
  let dispatchError = $state<string | null>(null);
  let copiedFallback = $state(false);

  async function dispatch(): Promise<void> {
    if (dispatching || !folder) return;
    dispatching = true;
    dispatchError = null;
    copiedFallback = false;
    const prompt = buildPrompt(issue);
    try {
      const url = buildClaudeCodeUrl({ folder, prompt });
      const res = await shell.openClaudeCodeLink(url);
      if (!res.ok) throw new Error(res.message ?? "Claude Code is unavailable");
      dispatched = true;
      setTimeout(() => (dispatched = false), 1800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("open-issue-in-claude-code: dispatch failed", err);
      // Same fallback as the tray popover: the user still gets the prompt.
      try {
        await navigator.clipboard.writeText(prompt);
        copiedFallback = true;
        dispatchError = "Claude Code not installed — prompt copied instead";
        setTimeout(() => {
          copiedFallback = false;
          dispatchError = null;
        }, 4000);
      } catch (copyErr) {
        console.error("open-issue-in-claude-code: copy fallback failed", copyErr);
        dispatchError = msg;
        setTimeout(() => (dispatchError = null), 4000);
      }
    } finally {
      dispatching = false;
    }
  }
</script>

{#if folder}
  <button
    type="button"
    class="open-issue-btn"
    class:compact={variant === "compact"}
    class:dispatched
    class:fallback={copiedFallback}
    class:error={!!dispatchError && !copiedFallback}
    data-testid="core-popover-open-in-claude"
    data-issue-kind={issue.kind}
    onclick={() => void dispatch()}
    disabled={dispatching}
    aria-busy={dispatching}
    title={dispatchError ??
      "Open Claude Code in your HQ folder with this error preloaded as a prompt"}
    aria-label={`${label} — open this error in Claude Code with a prefilled fix prompt`}
  >
    <!-- Sparkle — same glyph the tray popover used, so `compact` (label
         visually hidden) still has something to draw. -->
    <svg
      width="11"
      height="11"
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4L8 2.5z"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linejoin="round"
      />
    </svg>
    <span class="open-issue-label">
      {#if dispatching}
        Opening…
      {:else if dispatched}
        Opened
      {:else if copiedFallback}
        Prompt copied
      {:else if dispatchError}
        Failed
      {:else}
        {label}
      {/if}
    </span>
  </button>
{/if}

<style>
  /* Matches .core-btn.secondary in CorePopover — one button language. */
  .open-issue-btn {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    background: var(--raised);
    color: var(--t2);
    font: 500 11px/1.2 var(--font-ui);
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 120ms ease,
      color 120ms ease,
      border-color 120ms ease;
  }

  .open-issue-btn:hover {
    color: var(--t1);
  }

  .open-issue-btn:disabled {
    cursor: wait;
  }

  .open-issue-btn:focus-visible {
    outline: 2px solid var(--ice-ink);
    outline-offset: 2px;
  }

  .open-issue-btn.dispatched,
  .open-issue-btn.fallback {
    color: var(--t1);
  }

  /* Failure stays neutral — the tooltip carries the error text. */
  .open-issue-btn.error {
    opacity: 0.85;
  }

  .open-issue-btn.compact .open-issue-label {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
