<script lang="ts">
  /**
   * SetupInstallGuide - the guided path US-005 asked for. When setup finds no
   * coding tool installed (or none signed in), the SetupIncompleteCard used to
   * dead-end at "Open your HQ folder in Claude Code and run /setup", which
   * helps nobody without a CLI. This component replaces that dead-end with:
   *
   *   1. one primary button that installs the tool for the user (host runs
   *      the official installer for their platform);
   *   2. plain, honest progress ("Installing Claude Code…", never a fake bar);
   *   3. after the install lands, a "Sign in" step that opens the tool's own
   *      sign-in window and waits for it to complete (US-005 hard rule: HQ
   *      never asks for or handles the password);
   *   4. plain failure copy with the one manual step to take.
   *
   * Pure UI: every side effect goes through props (`oninstall`, `onsignin`,
   * `onrefresh`, `ondownload`). Tests inject fakes for the four paths
   * (no tool, tool present + not signed in, install fails, signed in).
   */
  import type { AiTools } from "./setup-launch";

  export type CodingTool = "claude" | "codex";

  export interface InstallOutcome {
    ok: boolean;
    /** Plain-language reason on failure (no stack traces, no CLI raw). */
    reason?: string;
  }

  interface Props {
    /**
     * Detected AI tools. Null while the host is still probing; the guide
     * renders a checking line rather than making a false claim either way.
     */
    tools: AiTools | null;
    /**
     * Which tool the primary Install button should offer. The brief scoped
     * US-005 to "the coding tool" HQ picks; Claude Code is the default. Cloud
     * later can widen this.
     */
    preferred?: CodingTool;
    /**
     * Install the tool. Host runs the official installer (Windows: `.msi`,
     * macOS: `.pkg`/brew, npm fallback). Returns ok:true when the CLI is on
     * disk, ok:false with a plain reason otherwise. Never expected to throw.
     */
    oninstall(tool: CodingTool): Promise<InstallOutcome>;
    /**
     * Open the tool's own sign-in window and resolve once it reports success
     * (typical flow: open the app's OAuth URL, wait for the browser callback).
     * ok:false with reason on cancel/error.
     */
    onsignin(tool: CodingTool): Promise<InstallOutcome>;
    /** Re-detect tools (host `detectAiTools`) after install or sign-in. */
    onrefresh(): Promise<void>;
    /** Manual download URL to fall back to when install is blocked. */
    downloadUrlFor(tool: CodingTool): string;
    /** Open a URL in the system browser. Kept opaque; no direct DOM link. */
    onopen(url: string): Promise<InstallOutcome> | void;
  }

  const TOOL_LABEL: Record<CodingTool, string> = {
    claude: "Claude Code",
    codex: "Codex",
  };

  let {
    tools,
    preferred = "claude",
    oninstall,
    onsignin,
    onrefresh,
    downloadUrlFor,
    onopen,
  }: Props = $props();

  const installed = $derived<Record<CodingTool, boolean>>({
    claude: Boolean(tools?.claude_cli || tools?.claude_desktop),
    codex: Boolean(tools?.codex_cli || tools?.codex_desktop),
  });

  // Sign-in evidence isn't in AiTools yet; the host tells us via `onsignin`.
  // The guide's "signed in?" state is local, seeded by whether ANY tool
  // record is present (installed) AND the caller marks it so. Kept minimal
  // for testability - the SetupIncompleteCard's own launcher state is what
  // actually drives the wider "setup is unblocked" decision.
  let signInCompletedFor = $state<CodingTool | null>(null);

  let busy = $state(false);
  let phase = $state<"idle" | "installing" | "installed-need-signin" | "signing-in" | "done" | "install-failed" | "signin-failed">(
    "idle",
  );
  let failureReason = $state<string | null>(null);
  let activeTool = $state<CodingTool>(preferred);

  const toolLabel = $derived(TOOL_LABEL[activeTool]);

  const primaryLabel = $derived.by(() => {
    if (phase === "installing") return `Installing ${toolLabel}…`;
    if (phase === "installed-need-signin") return `Sign in to ${toolLabel}`;
    if (phase === "signing-in") return "Waiting for sign-in…";
    if (phase === "done") return "You're set";
    if (phase === "install-failed") return `Retry installing ${toolLabel}`;
    if (phase === "signin-failed") return `Try signing in again`;
    // Not yet installed → offer install; already installed but not confirmed
    // signed-in → offer sign-in.
    return installed[activeTool] ? `Sign in to ${toolLabel}` : `Install ${toolLabel}`;
  });

  const lede = $derived.by(() => {
    if (tools === null) return `Checking whether ${toolLabel} is on this computer…`;
    if (phase === "installing") {
      return `HQ is downloading and installing ${toolLabel}. This usually takes a minute or two. Leave this window open.`;
    }
    if (phase === "installed-need-signin" || (installed[activeTool] && phase === "idle")) {
      return `${toolLabel} is installed. Sign in to finish. HQ opens ${toolLabel}'s own sign-in window; your password never comes to HQ.`;
    }
    if (phase === "signing-in") {
      return `Finish signing in in the ${toolLabel} window. HQ will notice as soon as it's done.`;
    }
    if (phase === "install-failed") {
      return `HQ couldn't install ${toolLabel}. This is usually antivirus, a permission prompt HQ can't see, or being offline. You can download it yourself instead - one step.`;
    }
    if (phase === "signin-failed") {
      return `Sign-in did not complete. Try again in the ${toolLabel} window, or pick a different coding tool.`;
    }
    if (phase === "done") {
      return `${toolLabel} is ready. HQ can finish setup now.`;
    }
    return `Setup needs a coding tool on this computer. HQ can install ${toolLabel} for you and walk you through signing in - no CLI needed.`;
  });

  async function runInstall(): Promise<void> {
    if (busy) return;
    busy = true;
    failureReason = null;
    phase = "installing";
    try {
      const outcome = await oninstall(activeTool);
      if (!outcome.ok) {
        failureReason = outcome.reason ?? `HQ couldn't finish installing ${toolLabel}.`;
        phase = "install-failed";
        return;
      }
      await onrefresh();
      phase = "installed-need-signin";
    } finally {
      busy = false;
    }
  }

  async function runSignIn(): Promise<void> {
    if (busy) return;
    busy = true;
    failureReason = null;
    phase = "signing-in";
    try {
      const outcome = await onsignin(activeTool);
      if (!outcome.ok) {
        failureReason = outcome.reason ?? `Sign-in did not complete.`;
        phase = "signin-failed";
        return;
      }
      signInCompletedFor = activeTool;
      await onrefresh();
      phase = "done";
    } finally {
      busy = false;
    }
  }

  async function runPrimary(): Promise<void> {
    // Retry states short-circuit back to the operation they failed on.
    if (phase === "install-failed") return void runInstall();
    if (phase === "signin-failed") return void runSignIn();
    if (phase === "done") return;
    // The two-step flow: after an install lands the guide is on
    // `installed-need-signin`, and the next click must run sign-in even if the
    // `tools` prop hasn't re-detected the CLI on disk yet (a Windows PATH
    // refresh can lag a poll behind the install landing).
    if (phase === "installed-need-signin") return void runSignIn();
    // Fresh states: install if the tool isn't here yet, otherwise sign in.
    if (installed[activeTool]) return void runSignIn();
    return void runInstall();
  }

  async function downloadManually(): Promise<void> {
    const url = downloadUrlFor(activeTool);
    if (!url) return;
    const outcome = onopen(url);
    if (outcome && typeof (outcome as Promise<unknown>).then === "function") {
      await outcome;
    }
  }
</script>

<div
  class="install-guide"
  data-testid="setup-install-guide"
  data-phase={phase}
  data-tool={activeTool}
  role="region"
  aria-label={`Install ${toolLabel} for setup`}
>
  <p class="lede" data-testid="setup-install-guide-lede">{lede}</p>

  {#if failureReason}
    <p class="error" role="alert" data-testid="setup-install-guide-error">{failureReason}</p>
  {/if}

  <div class="actions">
    <button
      type="button"
      class="primary"
      disabled={busy || phase === "done"}
      onclick={() => void runPrimary()}
      data-testid="setup-install-guide-primary"
    >{primaryLabel}</button>

    {#if phase === "install-failed"}
      <button
        type="button"
        class="secondary"
        onclick={() => void downloadManually()}
        data-testid="setup-install-guide-download"
      >Download {toolLabel} instead</button>
    {/if}
  </div>

  <!-- Hidden marker so tests and the parent card can key on the guide's
       terminal states without inspecting internal state. -->
  <span hidden aria-hidden="true" data-testid="setup-install-guide-state">{phase}</span>
</div>

<style>
  .install-guide {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-2, transparent);
  }
  .lede {
    margin: 0;
    color: var(--muted-2);
    font-size: var(--text-base);
    line-height: 1.4;
  }
  .error {
    margin: 0;
    color: var(--red, #e5484d);
    font-size: var(--text-base);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .primary,
  .secondary {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--muted-2);
    font: inherit;
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
  }
  .primary {
    border-color: var(--blue);
    color: var(--fg);
  }
  .primary:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .primary:focus-visible,
  .secondary:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }
</style>
