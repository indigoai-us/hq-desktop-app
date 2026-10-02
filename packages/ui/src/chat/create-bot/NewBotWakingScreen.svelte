<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyWakingStatus,
    recordWakingCheckFailure,
    WAKING_NUDGE_MS,
    WAKING_POLL_MS,
    wakingStatusLine,
    type WakingBotSession,
  } from "./waking-model.js";
  import {
    approvalExpired,
    approvalOpenUrl,
    brainApprovalLabel,
    type BrainProvider,
  } from "./bot-brain-approval.js";
  import { focusOnMount } from "../portal.js";
  import NewBotDawn, { type DawnMode } from "./NewBotDawn.svelte";

  interface Props {
    session: WakingBotSession;
    getStatus: ((agentUid: string, brain?: BrainProvider) => Promise<unknown>) | null;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    restartBrainApproval?: ((agentUid: string, brain: BrainProvider) => Promise<unknown>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    openExternal?: ((url: string) => void | Promise<void>) | null;
    onupdate: (session: WakingBotSession) => void;
    onclose: () => void;
    onretry: () => void;
  }

  let {
    session,
    getStatus,
    retryAgent = null,
    restartBrainApproval = null,
    submitClaudeLoginCode = null,
    openExternal = null,
    onupdate,
    onclose,
    onretry,
  }: Props = $props();

  let approvalOpened = $state(false);
  let codeCopied = $state(false);
  let codeCopiedTimer: ReturnType<typeof setTimeout> | null = null;
  let signInCheckTimer: ReturnType<typeof setTimeout> | null = null;
  // The create request has just started the work; the first re-check waits a
  // full interval.
  let lastNudgeAt = Date.now();
  let claudeCode = $state("");
  let actionBusy = $state(false);
  let actionMessage = $state("");
  let copiedCodexCode = $state<string | null>(null);

  const dawnMode = $derived<DawnMode>(
    session.phase === "failed"
      ? "failed"
      : session.phase === "ready"
        ? "ready"
        : session.approval
          ? "waiting"
          : "waking",
  );
  const statusLine = $derived(wakingStatusLine(session));
  const approval = $derived(session.approval);
  const approvalAsk = $derived(
    !approval
      ? ""
      : approval.provider === "codex"
        ? "Sign in to Codex and paste this code when it asks."
        : approval.provider === "claude"
          ? "Sign in to Claude, then paste the code it gives you here."
          : `Sign in to Grok to approve ${session.name}.`,
  );

  /**
   * Ask the server to re-check the current setup step. Setup only advances on
   * such a request, so without it a finished sign-in sits unnoticed until the
   * server's own once-a-minute pass.
   */
  async function nudge(force = false): Promise<void> {
    if (!retryAgent || !session.agentUid || session.phase !== "waking") return;
    const now = Date.now();
    if (now - lastNudgeAt < (force ? 2_000 : WAKING_NUDGE_MS)) return;
    lastNudgeAt = now;
    try {
      await retryAgent(session.agentUid);
    } catch {
      // The next interval asks again.
    }
  }

  /** Coming back from the browser is the usual sign that the sign-in is done. */
  function onWindowFocus(): void {
    if (approvalOpened && approval) void nudge(true);
  }

  function confirmSignedIn(): void {
    if (!approval) return;
    actionMessage = "Checking your sign-in.";
    void nudge(true);
    if (signInCheckTimer) clearTimeout(signInCheckTimer);
    signInCheckTimer = setTimeout(() => {
      signInCheckTimer = null;
      if (session.approval) {
        actionMessage = `We don't see it yet. Finish signing in on the ${brainApprovalLabel(session.approval.provider)} page, then check again.`;
      }
    }, 20_000);
  }

  async function copyCode(): Promise<void> {
    if (!approval?.code) return;
    try {
      await navigator.clipboard?.writeText(approval.code);
      copiedCodexCode = approval.code;
      codeCopied = true;
      if (codeCopiedTimer) clearTimeout(codeCopiedTimer);
      codeCopiedTimer = setTimeout(() => { codeCopied = false; codeCopiedTimer = null; }, 2_000);
    } catch {
      actionMessage = "We couldn't copy the code. Select it and copy it yourself.";
    }
  }

  async function clearCopiedCodexCode(): Promise<void> {
    const code = copiedCodexCode;
    copiedCodexCode = null;
    if (!code) return;
    try {
      // Do not erase a newer value the person copied after opening the device page.
      if (await navigator.clipboard?.readText() === code) {
        await navigator.clipboard.writeText("");
      }
    } catch {
      // Clipboard access is best effort outside the button's user gesture.
    }
  }

  async function openApproval(): Promise<void> {
    if (!approval || actionBusy) return;
    actionBusy = true;
    actionMessage = "";
    try {
      if (approval.provider === "codex") {
        try {
          await navigator.clipboard?.writeText(approval.code);
          copiedCodexCode = approval.code;
        } catch {
          actionMessage = "Copy the code and paste it on the next page.";
        }
      }
      if (!openExternal) {
        actionMessage = "We couldn't open the sign-in page. Try again.";
        return;
      }
      await openExternal(approvalOpenUrl(approval));
      approvalOpened = true;
    } catch {
      actionMessage = "We couldn't open the sign-in page. Try again.";
    } finally {
      actionBusy = false;
    }
  }

  async function submitClaudeCode(): Promise<void> {
    if (!approval || approval.provider !== "claude" || !submitClaudeLoginCode || actionBusy) return;
    const code = claudeCode.trim();
    if (!code) {
      actionMessage = "Paste the code from Claude to continue.";
      return;
    }
    actionBusy = true;
    actionMessage = "";
    try {
      const result = await submitClaudeLoginCode(session.agentUid, code);
      if (!(result as { ok?: unknown } | null)?.ok) {
        actionMessage = "That code could not be submitted. Try again.";
        return;
      }
      claudeCode = "";
      actionMessage = "Checking your sign-in.";
    } catch {
      actionMessage = "That code could not be submitted. Try again.";
    } finally {
      actionBusy = false;
    }
  }

  async function restartApproval(): Promise<void> {
    if (!approval || !restartBrainApproval || actionBusy) return;
    actionBusy = true;
    actionMessage = "";
    try {
      const result = await restartBrainApproval(session.agentUid, approval.provider);
      const response = result as { ok?: unknown; value?: unknown } | null;
      if (response?.ok === true) {
        approvalOpened = false;
        claudeCode = "";
        onupdate(applyWakingStatus({ ...session, approval: null }, response.value));
        return;
      }
      actionMessage = "We couldn't start a fresh approval. Try again.";
    } catch {
      actionMessage = "We couldn't start a fresh approval. Try again.";
    } finally {
      actionBusy = false;
    }
  }

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check(): Promise<void> {
      const checkedSession = session;
      if (stopped || !checkedSession || checkedSession.phase !== "waking") return;
      if (!getStatus || !checkedSession.agentUid) {
        timer = setTimeout(() => void check(), WAKING_POLL_MS);
        return;
      }
      try {
        const result = await getStatus(checkedSession.agentUid, checkedSession.brain ?? undefined);
        if (stopped) return;
        const response = result as { ok?: unknown; value?: unknown };
        const next = response && response.ok === true
          ? applyWakingStatus(checkedSession, response.value)
          : recordWakingCheckFailure(checkedSession);
        if (next.phase === "ready") void clearCopiedCodexCode();
        if (checkedSession.approval && !next.approval) actionMessage = "";
        onupdate(next);
        if (next.phase === "waking") void nudge();
      } catch {
        if (!stopped) onupdate(recordWakingCheckFailure(checkedSession));
      }
      if (!stopped && checkedSession.phase === "waking") timer = setTimeout(() => void check(), WAKING_POLL_MS);
    }

    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (codeCopiedTimer) clearTimeout(codeCopiedTimer);
      if (signInCheckTimer) clearTimeout(signInCheckTimer);
    };
  });
</script>

<svelte:window onfocus={onWindowFocus} />

<section class="new-bot-waking" data-testid="new-bot-waking-screen">
  <NewBotDawn
    progress={session.progress}
    mode={dawnMode}
    label={`Waking up ${session.name}`}
  />
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Waking up <em>{session.name}</em></h1>
  <p
    class="new-bot-waking-status"
    data-testid="new-bot-waking-status"
    aria-live="polite"
    aria-atomic="true"
  >{statusLine}</p>

  {#if approval && session.phase === "waking"}
    <div class="new-bot-approval" data-testid="new-bot-approval">
      {#if approvalExpired(approval)}
        <p class="new-bot-approval-ask" data-testid="new-bot-approval-expired">This approval link has expired.</p>
        <button
          type="button"
          class="new-bot-waking-action"
          data-testid="new-bot-approval-restart"
          disabled={!restartBrainApproval || actionBusy}
          onclick={() => void restartApproval()}
        >{actionBusy ? "Starting again..." : "Start again"}</button>
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
            disabled={actionBusy}
            use:focusOnMount
            onclick={() => void openApproval()}
          >{actionBusy
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
            >I've signed in</button>
          {/if}
        </div>

        {#if approval.provider === "claude" && approvalOpened}
          <label class="new-bot-create-label" for="new-bot-claude-code">Paste the code from Claude</label>
          <input
            id="new-bot-claude-code"
            class="new-bot-create-input"
            data-testid="new-bot-claude-code"
            value={claudeCode}
            disabled={actionBusy}
            autocomplete="off"
            oninput={(event) => { claudeCode = (event.currentTarget as HTMLInputElement).value; }}
          />
          <button
            type="button"
            class="new-bot-waking-action"
            data-testid="new-bot-claude-submit"
            disabled={actionBusy || !submitClaudeLoginCode}
            onclick={() => void submitClaudeCode()}
          >{actionBusy ? "Submitting..." : "Submit code"}</button>
        {/if}

        {#if approvalOpened && approval.provider !== "claude" && !actionMessage}
          <p class="new-bot-approval-note" data-testid="new-bot-approval-waiting">Waiting for {brainApprovalLabel(approval.provider)}. This moves on by itself when you finish there.</p>
        {/if}
      {/if}
      {#if actionMessage}
        <p class="new-bot-approval-note" data-testid="new-bot-approval-message">{actionMessage}</p>
      {/if}
    </div>
  {/if}

  {#if session.phase === "failed"}
    <button type="button" class="new-bot-waking-action" data-testid="new-bot-waking-retry" disabled={!retryAgent} use:focusOnMount onclick={onretry}>Try again</button>
  {/if}

  <!-- One way out. There is no chat to open until the bot is live; the screen
       opens it by itself at that point. -->
  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}>
    {session.phase === "failed" ? "Close" : approval ? "Do this later" : "Close and keep working"}
  </button>
</section>
