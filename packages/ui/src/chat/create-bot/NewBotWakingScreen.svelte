<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyWakingStatus,
    recordWakingCheckFailure,
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
    onopenchat: () => void;
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
    onopenchat,
  }: Props = $props();

  let approvalOpened = $state(false);
  let showCodexCode = $state(false);
  let claudeCode = $state("");
  let actionBusy = $state(false);
  let actionMessage = $state("");
  let copiedCodexCode = $state<string | null>(null);

  const initials = $derived(
    session.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0]?.toUpperCase() ?? "")
      .join("") || "B",
  );
  const statusLine = $derived(wakingStatusLine(session));
  const approval = $derived(session.approval);

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
          actionMessage = "Copy the code below and paste it on the next page.";
        }
        showCodexCode = true;
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
        showCodexCode = false;
        claudeCode = "";
        onupdate(applyWakingStatus({ ...session, startedAt: Date.now(), approval: null }, response.value));
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
        onupdate(next);
      } catch {
        if (!stopped) onupdate(recordWakingCheckFailure(checkedSession));
      }
      if (!stopped && checkedSession.phase === "waking") timer = setTimeout(() => void check(), WAKING_POLL_MS);
    }

    void check();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  });
</script>

<section class="new-bot-waking" data-testid="new-bot-waking-screen">
  <div
    class="new-bot-waking-ring"
    data-testid="new-bot-waking-ring"
    style={`--waking-progress: ${session.progress}%`}
    role="progressbar"
    aria-label={`Waking up ${session.name}`}
    aria-valuemin="0"
    aria-valuemax="100"
    aria-valuenow={session.progress}
  >
    <span class="new-bot-waking-avatar">{initials}</span>
  </div>
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Waking up <em>{session.name}</em></h1>
  <p
    class="new-bot-waking-status"
    data-testid="new-bot-waking-status"
    aria-live="polite"
    aria-atomic="true"
  >{statusLine}</p>

  {#if approval && session.phase === "waking"}
    {#if approvalExpired(approval)}
      <p class="new-bot-waking-status" data-testid="new-bot-approval-expired">This approval link has expired.</p>
      <button
        type="button"
        class="new-bot-waking-action"
        data-testid="new-bot-approval-restart"
        disabled={!restartBrainApproval || actionBusy}
        onclick={() => void restartApproval()}
      >{actionBusy ? "Starting again..." : "Start again"}</button>
    {:else}
      <button
        type="button"
        class="new-bot-waking-action"
        data-testid="new-bot-approval-open"
        disabled={actionBusy}
        onclick={() => void openApproval()}
      >{actionBusy ? "Opening..." : `Continue with ${brainApprovalLabel(approval.provider)}`}</button>

      {#if approval.provider === "codex" && showCodexCode}
        <p class="new-bot-waking-status" data-testid="new-bot-codex-code">{approval.code}</p>
      {:else if approval.provider === "claude" && approvalOpened}
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

      {#if approvalOpened && approval.provider === "grok"}
        <p class="new-bot-waking-status" data-testid="new-bot-approval-waiting">Waiting for Grok.</p>
      {/if}
    {/if}
    {#if actionMessage}
      <p class="new-bot-waking-status" data-testid="new-bot-approval-message">{actionMessage}</p>
    {/if}
  {/if}

  {#if session.phase === "failed"}
    <button type="button" class="new-bot-waking-action" data-testid="new-bot-waking-retry" disabled={!retryAgent} use:focusOnMount onclick={onretry}>Try again</button>
  {:else}
    <button type="button" class="new-bot-waking-link" data-testid="new-bot-waking-open-chat" use:focusOnMount onclick={onopenchat}>Open chat now</button>
  {/if}

  <button type="button" class="new-bot-waking-close" data-testid="new-bot-waking-close" onclick={onclose}>Close</button>
</section>
