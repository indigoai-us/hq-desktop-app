<script lang="ts">
  /**
   * The coding tools screen while no tool is signed in: one row per tool
   * (Claude Code and Codex), the preferred one first, each with one action.
   * Sign in runs the tool's own browser login through the host and reads
   * readiness again when it ends. The rules and copy live in tools-signin.ts;
   * this file renders them. It has no live region of its own: what it says
   * goes to the takeover's one region through `onannounce`.
   */
  import { onDestroy, untrack } from "svelte";
  import type { RuntimeSignInApi } from "../create-bot/RuntimeSignIn.svelte";
  import {
    buildChatGptCodexInstallUrl,
    buildClaudeDesktopInstallUrl,
    INSTALL_VIA_CHATGPT_PROMPT,
    INSTALL_VIA_CLAUDE_PROMPT,
    type AssistantId,
    type CodingTool,
    type InstallOutcome,
  } from "../../install-choice/install-choice.js";
  import {
    TOOL_LABEL,
    TOOL_SIGNIN_COPY,
    createToolSignInRunner,
    orderedSignInTools,
    toolRowAction,
    toolRowNote,
    type SignInTool,
    type ToolRowKind,
    type ToolSignInState,
  } from "./tools-signin.js";

  interface Props {
    kinds: Record<SignInTool, ToolRowKind>;
    preferred: SignInTool;
    noun: string;
    signInApi: RuntimeSignInApi | null;
    pollMs?: number;
    openTimeoutMs?: number;
    hqFolderPath?: string;
    /** A tool is the one the person is signing in to: it becomes the pick. */
    onpick: (tool: SignInTool) => void;
    /** The tool said it is signed in: the host reads readiness again. */
    onsignedin: (tool: SignInTool) => void | Promise<void>;
    /** Read readiness (and the desktop apps) again. */
    onrecheck: () => void | Promise<void>;
    onopenassistant?: (assistant: AssistantId, url: string) => Promise<InstallOutcome>;
    onassistedinstall?: (tool: CodingTool) => Promise<InstallOutcome>;
    onannounce?: (text: string) => void;
  }

  let {
    kinds,
    preferred,
    noun,
    signInApi,
    pollMs = 1500,
    openTimeoutMs,
    hqFolderPath = "",
    onpick,
    onsignedin,
    onrecheck,
    onopenassistant,
    onassistedinstall,
    onannounce,
  }: Props = $props();

  const order = $derived(orderedSignInTools(preferred));

  let signIn = $state<ToolSignInState | null>(null);
  const runner = untrack(() =>
    signInApi
      ? createToolSignInRunner({
          api: signInApi,
          pollMs,
          openTimeoutMs,
          onchange: (next) => {
            signIn = next;
            announce(next);
          },
          onconnected: (tool) => onsignedin(tool),
          onfailed: () => onrecheck(),
        })
      : null,
  );
  onDestroy(() => runner?.dispose());

  function announce(next: ToolSignInState | null): void {
    if (!next) return onannounce?.("");
    const label = TOOL_LABEL[next.tool];
    onannounce?.(
      next.phase === "opening"
        ? TOOL_SIGNIN_COPY.opening
        : next.phase === "waiting"
          ? TOOL_SIGNIN_COPY.waiting
          : next.phase === "connected"
            ? `${label} is signed in.`
            : `Sign in to ${label} did not finish.`,
    );
  }

  /** Open a desktop app or install: per row, what happened after the press. */
  type Extra = "opening" | "opened" | "openFailed" | "installing" | "installFailed";
  let extra = $state<Record<SignInTool, Extra | null>>({ claude: null, codex: null });
  let rechecking = $state(false);

  const busy = $derived(
    signIn?.phase === "opening" ||
      signIn?.phase === "waiting" ||
      Object.values(extra).some((value) => value === "opening" || value === "installing"),
  );

  function startSignIn(tool: SignInTool): void {
    if (!runner || busy) return;
    onpick(tool);
    runner.start(tool);
  }

  async function recheck(): Promise<void> {
    if (rechecking) return;
    rechecking = true;
    try {
      await onrecheck();
    } finally {
      rechecking = false;
    }
  }

  async function openDesktop(tool: SignInTool): Promise<void> {
    if (!onopenassistant || busy) return;
    extra = { ...extra, [tool]: "opening" };
    const url =
      tool === "claude"
        ? buildClaudeDesktopInstallUrl({ prompt: INSTALL_VIA_CLAUDE_PROMPT, folder: hqFolderPath || undefined })
        : buildChatGptCodexInstallUrl({ prompt: INSTALL_VIA_CHATGPT_PROMPT });
    let outcome: InstallOutcome;
    try {
      outcome = await onopenassistant(tool === "claude" ? "claude-desktop" : "chatgpt-desktop", url);
    } catch (error) {
      console.warn("[first-run] opening the desktop app failed:", error);
      outcome = { ok: false };
    }
    extra = { ...extra, [tool]: outcome.ok ? "opened" : "openFailed" };
  }

  async function install(tool: SignInTool): Promise<void> {
    if (!onassistedinstall || busy) return;
    onpick(tool);
    extra = { ...extra, [tool]: "installing" };
    onannounce?.(TOOL_SIGNIN_COPY.installing(tool, noun));
    let outcome: InstallOutcome;
    try {
      outcome = await onassistedinstall(tool);
    } catch (error) {
      console.warn("[first-run] install failed:", error);
      outcome = { ok: false };
    }
    extra = { ...extra, [tool]: outcome.ok ? null : "installFailed" };
    onannounce?.(outcome.ok ? "" : TOOL_SIGNIN_COPY.installFailed);
    await recheck();
  }

  function press(tool: SignInTool, kind: ToolRowKind): void {
    if (kind === "signIn") startSignIn(tool);
    else if (kind === "openDesktop") void openDesktop(tool);
    else if (kind === "install") void install(tool);
    else if (kind === "recheck") void recheck();
  }

  /** Whether the row's own action can run on this host. */
  function canPress(kind: ToolRowKind): boolean {
    if (kind === "signIn") return !!runner;
    if (kind === "openDesktop") return !!onopenassistant;
    if (kind === "install") return !!onassistedinstall;
    return kind === "recheck";
  }
</script>

<ul class="first-run-tools" data-testid="first-run-tools-signin">
  {#each order as tool, index (tool)}
    {@const kind = kinds[tool]}
    {@const mine = signIn?.tool === tool ? signIn : null}
    {@const after = extra[tool]}
    <li
      class="first-run-tool"
      class:lead={index === 0}
      data-testid={`first-run-tool-${tool}`}
      data-kind={kind}
      data-phase={mine?.phase ?? after ?? "idle"}
    >
      <span class="first-run-tool-text">
        <span class="first-run-tool-name">{TOOL_LABEL[tool]}</span>
        <span class="first-run-tool-note" data-testid={`first-run-tool-${tool}-note`}>
          {#if mine?.phase === "opening"}{TOOL_SIGNIN_COPY.opening}
          {:else if mine?.phase === "waiting"}{TOOL_SIGNIN_COPY.waiting}
          {:else if mine?.phase === "connected"}{TOOL_SIGNIN_COPY.connected}
          {:else if mine?.phase === "failed"}{TOOL_SIGNIN_COPY.failed}
          {:else if after === "installing"}{TOOL_SIGNIN_COPY.installing(tool, noun)}
          {:else if after === "installFailed"}{TOOL_SIGNIN_COPY.installFailed}
          {:else if after === "openFailed"}{TOOL_SIGNIN_COPY.openFailed(tool)}
          {:else if after === "opened" && kind === "openDesktop"}{TOOL_SIGNIN_COPY.opened(tool)}
          {:else}{toolRowNote(tool, kind, noun)}{/if}
        </span>
      </span>
      {#if mine?.phase === "waiting"}
        <button
          type="button"
          class="first-run-tool-action quiet"
          data-testid={`first-run-tool-${tool}-cancel`}
          onclick={() => runner?.cancel()}
        >{TOOL_SIGNIN_COPY.cancel}</button>
      {:else if mine?.phase === "failed"}
        <button
          type="button"
          class="first-run-tool-action"
          data-testid={`first-run-tool-${tool}-retry`}
          disabled={busy}
          onclick={() => startSignIn(tool)}
        >{TOOL_SIGNIN_COPY.retry}</button>
      {:else if mine?.phase === "opening" || mine?.phase === "connected" || after === "installing" || after === "opening"}
        <!-- Running: the line says what is happening. -->
      {:else if after === "installFailed"}
        <button type="button" class="first-run-tool-action" data-testid={`first-run-tool-${tool}-retry`} disabled={busy} onclick={() => void install(tool)}>{TOOL_SIGNIN_COPY.retry}</button>
      {:else if after === "openFailed"}
        <button type="button" class="first-run-tool-action" data-testid={`first-run-tool-${tool}-retry`} disabled={busy} onclick={() => void openDesktop(tool)}>{TOOL_SIGNIN_COPY.retry}</button>
      {:else if after === "opened" && kind === "openDesktop"}
        <button type="button" class="first-run-tool-action" data-testid={`first-run-tool-${tool}-recheck`} disabled={rechecking} aria-busy={rechecking ? "true" : undefined} onclick={() => void recheck()}>{rechecking ? TOOL_SIGNIN_COPY.checking : "Check again"}</button>
      {:else if toolRowAction(tool, kind) && canPress(kind)}
        <button
          type="button"
          class="first-run-tool-action"
          class:primary={index === 0}
          data-testid={`first-run-tool-${tool}-${kind === "signIn" ? "signin" : kind}`}
          disabled={busy || (kind === "recheck" && rechecking)}
          aria-busy={kind === "recheck" && rechecking ? "true" : undefined}
          onclick={() => press(tool, kind)}
        >{kind === "recheck" && rechecking ? TOOL_SIGNIN_COPY.checking : toolRowAction(tool, kind)}</button>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .first-run-tools {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .first-run-tool {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    min-height: 58px;
    border: 1px solid var(--new-bot-line);
    border-radius: 12px;
    padding: 10px 14px;
    background: rgba(9, 9, 11, 0.36);
  }
  .first-run-tool.lead {
    background: rgba(255, 255, 255, 0.1);
  }
  .first-run-tool-text {
    display: grid;
    flex: 1 1 auto;
    gap: 2px;
    min-width: 0;
  }
  .first-run-tool-name {
    font-size: 14px;
    font-weight: 500;
  }
  .first-run-tool-note {
    color: var(--new-bot-muted);
    font-size: 12px;
    line-height: 1.4;
  }
  .first-run-tool-action {
    flex: 0 0 auto;
    border: 1px solid var(--new-bot-line);
    border-radius: 999px;
    padding: 6px 13px;
    background: rgba(255, 255, 255, 0.08);
    color: var(--new-bot-ink);
    font: inherit;
    font-size: 12.5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .first-run-tool-action.primary {
    border-color: transparent;
    background: var(--new-bot-ink, #fff);
    color: #09090b;
    font-weight: 500;
  }
  .first-run-tool-action.quiet {
    border-color: transparent;
    background: transparent;
    color: var(--new-bot-muted);
  }
  .first-run-tool-action:disabled {
    cursor: default;
    opacity: 0.6;
  }
  .first-run-tool-action:focus-visible {
    outline: 1px solid var(--new-bot-ink);
    outline-offset: 2px;
  }
</style>
