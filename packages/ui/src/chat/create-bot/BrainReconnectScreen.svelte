<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { onMount } from "svelte";
  import { focusOnMount } from "../portal.js";
  import BrainSignInStep from "./BrainSignInStep.svelte";
  import type { BrainProvider } from "./bot-brain-approval.js";
  import {
    applyReconnectCheckFailure,
    applyReconnectStart,
    applyReconnectStatus,
    beginReconnect,
    BRAIN_PRODUCT,
    RECONNECT_NUDGE_MS,
    reconnectNeedsNudge,
    reconnectPollDelayMs,
    reconnectPolling,
    reconnectStatusLine,
    type ReconnectSession,
  } from "./brain-reconnect-model.js";

  interface Props {
    agentUid: string;
    name: string;
    brain: BrainProvider;
    autostart?: boolean;
    getStatus: (agentUid: string, brain?: BrainProvider) => Promise<unknown>;
    restartBrainApproval: (agentUid: string, brain: BrainProvider) => Promise<unknown>;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    openExternal?: ((url: string) => void | boolean | Promise<void | boolean>) | null;
    ondone?: () => void;
    onclose: () => void;
  }

  let {
    agentUid,
    name,
    brain,
    autostart = false,
    getStatus,
    restartBrainApproval,
    retryAgent = null,
    submitClaudeLoginCode = null,
    openExternal = null,
    ondone,
    onclose,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  let session = $state<ReconnectSession>(beginReconnect({ agentUid, name, brain }));
  let starting = $state(false);
  let codeChecking = false;
  let lastNudgeAt = 0;
  let lastPayload: unknown = null;
  let readsStarted = 0;
  let readsApplied = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  let waitingForVisible = false;

  const product = $derived(BRAIN_PRODUCT[brain]);
  const statusLine = $derived(reconnectStatusLine(session));
  const canRetry = $derived(
    session.phase === "failed" && session.refusal !== "not-allowed" && session.refusal !== "api-key",
  );

  function update(next: ReconnectSession): void {
    const wasDone = session.phase === "done";
    session = next;
    if (!wasDone && next.phase === "done") ondone?.();
  }

  async function start(): Promise<void> {
    if (starting || session.phase === "starting" || session.phase === "waiting" || session.phase === "done") return;
    starting = true;
    try {
      const result = await restartBrainApproval(agentUid, brain);
      if (stopped) return;
      update(applyReconnectStart(session, result));
    } catch (error) {
      if (stopped) return;
      update(applyReconnectStart(session, { ok: false, code: error instanceof Error ? error.name : "unknown" }));
    } finally {
      starting = false;
    }
    if (reconnectPolling(session)) checkLater(0);
  }

  async function restartExpired(): Promise<boolean> {
    const result = await restartBrainApproval(agentUid, brain);
    if (stopped) return false;
    const next = applyReconnectStart({ ...session, approval: null }, result);
    if (next.phase === "failed") return false;
    update(next);
    return true;
  }

  async function nudge(force = false): Promise<void> {
    if (!retryAgent || !reconnectNeedsNudge(lastPayload)) return;
    const now = Date.now();
    if (now - lastNudgeAt < (force ? 2_000 : RECONNECT_NUDGE_MS)) return;
    lastNudgeAt = now;
    try {
      await retryAgent(agentUid);
    } catch {
    }
  }

  async function readOnce(): Promise<void> {
    const seq = ++readsStarted;
    let result: { ok?: unknown; value?: unknown } | null = null;
    try {
      result = (await getStatus(agentUid, brain)) as { ok?: unknown; value?: unknown } | null;
    } catch {
      result = null;
    }
    if (stopped || seq < readsApplied) return;
    readsApplied = seq;
    if (result?.ok === true) {
      lastPayload = result.value;
      update(applyReconnectStatus(session, result.value));
    } else {
      update(applyReconnectCheckFailure(session, result));
    }
  }

  async function confirmSignIn(): Promise<boolean> {
    if (session.phase !== "waiting") return true;
    void nudge(true);
    await readOnce();
    return session.phase !== "waiting";
  }

  function checkLater(ms: number): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void check();
    }, ms);
  }

  async function check(): Promise<void> {
    if (stopped || checking || !reconnectPolling(session)) return;
    if (document.hidden) {
      waitingForVisible = true;
      return;
    }
    if (codeChecking) {
      checkLater(reconnectPollDelayMs(session));
      return;
    }
    checking = true;
    try {
      await readOnce();
      if (reconnectPolling(session)) void nudge();
    } finally {
      checking = false;
    }
    if (reconnectPolling(session)) checkLater(reconnectPollDelayMs(session));
  }

  onMount(() => {
    function onVisibility(): void {
      if (document.hidden || !waitingForVisible) return;
      waitingForVisible = false;
      void check();
    }
    document.addEventListener("visibilitychange", onVisibility);
    if (autostart) void start();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  });
</script>

<section class="new-bot-waking" data-testid="brain-reconnect-screen" data-phase={session.phase}>
  <p class="new-bot-takeover-kicker">Signed out of {product}</p>
  <h1 id="brain-reconnect-title">Sign <em>{name}</em> back in</h1>
  <p
    class="new-bot-waking-status"
    data-testid="brain-reconnect-status"
    aria-live="polite"
    aria-atomic="true"
  >{statusLine}</p>

  {#if session.phase === "idle"}
    <button
      type="button"
      class="new-bot-waking-action"
      data-testid="brain-reconnect-start"
      disabled={starting}
      aria-busy={starting ? "true" : undefined}
      use:focusOnMount
      onclick={() => void start()}
    ><RailIcon name="refresh" />{starting ? "Starting..." : "Sign back in"}</button>
  {:else if session.phase === "waiting" && session.approval}
    <BrainSignInStep
      approval={session.approval}
      {agentUid}
      {name}
      {openExternal}
      {submitClaudeLoginCode}
      {confirmSignIn}
      restart={restartExpired}
      onnudge={() => {
        void nudge(true);
        checkLater(0);
      }}
      onchecking={(value) => (codeChecking = value)}
    />
  {:else if canRetry}
    <button
      type="button"
      class="new-bot-waking-action"
      data-testid="brain-reconnect-retry"
      disabled={starting}
      use:focusOnMount
      onclick={() => void start()}
    ><RailIcon name="refresh" />{starting ? "Trying again..." : "Try again"}</button>
  {/if}

  <button type="button" class="new-bot-waking-close" data-testid="brain-reconnect-close" onclick={onclose}><RailIcon name="x" />
    {session.phase === "done" ? "Back to chat" : session.phase === "waiting" ? "Do this later" : "Close"}
  </button>
</section>
