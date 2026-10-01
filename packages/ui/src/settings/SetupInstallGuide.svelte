<script lang="ts" module>
  export type CodingTool = "claude" | "codex";

  export interface InstallOutcome {
    ok: boolean;
    /** Plain-language reason on failure (no stack traces, no CLI raw). */
    reason?: string;
  }

  /** Options for one sign-in wait; `signal` ends the wait early. */
  export interface SignInOptions {
    signal?: AbortSignal;
  }

  /** The coding tools the guide offers, in the order the picker lists them. */
  export const CODING_TOOLS: readonly CodingTool[] = ["claude", "codex"];

  /** The tool's name in sentences ("Sign in to Claude Code"). */
  export const TOOL_LABEL: Record<CodingTool, string> = {
    claude: "Claude Code",
    codex: "Codex",
  };

  /**
   * The one action's label when the tool is not on this computer yet. It
   * installs the tool and then opens its sign-in by itself. Product asked for
   * "Install Claude" on this button; sentences keep the tool's full name.
   */
  export const INSTALL_BUTTON_LABEL: Record<CodingTool, string> = {
    claude: "Install Claude",
    codex: "Install Codex",
  };

  /** The same action's label when the tool is installed but not signed in. */
  export const SIGN_IN_BUTTON_LABEL: Record<CodingTool, string> = {
    claude: "Sign in to Claude",
    codex: "Sign in to Codex",
  };

  /**
   * How often the guide re-checks, while it is on screen and idle, whether a
   * coding tool got signed in some other way (a terminal, the tool's own
   * app, a sign-in finished after HQ stopped waiting). A `setTimeout` chain
   * that pauses while the window is hidden and re-checks the moment it is
   * visible again; it stops for good once the guide reaches `done`.
   */
  export const SIGN_IN_RECHECK_MS = 5_000;
</script>

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
   *   3. as soon as the install lands, the tool's own sign-in page opens by
   *      itself (one button, not two) and the guide waits for it to complete
   *      (US-005 hard rule: HQ never asks for or handles the password);
   *   4. plain failure copy with the one manual step to take.
   *
   * Pure UI: every side effect goes through props (`oninstall`, `onsignin`,
   * `onrefresh`, `ondownload`). Tests inject fakes for the four paths
   * (no tool, tool present + not signed in, install fails, signed in).
   */
  import type { AiTools } from "./setup-launch";
  import {
    hostComputerNoun,
    subscribeHostComputerNoun,
    thisComputerNoun,
  } from "@hq/platform";
  import { onDestroy, onMount } from "svelte";
  import InstallChoice from "../install-choice/InstallChoice.svelte";
  import {
    assistantOnlyChoices,
    resolveInstallChoices,
    type AssistantId,
  } from "../install-choice/install-choice.js";

  interface Props {
    /**
     * Detected AI tools. Null while the host is still probing; the guide
     * renders a checking line rather than making a false claim either way.
     */
    tools: AiTools | null;
    /** Which tool the picker starts on. Claude Code is the default. */
    preferred?: CodingTool;
    /**
     * Install the tool. Host runs the official installer (Windows: `.msi`,
     * macOS: `.pkg`/brew, npm fallback). Returns ok:true when the CLI is on
     * disk, ok:false with a plain reason otherwise. Never expected to throw.
     */
    oninstall(tool: CodingTool): Promise<InstallOutcome>;
    /**
     * Open the tool's own sign-in window and resolve once the sign-in has
     * FINISHED (signed in, failed, or timed out) — not when the browser
     * opens. ok:false with reason on cancel/error.
     */
    onsignin(tool: CodingTool, options?: SignInOptions): Promise<InstallOutcome>;
    /**
     * Optional: is this tool already signed in? When provided, the guide
     * checks on mount and every few seconds while idle, and skips straight to
     * Continue when one is. Must not start a sign-in.
     */
    onstatus?(tool: CodingTool): Promise<boolean>;
    /** Optional: stop the host's pending sign-in so a fresh one can start. */
    oncancelsignin?(tool: CodingTool): Promise<void>;
    /**
     * Optional: move the person on once a tool is signed in. When provided,
     * the done state shows a primary Continue button, and a sign-in finished
     * inside the guide continues by itself. Without it, done reads "You're
     * set" (the Settings card drives its own next step).
     */
    oncontinue?(): Promise<void> | void;
    /** Re-detect tools (host `detectAiTools`) after install or sign-in. */
    onrefresh(): Promise<void>;
    /** Manual download URL to fall back to when install is blocked. */
    downloadUrlFor(tool: CodingTool): string;
    /** Open a URL in the system browser. Kept opaque; no direct DOM link. */
    onopen(url: string): Promise<InstallOutcome> | void;
    /**
     * Optional: open one of the assistant desktop apps (Claude Desktop or
     * the ChatGPT desktop app) with a fixed install prompt pre-filled in
     * its composer. When provided AND one of those apps is detected in
     * `tools`, the guide renders a "Set up with Claude" / "Set up with
     * ChatGPT" button above its own Install button. The URL is a validated
     * `claude://` or `codex://` deep link built in the renderer from a
     * pinned prompt constant; no server-supplied text ever contributes.
     */
    onopenassistant?(assistant: AssistantId, url: string): Promise<InstallOutcome>;
    /** Optional HQ folder passed into `claude://code/new?folder=`. */
    hqFolder?: string;
    /** Re-check cadence while idle; tests shorten it. */
    recheckMs?: number;
  }

  let {
    tools,
    preferred = "claude",
    oninstall,
    onsignin,
    onstatus,
    oncancelsignin,
    oncontinue,
    onrefresh,
    downloadUrlFor,
    onopen,
    onopenassistant,
    hqFolder = "",
    recheckMs = SIGN_IN_RECHECK_MS,
  }: Props = $props();

  /**
   * Tools this guide installed itself. Counted as installed straight away:
   * the `tools` prop can lag a re-detect behind the install landing (a
   * Windows PATH refresh), and a retry must sign in, not install again.
   */
  let installedHere = $state<Record<CodingTool, boolean>>({ claude: false, codex: false });
  const installed = $derived<Record<CodingTool, boolean>>({
    claude: installedHere.claude || Boolean(tools?.claude_cli || tools?.claude_desktop),
    codex: installedHere.codex || Boolean(tools?.codex_cli || tools?.codex_desktop),
  });

  type Phase =
    | "idle"
    | "installing"
    | "signing-in"
    | "done"
    | "install-failed"
    | "signin-failed";

  let busy = $state(false);
  let phase = $state<Phase>("idle");
  let failureReason = $state<string | null>(null);
  let activeTool = $state<CodingTool>(preferred);
  let continuing = $state(false);
  let continueError = $state<string | null>(null);
  /** Ends the current sign-in wait (tool switch, start over, unmount). */
  let signInAbort: AbortController | null = null;
  let destroyed = false;

  const toolLabel = $derived(TOOL_LABEL[activeTool]);
  /**
   * "this Mac" / "this PC" / "this computer" - the plain-language name for
   * the host machine. Kept reactive: on `apps/sync`, `__HQ_HOST_OS__` is not
   * injected synchronously and the OS plugin lands a moment later, so a
   * Windows person's first render used to read "this computer" and never
   * update.
   */
  let hostNounValue = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNounValue = next)));
  const machinePhrase = $derived(`this ${hostNounValue}`);
  void thisComputerNoun;

  /** The picker is offered whenever the person is choosing, not mid-step. */
  const showPicker = $derived(
    phase === "idle" ||
      phase === "install-failed" ||
      phase === "signin-failed",
  );

  const primaryLabel = $derived.by(() => {
    if (phase === "installing") return `Installing ${toolLabel}…`;
    if (phase === "signing-in") return "Waiting for sign-in…";
    if (phase === "done") {
      if (!oncontinue) return "You're set";
      return continuing ? "Continuing…" : "Continue";
    }
    if (phase === "install-failed") return `Retry installing ${toolLabel}`;
    if (phase === "signin-failed") return `Try signing in again`;
    // Not yet installed → offer install; already installed but not confirmed
    // signed-in → offer sign-in.
    return installed[activeTool] ? SIGN_IN_BUTTON_LABEL[activeTool] : INSTALL_BUTTON_LABEL[activeTool];
  });

  const otherTool = $derived<CodingTool>(activeTool === "claude" ? "codex" : "claude");

  const lede = $derived.by(() => {
    if (tools === null && phase === "idle") return `Checking whether ${toolLabel} is on ${machinePhrase}…`;
    if (phase === "installing") {
      return `HQ is installing ${toolLabel}, then opens its sign-in page. This usually takes a minute or two. Leave this window open.`;
    }
    if (installed[activeTool] && phase === "idle") {
      return `${toolLabel} is installed. Sign in to finish. HQ opens ${toolLabel}'s own sign-in window; your password never comes to HQ.`;
    }
    if (phase === "signing-in") {
      return `Finish signing in to ${toolLabel} in your browser. HQ moves on by itself as soon as it's done.`;
    }
    if (phase === "install-failed") {
      return `HQ couldn't install ${toolLabel}. This is usually antivirus, a permission prompt HQ can't see, or being offline. You can download it yourself instead - one step.`;
    }
    if (phase === "signin-failed") {
      return `Sign-in did not finish. Try again, or choose ${TOOL_LABEL[otherTool]} instead.`;
    }
    if (phase === "done") {
      return `${toolLabel} is ready. HQ can finish setup now.`;
    }
    return `Setup needs a coding tool on ${machinePhrase}. HQ can install ${toolLabel} for you and walk you through signing in.`;
  });

  function abortSignIn(): void {
    signInAbort?.abort();
    signInAbort = null;
  }

  async function runInstall(): Promise<void> {
    if (busy) return;
    busy = true;
    failureReason = null;
    phase = "installing";
    const tool = activeTool;
    try {
      const outcome = await oninstall(tool);
      if (!outcome.ok) {
        failureReason = outcome.reason ?? `HQ couldn't finish installing ${TOOL_LABEL[tool]}.`;
        phase = "install-failed";
        return;
      }
      installedHere = { ...installedHere, [tool]: true };
      await onrefresh();
      if (destroyed) return;
      // A tool that was installed and signed in before (a reinstall) needs
      // no second sign-in.
      if (onstatus && (await safeStatus(tool))) {
        await reachDone(tool, true);
        return;
      }
    } finally {
      busy = false;
    }
    // Install and sign-in are one step: the sign-in page opens by itself.
    if (phase === "installing" && !destroyed) await runSignIn();
  }

  async function runSignIn(): Promise<void> {
    if (busy) return;
    busy = true;
    failureReason = null;
    phase = "signing-in";
    const tool = activeTool;
    abortSignIn();
    const controller = new AbortController();
    signInAbort = controller;
    try {
      const outcome = await onsignin(tool, { signal: controller.signal });
      // A newer attempt (start over, tool switch) or unmount owns the guide now.
      if (controller.signal.aborted || destroyed) return;
      if (!outcome.ok) {
        // The sign-in can finish just after HQ stopped waiting; one last
        // look before calling it a failure.
        if (onstatus && (await safeStatus(tool))) {
          await reachDone(tool, true);
          return;
        }
        failureReason = outcome.reason ?? `Sign-in did not complete.`;
        phase = "signin-failed";
        return;
      }
      await onrefresh();
      await reachDone(tool, true);
    } finally {
      if (signInAbort === controller) signInAbort = null;
      if (!controller.signal.aborted) busy = false;
    }
  }

  /**
   * "Open the sign-in page again": the browser tab got closed or lost. Stop
   * the host's pending sign-in and start a fresh one, which opens a new page.
   */
  async function restartSignIn(): Promise<void> {
    const tool = activeTool;
    abortSignIn();
    busy = false;
    await oncancelsignin?.(tool);
    await runSignIn();
  }

  async function safeStatus(tool: CodingTool): Promise<boolean> {
    if (!onstatus) return false;
    try {
      return await onstatus(tool);
    } catch {
      return false;
    }
  }

  /**
   * A tool is signed in. Show Continue; when the person just signed in here,
   * continue for them (they already said what they wanted by signing in).
   */
  async function reachDone(tool: CodingTool, autoContinue: boolean): Promise<void> {
    activeTool = tool;
    failureReason = null;
    phase = "done";
    stopRecheck();
    if (autoContinue && oncontinue) await runContinue();
  }

  async function runContinue(): Promise<void> {
    if (!oncontinue || continuing) return;
    continuing = true;
    continueError = null;
    try {
      await oncontinue();
    } catch (err) {
      console.warn("[hq-desktop] continue after sign-in failed:", err);
      continueError = "HQ couldn't continue just now. Click Continue to try again.";
    } finally {
      continuing = false;
    }
  }

  async function runPrimary(): Promise<void> {
    if (phase === "done") return void runContinue();
    // Retry states short-circuit back to the operation they failed on.
    if (phase === "install-failed") return void runInstall();
    // Install if the tool isn't here yet (install then signs in by itself),
    // otherwise sign in. Covers the fresh state and a failed sign-in alike.
    if (installed[activeTool]) return void runSignIn();
    return void runInstall();
  }

  /** Switch tools from the picker. Any half-done step starts over. */
  function chooseTool(tool: CodingTool): void {
    if (busy || tool === activeTool) return;
    activeTool = tool;
    failureReason = null;
    phase = "idle";
  }

  async function downloadManually(): Promise<void> {
    const url = downloadUrlFor(activeTool);
    if (!url) return;
    const outcome = onopen(url);
    if (outcome && typeof (outcome as Promise<unknown>).then === "function") {
      await outcome;
    }
  }

  // ── Auto-detect: an already signed-in tool skips straight to Continue ──
  let recheckTimer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;

  function stopRecheck(): void {
    clearTimeout(recheckTimer);
    recheckTimer = undefined;
  }

  function pageHidden(): boolean {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
  }

  /** Check every tool that is on this computer; the active one first. */
  async function checkSignedIn(): Promise<void> {
    if (!onstatus || checking || destroyed) return;
    if (phase === "done" || busy) return;
    checking = true;
    try {
      const order: CodingTool[] = [activeTool, ...CODING_TOOLS.filter((t) => t !== activeTool)];
      for (const tool of order) {
        if (tools !== null && !installed[tool] && tool !== activeTool) continue;
        if (await safeStatus(tool)) {
          // Something changed while asking (a click got there first).
          if (destroyed || busy || (phase as Phase) === "done") return;
          await reachDone(tool, false);
          return;
        }
      }
    } finally {
      checking = false;
    }
  }

  function scheduleRecheck(): void {
    stopRecheck();
    if (!onstatus || destroyed || phase === "done") return;
    recheckTimer = setTimeout(async () => {
      if (!pageHidden()) await checkSignedIn();
      scheduleRecheck();
    }, recheckMs);
  }

  function onVisibilityChange(): void {
    if (!pageHidden()) void checkSignedIn();
  }

  onMount(() => {
    if (!onstatus) return;
    void checkSignedIn();
    scheduleRecheck();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  onDestroy(() => {
    destroyed = true;
    stopRecheck();
    abortSignIn();
  });

  /** Only show the assistant-app panel when it has a button to offer. */
  const assistantChoicesAvailable = $derived(
    assistantOnlyChoices(resolveInstallChoices({ tools, tool: activeTool })).some(
      (choice) => choice.kind === "assistant",
    ),
  );
</script>

<div
  class="install-guide"
  data-testid="setup-install-guide"
  data-phase={phase}
  data-tool={activeTool}
  role="region"
  aria-label="Set up a coding tool"
>
  {#if showPicker}
    <div class="picker" role="radiogroup" aria-label="Coding tool" data-testid="setup-install-guide-picker">
      {#each CODING_TOOLS as tool (tool)}
        <button
          type="button"
          role="radio"
          class="pick"
          class:selected={tool === activeTool}
          aria-checked={tool === activeTool}
          disabled={busy}
          data-testid={`setup-install-guide-pick-${tool}`}
          onclick={() => chooseTool(tool)}
        >{TOOL_LABEL[tool]}</button>
      {/each}
    </div>
  {/if}

  <p class="lede" data-testid="setup-install-guide-lede" aria-live="polite">{lede}</p>

  {#if failureReason}
    <p class="error" role="alert" data-testid="setup-install-guide-error">{failureReason}</p>
  {/if}
  {#if continueError}
    <p class="error" role="alert" data-testid="setup-install-guide-continue-error">{continueError}</p>
  {/if}

  {#if onopenassistant && (phase === "idle" || phase === "install-failed") && !installed[activeTool] && tools && assistantChoicesAvailable}
    <!--
      Assistant-app buttons ("Set up with Claude" / "Set up with ChatGPT")
      when one of those apps is on this computer. Rendered only when there is
      at least one such app: with none, the panel was an empty box.
    -->
    <InstallChoice
      tool={activeTool}
      tools={tools}
      noun={hostNounValue}
      hqFolder={hqFolder}
      showDirectInstall={false}
      showRecheck={false}
      showLede={false}
      disabled={busy}
      onopenassistant={onopenassistant}
      oninstall={async (tool) => {
        const outcome = await oninstall(tool);
        if (outcome.ok) await onrefresh();
        return outcome;
      }}
      onrecheck={async () => { await onrefresh(); }}
    />
  {/if}

  <div class="actions">
    <button
      type="button"
      class="primary"
      class:go={phase === "done" && Boolean(oncontinue)}
      disabled={busy || continuing || (phase === "done" && !oncontinue)}
      onclick={() => void runPrimary()}
      data-testid="setup-install-guide-primary"
    >{primaryLabel}</button>

    {#if phase === "signing-in" && oncancelsignin}
      <button
        type="button"
        class="secondary"
        onclick={() => void restartSignIn()}
        data-testid="setup-install-guide-restart-signin"
      >Open the sign-in page again</button>
    {/if}

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
  .primary.go {
    background: var(--blue);
    color: var(--on-accent, #fff);
  }
  .picker {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    align-self: flex-start;
  }
  .pick {
    padding: 4px 10px;
    border: 0;
    border-radius: calc(var(--radius-sm) - 2px);
    background: transparent;
    color: var(--muted-2);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
  }
  .pick.selected {
    background: var(--surface-3, var(--border));
    color: var(--fg);
    font-weight: 600;
  }
  .pick:disabled {
    cursor: default;
  }
  .pick:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 1px;
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
