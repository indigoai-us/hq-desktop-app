<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { onDestroy } from "svelte";
  import {
    SIGN_IN_CONFIRM_LATE_MS,
    SIGN_IN_CONFIRM_SLOW_MS,
    signInConfirmMessage,
  } from "./waking-model.js";
  import {
    approvalExpired,
    approvalOpenUrl,
    brainApprovalLabel,
    type BrainApproval,
  } from "./bot-brain-approval.js";
  import { claudeCodeAnswer, submitClaudeCode as runClaudeCodeSubmit, type ClaudeCodeAnswer } from "./claude-code-submit.js";
  import { focusOnMount } from "../portal.js";

  interface Props {
    approval: BrainApproval;
    agentUid: string;
    name: string;
    /**
     * Open the sign-in page. Answering `false` says the page did not open
     * (a blocked window); nothing, or `true`, says it did.
     */
    openExternal?: ((url: string) => void | boolean | Promise<void | boolean>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    confirmSignIn: () => Promise<boolean>;
    restart?: (() => Promise<boolean>) | null;
    onnudge: () => void;
    onchecking?: (checking: boolean) => void;
  }

  let {
    approval,
    agentUid,
    name,
    openExternal = null,
    submitClaudeLoginCode = null,
    confirmSignIn,
    restart = null,
    onnudge,
    onchecking,
  }: Props = $props();

  let approvalOpened = $state(false);
  let codeCopied = $state(false);
  let codeCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  let signInCheckTimer: ReturnType<typeof setTimeout> | null = null;
  let claudeCode = $state("");
  let codeChecking = $state(false);
  /** The last submit ended without an advance; the button offers to try again. */
  let codeRetry = $state(false);
  /** Claude accepted the code in the field: a retry only checks again, it does not send it twice. */
  let codeAccepted = false;
  /** Set synchronously on the press, so a second press cannot send the code twice. */
  let codeInFlight = false;
  let destroyed = false;
  let actionBusy = $state(false);
  let actionMessage = $state("");

  const approvalAsk = $derived(
    approval.provider === "codex"
      ? "Sign in to Codex and paste this code when it asks."
      : approval.provider === "claude"
        ? "Sign in to Claude, then paste the code it gives you here."
        : `Sign in to Grok to approve ${name}.`,
  );

  function setChecking(value: boolean): void {
    codeChecking = value;
    onchecking?.(value);
  }

  /** Coming back from the browser is the usual sign that the sign-in is done. */
  function onWindowFocus(): void {
    if (approvalOpened) onnudge();
  }

  function confirmSignedIn(): void {
    actionMessage = signInConfirmMessage(0, brainApprovalLabel(approval.provider));
    onnudge();
    if (signInCheckTimer) clearTimeout(signInCheckTimer);
    // The machine's next heartbeat carries the sign-in, up to a minute or two
    // later: keep "checking" that long before asking the person to look again.
    const slow = () => {
      signInCheckTimer = null;
      actionMessage = signInConfirmMessage(SIGN_IN_CONFIRM_SLOW_MS, brainApprovalLabel(approval.provider));
      signInCheckTimer = setTimeout(() => {
        signInCheckTimer = null;
        actionMessage = signInConfirmMessage(SIGN_IN_CONFIRM_LATE_MS, brainApprovalLabel(approval.provider));
      }, SIGN_IN_CONFIRM_LATE_MS - SIGN_IN_CONFIRM_SLOW_MS);
    };
    signInCheckTimer = setTimeout(slow, SIGN_IN_CONFIRM_SLOW_MS);
  }

  async function copyCode(): Promise<void> {
    if (!approval.code) return;
    try {
      await navigator.clipboard?.writeText(approval.code);
      codeCopied = true;
      if (codeCopiedTimer) clearTimeout(codeCopiedTimer);
      codeCopiedTimer = setTimeout(() => { codeCopied = false; codeCopiedTimer = null; }, 2_000);
    } catch {
      actionMessage = "We couldn't copy the code. Select it and copy it yourself.";
    }
  }

  /**
   * Open the sign-in page, and for Codex put its code on the clipboard.
   *
   * Both are started inside the press, before anything is awaited: a window
   * opened or a clipboard written after an `await` is no longer the person's
   * own action, and the webview may block it. The button says the page is
   * open only when it did open.
   *
   * The clipboard is written here and by the Copy button, and nowhere else,
   * and it is never read: reading it outside a press makes the webview show
   * a paste prompt, so the code is not cleared from it afterwards.
   */
  async function openApproval(): Promise<void> {
    if (actionBusy) return;
    actionMessage = "";
    if (!openExternal) {
      actionMessage = "We couldn't open the sign-in page. Try again.";
      return;
    }
    actionBusy = true;
    const target = approval;
    let copying: Promise<unknown> | null = null;
    if (target.provider === "codex") {
      try {
        copying = Promise.resolve(navigator.clipboard?.writeText(target.code));
      } catch (error) {
        copying = Promise.reject(error);
      }
      // The answer is read below; a refusal must not go unhandled meanwhile.
      copying.catch((error: unknown) => {
        console.warn(
          "new-bot: clipboard write failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    let opening: Promise<void | boolean>;
    try {
      opening = Promise.resolve(openExternal(approvalOpenUrl(target)));
    } catch (error) {
      opening = Promise.reject(error);
    }
    try {
      const opened = await opening;
      if (opened === false) actionMessage = "We couldn't open the sign-in page. Try again.";
      else approvalOpened = true;
    } catch {
      actionMessage = "We couldn't open the sign-in page. Try again.";
    }
    if (copying && approvalOpened) {
      try {
        await copying;
      } catch {
        actionMessage = "Copy the code and paste it on the next page.";
      }
    }
    actionBusy = false;
  }

  function codeMessage(result: "rejected" | "invalid" | "failed" | "timeout"): string {
    if (result === "invalid") return "That doesn't look like a Claude code. Copy the code from Claude and paste it here.";
    if (result === "rejected") return "Claude didn't accept that code. Open Claude again for a new code, then paste it here.";
    if (result === "failed") return "We couldn't send that code. Try again.";
    return "We couldn't confirm your sign-in yet. Try again.";
  }

  async function submitClaudeCode(): Promise<void> {
    if (approval.provider !== "claude" || !submitClaudeLoginCode || codeInFlight || actionBusy) return;
    const code = claudeCode.trim();
    if (!code) {
      actionMessage = "Paste the code from Claude to continue.";
      return;
    }
    codeInFlight = true;
    setChecking(true);
    codeRetry = false;
    actionMessage = "Checking your sign-in.";
    const send = submitClaudeLoginCode;
    let lastAnswer: ClaudeCodeAnswer | null = null;
    try {
      const result = await runClaudeCodeSubmit({
        alreadyAccepted: codeAccepted,
        send: async () => {
          const answer = await send(agentUid, code);
          lastAnswer = claudeCodeAnswer(answer);
          if (lastAnswer === "accepted") codeAccepted = true;
          return answer;
        },
        confirm: confirmSignIn,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        cancelled: () => destroyed,
        // Outcome names only. The code is never logged.
        log: (event, detail) => console.info(`new-bot: ${event}`, detail),
      });
      if (destroyed) return;
      if (result === "signed-in") {
        claudeCode = "";
        codeAccepted = false;
        actionMessage = "";
        return;
      }
      if (result === "rejected" || result === "invalid") codeAccepted = false;
      // A code Claude or the server turned down is not offered again as it
      // is: the person edits the field and submits.
      codeRetry = result !== "rejected" && result !== "invalid";
      actionMessage = codeMessage(result);
    } catch (error) {
      console.warn("new-bot: claude code submit failed", error instanceof Error ? error.name : "unknown", lastAnswer ?? "none");
      if (!destroyed) {
        codeRetry = true;
        actionMessage = codeMessage("failed");
      }
    } finally {
      codeInFlight = false;
      setChecking(false);
    }
  }

  async function restartApproval(): Promise<void> {
    if (!restart || actionBusy || codeChecking) return;
    actionBusy = true;
    actionMessage = "";
    try {
      if (await restart()) {
        approvalOpened = false;
        claudeCode = "";
        return;
      }
      actionMessage = "We couldn't start a fresh approval. Try again.";
    } catch {
      actionMessage = "We couldn't start a fresh approval. Try again.";
    } finally {
      actionBusy = false;
    }
  }

  onDestroy(() => {
    destroyed = true;
    if (codeCopiedTimer) clearTimeout(codeCopiedTimer);
    if (signInCheckTimer) clearTimeout(signInCheckTimer);
    if (codeChecking) onchecking?.(false);
  });
</script>

<svelte:window onfocus={onWindowFocus} />

<div class="new-bot-approval" data-testid="new-bot-approval">
  {#if approvalExpired(approval)}
    <p class="new-bot-approval-ask" data-testid="new-bot-approval-expired">This approval link has expired.</p>
    <button
      type="button"
      class="new-bot-waking-action"
      data-testid="new-bot-approval-restart"
      disabled={!restart || actionBusy}
      onclick={() => void restartApproval()}
    ><RailIcon name="refresh" />{actionBusy ? "Starting again..." : "Start again"}</button>
  {:else}
    <p class="new-bot-approval-ask">{approvalAsk}</p>

    {#if approval.provider === "codex" && approval.code}
      <div class="new-bot-code">
        <span class="new-bot-code-label">Your one-time code</span>
        <div class="new-bot-code-row">
          <code class="new-bot-code-value" data-testid="new-bot-codex-code">{approval.code}</code>
          <button
            type="button"
            class="new-bot-code-copy"
            data-testid="new-bot-codex-copy"
            aria-label={codeCopied ? "Code copied" : "Copy code"}
            onclick={() => void copyCode()}
          >
            {#if codeCopied}
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" /></svg>
              <span>Copied</span>
            {:else}
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.3" /><path d="M10.5 3.5v-1h-8v8h1" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
              <span>Copy</span>
            {/if}
          </button>
        </div>
      </div>
    {/if}

    <div class="new-bot-approval-actions">
      <button
        type="button"
        class="new-bot-waking-action"
        data-testid="new-bot-approval-open"
        disabled={actionBusy || codeChecking}
        use:focusOnMount
        onclick={() => void openApproval()}
      ><RailIcon name="external" />{actionBusy
        ? "Opening..."
        : approvalOpened
          ? `Open ${brainApprovalLabel(approval.provider)} again`
          : `Continue with ${brainApprovalLabel(approval.provider)}`}</button>
      {#if approvalOpened && approval.provider !== "claude"}
        <button
          type="button"
          class="new-bot-waking-secondary"
          data-testid="new-bot-approval-done"
          onclick={confirmSignedIn}
        ><RailIcon name="check" />I've signed in</button>
      {/if}
    </div>

    {#if approval.provider === "claude" && approvalOpened}
      <label class="new-bot-create-label" for="new-bot-claude-code">Paste the code from Claude</label>
      <input
        id="new-bot-claude-code"
        class="new-bot-create-input"
        data-testid="new-bot-claude-code"
        value={claudeCode}
        disabled={actionBusy || codeChecking}
        autocomplete="off"
        oninput={(event) => {
          claudeCode = (event.currentTarget as HTMLInputElement).value;
          codeAccepted = false;
          codeRetry = false;
        }}
        onkeydown={(event) => { if (event.key === "Enter") { event.preventDefault(); void submitClaudeCode(); } }}
      />
      <button
        type="button"
        class="new-bot-waking-action"
        data-testid="new-bot-claude-submit"
        disabled={actionBusy || codeChecking || !submitClaudeLoginCode}
        aria-busy={codeChecking ? "true" : undefined}
        onclick={() => void submitClaudeCode()}
      ><RailIcon name={codeRetry ? "refresh" : "send"} />{codeChecking ? "Checking..." : codeRetry ? "Try again" : "Submit code"}</button>
    {/if}

    {#if approvalOpened && approval.provider !== "claude" && !actionMessage}
      <p class="new-bot-approval-note" data-testid="new-bot-approval-waiting">Waiting for {brainApprovalLabel(approval.provider)}. This moves on by itself when you finish there.</p>
    {/if}
  {/if}
  {#if actionMessage}
    <p class="new-bot-approval-note" data-testid="new-bot-approval-message" role="status">{actionMessage}</p>
  {/if}
</div>
