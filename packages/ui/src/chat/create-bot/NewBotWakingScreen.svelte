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
    wakingNudgeIntervalMs,
    wakingPollDelayMs,
    WAKING_POLL_MS,
    wakingStatusLine,
    type WakingBotSession,
  } from "./waking-model.js";
  import type { BrainProvider } from "./bot-brain-approval.js";
  import BrainSignInStep from "./BrainSignInStep.svelte";
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

  // The create request has just started the work; the first re-check waits a
  // full interval.
  let lastNudgeAt = Date.now();
  let codeChecking = false;
  /** When the server was last asked to re-check during a code submit. */
  let codeRecheckAt = 0;
  let destroyed = false;
  /**
   * Counts the status reads a code submit applied. A scheduled read that
   * started before one of them is older, and is dropped when it lands.
   */
  let submitReads = 0;

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

  /** How often a code submit asks the server to re-check while it waits. */
  const CODE_RECHECK_EVERY_MS = 9_000;

  function onCodeChecking(checking: boolean): void {
    codeChecking = checking;
    if (checking) codeRecheckAt = 0;
  }

  /**
   * Ask the server to re-check the sign-in step and read the status once.
   * True once the sign-in is seen done, or the screen has moved on.
   */
  async function confirmClaudeSignIn(): Promise<boolean> {
    const current = session;
    if (current.phase !== "waking" || !current.approval) return true;
    const now = Date.now();
    if (retryAgent && current.agentUid && now - codeRecheckAt >= CODE_RECHECK_EVERY_MS) {
      codeRecheckAt = now;
      lastNudgeAt = now;
      try {
        await retryAgent(current.agentUid);
      } catch {
        // The status read below still runs.
      }
    }
    if (!getStatus || !current.agentUid || destroyed) return false;
    try {
      const result = await getStatus(current.agentUid, current.brain ?? undefined);
      const response = result as { ok?: unknown; value?: unknown } | null;
      if (destroyed || response?.ok !== true) return false;
      const next = applyWakingStatus(session, response.value);
      submitReads += 1;
      onupdate(next);
      return next.phase !== "waking" || !next.approval || next.signedInAt != null;
    } catch {
      return false;
    }
  }

  async function restartApproval(): Promise<boolean> {
    if (!approval || !restartBrainApproval) return false;
    const result = await restartBrainApproval(session.agentUid, approval.provider);
    const response = result as { ok?: unknown; value?: unknown } | null;
    if (response?.ok !== true) return false;
    onupdate(applyWakingStatus({ ...session, approval: null }, response.value));
    return true;
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
      // A Claude code submit reads the status itself while it checks. Two
      // reads in flight could land out of order, and the older one would
      // overwrite the newer, so this one waits its turn.
      if (codeChecking) {
        checkLater(WAKING_POLL_MS);
        return;
      }
      checking = true;
      const readsBefore = submitReads;
      let latest = checkedSession;
      try {
        const result = await getStatus(checkedSession.agentUid, checkedSession.brain ?? undefined);
        if (stopped) return;
        // A code submit is checking, or applied a read while this one was out:
        // its reads are newer.
        if (codeChecking || submitReads !== readsBefore) {
          checkLater(WAKING_POLL_MS);
          return;
        }
        const response = result as { ok?: unknown; value?: unknown };
        let next = response && response.ok === true
          ? applyWakingStatus(checkedSession, response.value)
          : applyWakingCheckFailure(checkedSession, result);
        next = await settleHello(next);
        if (stopped) return;
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
      destroyed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  });
</script>

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
    <BrainSignInStep
      {approval}
      agentUid={session.agentUid}
      name={session.name}
      {openExternal}
      {submitClaudeLoginCode}
      confirmSignIn={confirmClaudeSignIn}
      restart={restartBrainApproval ? restartApproval : null}
      onnudge={() => void nudge(true)}
      onchecking={onCodeChecking}
    />
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
  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}><RailIcon name="x" />
    {session.phase === "failed" || session.phase === "stopped" ? "Close" : approval ? "Do this later" : "Close and keep working"}
  </button>
</section>
