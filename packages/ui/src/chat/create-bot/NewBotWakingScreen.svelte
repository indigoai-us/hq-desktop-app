<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { onMount } from "svelte";
  import {
    applyWakingCheckFailure,
    applyWakingStatus,
    awaitingHello,
    recordWakingHello,
    markWakingHelloAsking,
    recordWakingHelloAsked,
    SIGN_IN_CONFIRM_LATE_MS,
    SIGN_IN_CONFIRM_SLOW_MS,
    signInConfirmMessage,
    wakingNudgeIntervalMs,
    wakingPollDelayMs,
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
    /**
     * Open the sign-in page. Answering `false` says the page did not open
     * (a blocked window); nothing, or `true`, says it did.
     */
    openExternal?: ((url: string) => void | boolean | Promise<void | boolean>) | null;
    /** Ask the bot, on the bot-only lane, to write its first message. Resolves true once sent. */
    sendHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    /** True once the bot's first message is in the direct message. */
    checkHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    onupdate: (session: WakingBotSession) => void;
    onclose: () => void;
    onretry: () => void;
    /** True while the host is asking the server to start the bot again. */
    retryBusy?: boolean;
    /** What the host says when the server would not start it again. */
    retryMessage?: string;
  }

  let {
    session,
    getStatus,
    retryAgent = null,
    restartBrainApproval = null,
    submitClaudeLoginCode = null,
    openExternal = null,
    sendHello = null,
    checkHello = null,
    onupdate,
    onclose,
    onretry,
    retryBusy = false,
    retryMessage = "",
  }: Props = $props();

  /** When this screen was opened. A person who opens it is watching, so the fast stretch of asking starts here. */
  const openedAt = Date.now();

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

  const dawnMode = $derived<DawnMode>(
    session.phase === "failed" || session.phase === "stopped"
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
    if (now - lastNudgeAt < (force ? 2_000 : wakingNudgeIntervalMs(session, now, openedAt))) return;
    lastNudgeAt = now;
    try {
      await retryAgent(session.agentUid);
    } catch {
      // The next interval asks again.
    }
  }

  /**
   * The bot can chat. Ask it for its first message (once), then look for that
   * message. A host that cannot do either hands the person over at once.
   */
  async function settleHello(current: WakingBotSession): Promise<WakingBotSession> {
    if (!awaitingHello(current)) return current;
    if (!sendHello || !checkHello || !current.agentUid) return recordWakingHello(current);
    let next = current;
    try {
      if (next.helloAskedAt == null) {
        // Written down before the request leaves. If this screen goes away
        // while it is out, the next one sends the same request under the
        // same key, and not a second request of its own.
        next = markWakingHelloAsking(next);
        onupdate(next);
        if (!(await sendHello(next))) return next;
        next = recordWakingHelloAsked(next);
      }
      if (await checkHello(next)) return recordWakingHello(next);
    } catch {
      // The next check asks again; the wait is bounded by the status check.
    }
    return next;
  }

  /** Coming back from the browser is the usual sign that the sign-in is done. */
  function onWindowFocus(): void {
    if (approvalOpened && approval) void nudge(true);
  }

  function confirmSignedIn(): void {
    if (!approval) return;
    actionMessage = signInConfirmMessage(0, brainApprovalLabel(approval.provider));
    void nudge(true);
    if (signInCheckTimer) clearTimeout(signInCheckTimer);
    // The machine's next heartbeat carries the sign-in, up to a minute or two
    // later: keep "checking" that long before asking the person to look again.
    const slow = () => {
      signInCheckTimer = null;
      if (!session.approval) return;
      actionMessage = signInConfirmMessage(SIGN_IN_CONFIRM_SLOW_MS, brainApprovalLabel(session.approval.provider));
      signInCheckTimer = setTimeout(() => {
        signInCheckTimer = null;
        if (session.approval) {
          actionMessage = signInConfirmMessage(SIGN_IN_CONFIRM_LATE_MS, brainApprovalLabel(session.approval.provider));
        }
      }, SIGN_IN_CONFIRM_LATE_MS - SIGN_IN_CONFIRM_SLOW_MS);
    };
    signInCheckTimer = setTimeout(slow, SIGN_IN_CONFIRM_SLOW_MS);
  }

  async function copyCode(): Promise<void> {
    if (!approval?.code) return;
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
    if (!approval || actionBusy) return;
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
      copying.catch(() => {});
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
    let checking = false;
    /** A read came due while the window was hidden. It runs when the window is shown again. */
    let waitingForVisible = false;

    function checkLater(ms: number): void {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void check();
      }, ms);
    }

    async function check(): Promise<void> {
      const checkedSession = session;
      // A bot that is ready, failed or stopped is not read again, and nothing
      // asks the server to re-check it.
      if (stopped || checking || !checkedSession || checkedSession.phase !== "waking") return;
      // Nobody is looking: ask nothing until the window is shown again.
      if (document.hidden) {
        waitingForVisible = true;
        return;
      }
      if (!getStatus || !checkedSession.agentUid) {
        checkLater(WAKING_POLL_MS);
        return;
      }
      checking = true;
      let latest = checkedSession;
      try {
        const result = await getStatus(checkedSession.agentUid, checkedSession.brain ?? undefined);
        if (stopped) return;
        const response = result as { ok?: unknown; value?: unknown };
        let next = response && response.ok === true
          ? applyWakingStatus(checkedSession, response.value)
          : applyWakingCheckFailure(checkedSession, result);
        next = await settleHello(next);
        if (stopped) return;
        if (checkedSession.approval && !next.approval) actionMessage = "";
        latest = next;
        onupdate(next);
        if (next.phase === "waking" && next.chatReadyAt == null) void nudge();
      } catch {
        if (stopped) return;
        latest = applyWakingCheckFailure(checkedSession, null);
        onupdate(latest);
      } finally {
        checking = false;
      }
      if (!stopped && latest.phase === "waking") checkLater(wakingPollDelayMs(latest, Date.now(), openedAt));
    }

    function onVisibility(): void {
      if (document.hidden || !waitingForVisible) return;
      waitingForVisible = false;
      void check();
    }
    document.addEventListener("visibilitychange", onVisibility);

    void check();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
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
          ><RailIcon name="send" />{actionBusy ? "Submitting..." : "Submit code"}</button>
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
    <button
      type="button"
      class="new-bot-waking-action"
      data-testid="new-bot-waking-retry"
      disabled={!retryAgent || retryBusy}
      aria-busy={retryBusy ? "true" : undefined}
      use:focusOnMount
      onclick={onretry}
    ><RailIcon name="refresh" />{retryBusy ? "Trying again..." : "Try again"}</button>
    {#if retryMessage}
      <p class="new-bot-approval-note" data-testid="new-bot-waking-retry-message" role="status">{retryMessage}</p>
    {/if}
  {/if}

  <!-- One way out. There is no chat to open until the bot is live; the screen
       opens it by itself at that point. -->
  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}>
    {session.phase === "failed" || session.phase === "stopped" ? "Close" : approval ? "Do this later" : "Close and keep working"}
  </button>
</section>
