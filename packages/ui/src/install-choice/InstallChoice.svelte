<script lang="ts">
  /**
   * InstallChoice — one shared panel for the two places HQ hits a person who
   * has no coding tool on this computer: the New bot wizard's Home step and
   * the setup assistant's SetupIncompleteCard. Both places import THIS
   * component so they cannot drift.
   *
   * Behaviour, in the operator's words: "instead of using terminal commands,
   * have a button to open Claude Desktop or ChatGPT to run a prompt that
   * installs it." When one of the assistant desktop apps is on this
   * computer, the panel offers that button first. When neither is here (or
   * detection is still probing), the panel falls back to HQ's existing
   * one-click install so the panel never dead-ends.
   *
   * Pure UI: every side effect goes through props. Tests mount this
   * component directly and inject fakes.
   */
  import {
    installFailedPanelLede,
    installPanelLede,
    installingPanelLede,
    installSucceededPanelLede,
    resolveInstallChoices,
    type AiTools,
    type AssistantId,
    type CodingTool,
    type InstallChoice,
    type InstallOutcome,
  } from "./install-choice.js";

  export type {
    AssistantId,
    CodingTool,
    InstallChoice,
    InstallOutcome,
  } from "./install-choice.js";

  interface Props {
    /**
     * Which coding tool this person needs on this computer (the wizard hands
     * `claude` for a "Claude Code · not installed" chip; the setup assistant
     * hands whatever tool it prefers).
     */
    tool: CodingTool;
    /**
     * The assistant apps HQ detected on this computer. `null` while
     * `detect_ai_tools` is still resolving — the panel renders a neutral
     * "Checking…" line and no buttons.
     */
    tools: AiTools | null;
    /**
     * `hostComputerNoun` — "Mac", "PC", or "computer". Never say "Mac" on
     * Windows; the neutral fallback covers a probe that has not landed.
     */
    noun: string;
    /**
     * Optional HQ folder path. When set, the `claude://code/new` link
     * includes it as `folder=` so Claude Code opens in the right place.
     */
    hqFolder?: string;
    /**
     * Open one of the assistant apps with the install prompt pre-filled.
     * The URL is already a fixed `claude://` or `codex://` deep link; the
     * host dispatches through its scheme-scoped Tauri command. Returns
     * `{ ok: false, reason }` when the dispatcher itself failed, so the
     * panel can surface a plain-language error rather than a silent no-op.
     */
    onopenassistant(assistant: AssistantId, url: string): Promise<InstallOutcome>;
    /**
     * Run HQ's own one-click install for the coding tool. This is the
     * fallback when no assistant app is here (or the person picked it
     * explicitly).
     */
    oninstall(tool: CodingTool): Promise<InstallOutcome>;
    /**
     * Re-run detection (`detect_ai_tools` on the host). Present so the
     * panel keeps a direct retry alongside any assisted-recovery buttons
     * (repo policy `hq-desktop-app-failed-state-assisted-recovery-preserve-retry`).
     */
    onrecheck(): Promise<void>;
    /**
     * `searched` directories from the `notInstalled` runtime status. Kept
     * behind a `<details>` so the panel reads plain but a support call can
     * still see where HQ looked.
     */
    searched?: readonly string[];
    /** Disable every action (parent is transitioning). */
    disabled?: boolean;
    /**
     * Hide the direct-install fallback button. Used when the panel is
     * embedded above a caller that renders its OWN Install button
     * (SetupInstallGuide) so the two don't duplicate. Default true — the
     * standalone wizard use offers the fallback in the panel itself.
     */
    showDirectInstall?: boolean;
    /** Hide the "Check again" button — used when a parent already has one. */
    showRecheck?: boolean;
    /** Hide the lede sentence. Used when the caller has its own headline. */
    showLede?: boolean;
  }

  let {
    tool,
    tools,
    noun,
    hqFolder = "",
    onopenassistant,
    oninstall,
    onrecheck,
    searched,
    disabled = false,
    showDirectInstall = true,
    showRecheck = true,
    showLede = true,
  }: Props = $props();

  const choices = $derived<InstallChoice[]>(
    resolveInstallChoices({ tools, tool, hqFolder: hqFolder || undefined }).filter(
      (c) => showDirectInstall || c.kind !== "direct-install",
    ),
  );
  const lede = $derived(installPanelLede(noun));

  let busy = $state(false);
  let error = $state<string | null>(null);
  let rechecking = $state(false);
  /**
   * Where the install action is in its lifecycle.
   *
   *   idle      → the person has not clicked Install yet, or has cleared the
   *               last try; the panel reads its default lede.
   *   installing→ the Rust installer is running. The Windows test persona
   *               watched a bare "Working…" for 30-40 s and concluded nothing
   *               was happening, so this state now surfaces plain-language
   *               progress and an approximate wait time.
   *   installed → the installer resolved OK. HQ has kicked its own re-check;
   *               once the parent's runtime status flips (`notInstalled` →
   *               `signedOut`), the whole panel unmounts. Until then the
   *               person reads a plain "installed, checking sign-in…" line
   *               instead of the panel snapping back to its original state.
   *   failed    → the installer returned an error. `error` carries a plain
   *               reason; the install button + Check again both stay visible
   *               (repo policy `hq-desktop-app-failed-state-assisted-recovery-preserve-retry`).
   */
  type InstallPhase = "idle" | "installing" | "installed" | "failed";
  let installPhase = $state<InstallPhase>("idle");
  let installTool = $state<CodingTool>("claude");
  const installStatusLede = $derived(
    installPhase === "installing"
      ? installingPanelLede(installTool, noun)
      : installPhase === "installed"
        ? installSucceededPanelLede(installTool)
        : null,
  );

  async function openAssistant(
    assistant: AssistantId,
    url: string,
  ): Promise<void> {
    if (busy || disabled) return;
    busy = true;
    error = null;
    try {
      const outcome = await onopenassistant(assistant, url);
      if (!outcome.ok) {
        error =
          outcome.reason ??
          (assistant === "claude-desktop"
            ? "HQ could not open Claude on this computer."
            : "HQ could not open ChatGPT on this computer.");
      }
    } finally {
      busy = false;
    }
  }

  async function runInstall(chosenTool: CodingTool): Promise<void> {
    if (busy || disabled) return;
    busy = true;
    error = null;
    installTool = chosenTool;
    installPhase = "installing";
    try {
      const outcome = await oninstall(chosenTool);
      if (!outcome.ok) {
        // The install command failed. Prefer the adapter's plain reason;
        // fall back to a generic sentence rather than exposing a raw Rust
        // string that could contain a path or an exit code.
        error = outcome.reason ?? installFailedPanelLede(chosenTool);
        installPhase = "failed";
        return;
      }
      installPhase = "installed";
      // Auto-recheck: the parent listens for its runtime-status probe to
      // update, and once that lands (`notInstalled` → `signedOut`) the panel
      // unmounts. Without this, the Windows persona had to click "Check
      // again" to discover that the install had, in fact, worked — the
      // failure mode the follow-up is asked to eliminate. Swallow errors so
      // an unavailable probe never leaves the panel wedged; the person can
      // still click Check again manually.
      try {
        await onrecheck();
      } catch (probeErr) {
        console.warn("[hq-desktop] auto re-check after install failed", probeErr);
      }
    } finally {
      busy = false;
    }
  }

  async function recheck(): Promise<void> {
    if (rechecking || disabled) return;
    rechecking = true;
    try {
      await onrecheck();
    } finally {
      rechecking = false;
    }
  }

  const dedupedSearched = $derived.by(() => {
    if (!searched || searched.length === 0) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const dir of searched) {
      if (typeof dir !== "string") continue;
      const trimmed = dir.replace(/[\\/]$/, "");
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
    return out;
  });
</script>

<div
  class="install-choice"
  data-testid="install-choice-panel"
  data-tool={tool}
  role="region"
  aria-label="Set up a coding tool on this computer"
>
  {#if showLede}
    <p class="lede" data-testid="install-choice-lede">{lede}</p>
  {/if}

  {#if installStatusLede}
    <!--
      Plain-language progress for the direct-install path. Shown ABOVE the
      buttons so a person who clicked "Install Claude Code" reads "Installing…
      about a minute" instead of the bare "Working…" the Windows persona saw.
      Once the install lands, this flips to the "installed, checking sign-in"
      line until the parent's runtime status flips and the whole panel
      unmounts.
    -->
    <p
      class="status"
      role="status"
      aria-live="polite"
      data-testid="install-choice-status"
      data-phase={installPhase}
    >{installStatusLede}</p>
  {/if}

  {#if error}
    <p class="error" role="alert" data-testid="install-choice-error">{error}</p>
  {/if}

  <div class="actions">
    {#each choices as choice, index (choice.kind === "assistant" ? `a-${choice.assistant}` : choice.kind === "direct-install" ? `d-${choice.tool}` : "probing")}
      {#if choice.kind === "probing"}
        <p
          class="probing"
          data-testid="install-choice-probing"
        >Checking whether Claude or ChatGPT is on this {noun.trim() || "computer"}…</p>
      {:else if choice.kind === "assistant"}
        <button
          type="button"
          class="btn"
          class:primary={index === 0}
          disabled={busy || disabled}
          data-testid={choice.assistant === "claude-desktop" ? "install-choice-open-claude" : "install-choice-open-chatgpt"}
          data-assistant={choice.assistant}
          data-deep-link={choice.deepLink}
          onclick={() => void openAssistant(choice.assistant, choice.deepLink)}
        >{busy ? "Opening…" : choice.buttonLabel}</button>
      {:else}
        <button
          type="button"
          class="btn"
          class:primary={index === 0}
          disabled={busy || disabled}
          data-testid={choice.tool === "claude" ? "install-choice-install-claude" : "install-choice-install-codex"}
          data-tool={choice.tool}
          onclick={() => void runInstall(choice.tool)}
        >{
          busy && installPhase === "installing"
            ? "Installing…"
            : busy && installPhase === "installed"
              ? "Checking…"
              : busy
                ? "Working…"
                : choice.buttonLabel
        }</button>
      {/if}
    {/each}

    {#if showRecheck}
      <button
        type="button"
        class="btn ghost"
        disabled={rechecking || disabled}
        data-testid="install-choice-recheck"
        onclick={() => void recheck()}
      >{rechecking ? "Checking…" : "Check again"}</button>
    {/if}
  </div>

  {#if dedupedSearched.length > 0}
    <!--
      Kept for support only, per the operator direction: the plain-text
      wording never shows a file path, but a "Where HQ looked" details block
      may stay for a support call. Dedupe again at render time so a repeated
      key can never crash the app (see the runtime-status crash regression).
    -->
    <details class="searched" data-testid="install-choice-searched">
      <summary>Where HQ looked</summary>
      <ul>
        {#each dedupedSearched as dir (dir)}
          <li>{dir}</li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .install-choice {
    display: flex;
    flex-direction: column;
    gap: var(--space-2, 8px);
    padding: var(--space-3, 12px);
    border: 1px solid var(--border);
    border-radius: var(--radius-md, 8px);
    background: var(--surface-2, transparent);
  }
  .lede {
    margin: 0;
    color: var(--muted-2, currentColor);
    font-size: var(--text-base, 14px);
    line-height: 1.4;
  }
  .status {
    margin: 0;
    color: var(--fg, currentColor);
    font-size: var(--text-base, 14px);
    line-height: 1.4;
  }
  .error {
    margin: 0;
    color: var(--red, #e5484d);
    font-size: var(--text-base, 14px);
  }
  .probing {
    margin: 0;
    color: var(--muted-2, currentColor);
    font-size: var(--text-base, 14px);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2, 8px);
  }
  .btn {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 6px);
    background: transparent;
    color: var(--muted-2, currentColor);
    font: inherit;
    font-size: var(--text-base, 14px);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--border-strong, currentColor);
    background: var(--row-hover, transparent);
    color: var(--fg, currentColor);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn.primary {
    border-color: var(--blue, #2f6feb);
    color: var(--fg, currentColor);
  }
  .btn.ghost {
    border-color: transparent;
  }
  .btn:focus-visible {
    outline: 2px solid var(--blue, #2f6feb);
    outline-offset: 2px;
  }
  .searched {
    margin-top: 4px;
    color: var(--muted-2, currentColor);
    font-size: var(--text-base, 14px);
  }
  .searched summary {
    cursor: pointer;
  }
  .searched ul {
    margin: 4px 0 0;
    padding-left: 18px;
    line-height: 1.5;
  }
</style>
