<script lang="ts">
  import aurora from "./assets/new-bot-wallpapers/aurora.jpg";
  import glassWhiteboard from "./assets/new-bot-wallpapers/glass-whiteboard.jpg";
  import nodeConstellation from "./assets/new-bot-wallpapers/node-constellation.jpg";
  import roadSunrise from "./assets/new-bot-wallpapers/road-sunrise.jpg";
  import { focusOnMount, portal } from "../portal.js";
  import type { AdapterPromise, AgentProvisionOptionsView } from "@hq/platform";
  import type { CloudBotDraft, EntryPointResult } from "../lifecycle-entry-points.js";
  import NewBotCreateScreen, { type NewBotCreated, type NewBotUpgradeTarget } from "./NewBotCreateScreen.svelte";
  import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
  import { beginWakingSession, resumeWakingSession, type WakingBotSession } from "./waking-model.js";
  import {
    botRemovalDismissLabel,
    botRemovalLine,
    canRetryBotRemoval,
    cancelBotConfirmCopy,
    type BotRemoval,
  } from "./cancel-model.js";
  import type { BrainProvider } from "./bot-brain-approval.js";
  import "./new-bot-takeover.css";

  interface Props {
    canCreateLocalBot?: boolean;
    oncancel: () => void;
    onopenlocal?: (() => void) | null;
    companies?: ReadonlyArray<{ companyUid: string; label: string }>;
    currentCompanyUid?: string | null;
    runtimeReady?: Record<string, boolean> | null;
    loadProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    oncreate?: ((companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>) | null;
    getStatus?: ((agentUid: string, brain?: BrainProvider) => Promise<unknown>) | null;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    restartBrainApproval?: ((agentUid: string, brain: BrainProvider) => Promise<unknown>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    openExternal?: ((url: string) => void | Promise<void>) | null;
    sendHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    checkHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    wakingSession?: WakingBotSession | null;
    onwaking?: ((session: WakingBotSession) => void) | null;
    onwakingchange?: ((session: WakingBotSession | null) => void) | null;
    onopenchat?: ((session: WakingBotSession) => void) | null;
    onclosewaking?: (() => void) | null;
    /** Cancel was pressed while the create request was still out. */
    oncancelcreate?: (() => void) | null;
    /**
     * The person confirmed that a bot that exists should be removed. Without
     * this the waiting screen offers only the way out that keeps the bot.
     */
    oncancelbot?: ((session: WakingBotSession) => void) | null;
    /** Cancelled bots and where their removal stands. */
    removals?: readonly BotRemoval[];
    onretryremoval?: ((id: string) => void) | null;
    /** Put a failed removal away. The bot stays. */
    ondismissremoval?: ((id: string) => void) | null;
    /** Leave the takeover for the company channel's upgrade card. */
    onupgrade?: ((target: NewBotUpgradeTarget) => void) | null;
    /** Test seam. Production starts on the first clean bundled wallpaper. */
    wallpaperIndex?: number;
  }

  let {
    canCreateLocalBot = false,
    oncancel,
    onopenlocal = null,
    companies = [],
    currentCompanyUid = null,
    runtimeReady = null,
    loadProvisionOptions = null,
    oncreate = null,
    getStatus = null,
    retryAgent = null,
    restartBrainApproval = null,
    submitClaudeLoginCode = null,
    openExternal = (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
    sendHello = null,
    checkHello = null,
    wakingSession = null,
    onwaking = null,
    onwakingchange = null,
    onopenchat = null,
    onclosewaking = null,
    oncancelcreate = null,
    oncancelbot = null,
    removals = [],
    onretryremoval = null,
    ondismissremoval = null,
    onupgrade = null,
    wallpaperIndex = 0,
  }: Props = $props();

  const wallpapers = [glassWhiteboard, roadSunrise, nodeConstellation, aurora];
  const wallpaper = $derived(wallpapers[Math.abs(wallpaperIndex) % wallpapers.length] ?? glassWhiteboard);

  let dialogEl = $state<HTMLDivElement | null>(null);
  let localWakingSession = $state<WakingBotSession | null>(null);
  /**
   * The host's session is shown only when the takeover opens on it (the
   * person clicked a bot that is starting). A session that turns up while the
   * create screen is open belongs to an earlier attempt, and it must not take
   * the screen away from what the person is typing.
   */
  function opensWithoutSession(): boolean {
    return wakingSession === null;
  }
  let ignoreExternalWakingSession = $state(opensWithoutSession());
  let readyHandoffTimer: ReturnType<typeof setTimeout> | null = null;
  const activeWakingSession = $derived(
    localWakingSession ?? (ignoreExternalWakingSession ? null : wakingSession),
  );

  /** True from the press of Create bot until the create request answers. */
  let creating = $state(false);
  /** Each create request gets a number. Cancel moves it on, so a late answer no longer matches. */
  let createTurn = 0;
  /** Remounts the create screen so a cancelled attempt leaves nothing typed. */
  let createScreenKey = $state(0);
  /** The bot the confirmation dialog is asking about. */
  let confirmSession = $state<WakingBotSession | null>(null);
  let confirmEl = $state<HTMLDivElement | null>(null);
  /** A hand-off to chat that arrived while the confirmation dialog was open. */
  let heldReadySession: WakingBotSession | null = null;
  const cancelsBot = $derived(!!oncancelbot);
  const confirmCopy = $derived(
    confirmSession
      ? cancelBotConfirmCopy({
          name: confirmSession.name,
          companyLabel: companies.find((company) => company.companyUid === confirmSession?.companyUid)?.label ?? null,
        })
      : null,
  );
  /** The chat hand-off has begun: the bot is live and Cancel is no longer offered. */
  const handingOff = $derived(activeWakingSession?.phase === "ready");

  const focusableSelector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      // Escape never removes a bot that exists: it backs out of the question,
      // or leaves the waiting screen with the bot still starting.
      if (confirmSession) keepBot();
      else if (activeWakingSession) closeWaking();
      else if (creating) cancelCreate();
      else oncancel();
      return;
    }
    if (event.key !== "Tab") return;

    const scope = confirmEl ?? dialogEl;
    const focusable = scope
      ? [...scope.querySelectorAll<HTMLElement>(focusableSelector)]
      : [];
    if (focusable.length === 0) return;

    event.preventDefault();
    const index = focusable.indexOf(document.activeElement as HTMLElement);
    if (index === -1) {
      focusable[event.shiftKey ? focusable.length - 1 : 0]?.focus();
      return;
    }
    const nextIndex = event.shiftKey
      ? (index - 1 + focusable.length) % focusable.length
      : (index + 1) % focusable.length;
    focusable[nextIndex]?.focus();
  }

  /**
   * The create request, watched. A request whose turn has passed was
   * cancelled: its answer is reported as cancelled and never reaches the
   * waiting screen. The host removes any bot that answer names.
   */
  async function createBot(companyUid: string, draft: CloudBotDraft): Promise<EntryPointResult> {
    if (!oncreate) return { ok: false, blocked: false, reason: "" };
    const turn = ++createTurn;
    creating = true;
    try {
      const result = await oncreate(companyUid, draft);
      return turn === createTurn ? result : { ok: false, blocked: false, reason: "", cancelled: true };
    } finally {
      if (turn === createTurn) creating = false;
    }
  }

  /** Cancel while the create request is out: stop here and start clean. */
  function cancelCreate(): void {
    createTurn += 1;
    creating = false;
    createScreenKey += 1;
    oncancelcreate?.();
  }

  function onHeaderCancel(): void {
    if (activeWakingSession) {
      if (cancelsBot) confirmSession = activeWakingSession;
      else closeWaking();
      return;
    }
    if (creating) cancelCreate();
    else oncancel();
  }

  function keepBot(): void {
    confirmSession = null;
    const held = heldReadySession;
    heldReadySession = null;
    if (held) updateWaking(held);
  }

  function removeBot(): void {
    const session = confirmSession;
    confirmSession = null;
    heldReadySession = null;
    if (!session) return;
    if (readyHandoffTimer) {
      clearTimeout(readyHandoffTimer);
      readyHandoffTimer = null;
    }
    localWakingSession = null;
    ignoreExternalWakingSession = true;
    createScreenKey += 1;
    oncancelbot?.(session);
  }

  function startWaking(created: NewBotCreated): void {
    const session = beginWakingSession({
      agentUid: created.target.agentUid ?? "",
      channelId: created.target.channelId ?? "",
      companyUid: created.companyUid,
      name: created.name,
      brain: created.brain,
    });
    ignoreExternalWakingSession = false;
    localWakingSession = session;
    onwaking?.(session);
  }

  function updateWaking(session: WakingBotSession): void {
    if (session.phase === "ready" && confirmSession) {
      // The person is deciding whether to remove this bot. Hold the hand-off
      // until they answer.
      heldReadySession = session;
      return;
    }
    if (session.phase === "ready") {
      localWakingSession = session;
      onwakingchange?.(session);
      if (readyHandoffTimer) clearTimeout(readyHandoffTimer);
      const handoffDelay = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 350;
      readyHandoffTimer = setTimeout(() => {
        readyHandoffTimer = null;
        localWakingSession = null;
        ignoreExternalWakingSession = true;
        onwakingchange?.(null);
        onopenchat?.(session);
        onclosewaking?.();
      }, handoffDelay);
      return;
    }
    localWakingSession = session;
    onwakingchange?.(session);
  }

  function closeWaking(): void {
    if (readyHandoffTimer) {
      clearTimeout(readyHandoffTimer);
      readyHandoffTimer = null;
    }
    if (activeWakingSession) onwakingchange?.(activeWakingSession);
    onclosewaking?.();
  }

  async function retryWaking(): Promise<void> {
    if (!activeWakingSession || !retryAgent) return;
    const result = await retryAgent(activeWakingSession.agentUid).catch(() => null);
    if (!(result as { ok?: unknown } | null)?.ok) return;
    const session = resumeWakingSession(activeWakingSession);
    localWakingSession = session;
    onwakingchange?.(session);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  bind:this={dialogEl}
  class="new-bot-takeover"
  data-testid="new-bot-takeover"
  role="dialog"
  aria-modal="true"
  aria-labelledby="new-bot-takeover-title"
  tabindex="-1"
  style={`--new-bot-wallpaper: url("${wallpaper}")`}
  use:portal
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
    {#if !handingOff}
      <button
        type="button"
        class="new-bot-takeover-cancel"
        data-testid="new-bot-takeover-cancel"
        use:focusOnMount
        onclick={onHeaderCancel}
      >
        {activeWakingSession && !cancelsBot ? "Close" : "Cancel"}
      </button>
    {/if}
  </header>

  <main class="new-bot-takeover-stage">
    <div class="new-bot-takeover-card">
      {#if activeWakingSession}
        {#key activeWakingSession.phase}
        <NewBotWakingScreen
          session={activeWakingSession}
          {getStatus}
          {retryAgent}
          {restartBrainApproval}
          {submitClaudeLoginCode}
          {openExternal}
          {sendHello}
          {checkHello}
          onupdate={updateWaking}
          onclose={closeWaking}
          onretry={retryWaking}
        />
        {/key}
      {:else if oncreate && loadProvisionOptions && companies.length}
        {#key createScreenKey}
        <NewBotCreateScreen
          {companies}
          {currentCompanyUid}
          {runtimeReady}
          loadProvisionOptions={loadProvisionOptions}
          oncreate={createBot}
          oncomplete={startWaking}
          {onupgrade}
          onopenlocal={canCreateLocalBot ? onopenlocal : null}
        />
        {/key}
      {:else}
        <p class="new-bot-takeover-kicker">A new teammate</p>
        <h1 id="new-bot-takeover-title">
          Meet your <em>next</em> bot.
        </h1>
        <p class="new-bot-takeover-copy">
          Give it a name, choose a brain, and it will be ready to talk in HQ.
        </p>
        <p class="new-bot-takeover-next">Name and brain are next.</p>
      {/if}

      {#if !oncreate && canCreateLocalBot && onopenlocal}
        <button
          type="button"
          class="new-bot-takeover-local"
          data-testid="new-bot-takeover-local"
          onclick={onopenlocal}
        >
          Create a local bot instead
        </button>
      {/if}
    </div>
  </main>

  {#if removals.length}
    <!-- One calm line per cancelled bot: what is happening to it, then how it ended. -->
    <footer class="new-bot-cancel-notices" data-testid="new-bot-cancel-notices" aria-live="polite">
      {#each removals as removal (removal.id)}
        <p class="new-bot-cancel-notice" data-testid="new-bot-cancel-notice" data-phase={removal.phase}>
          <span>{botRemovalLine(removal)}</span>
          {#if canRetryBotRemoval(removal) && onretryremoval}
            <button
              type="button"
              class="new-bot-cancel-retry"
              data-testid="new-bot-cancel-retry"
              onclick={() => onretryremoval?.(removal.id)}
            >Try again</button>
          {/if}
          {#if removal.phase === "failed" && ondismissremoval}
            <button
              type="button"
              class="new-bot-cancel-retry"
              data-testid="new-bot-cancel-dismiss"
              onclick={() => ondismissremoval?.(removal.id)}
            >{botRemovalDismissLabel(removal)}</button>
          {/if}
        </p>
      {/each}
    </footer>
  {/if}

  {#if confirmSession && confirmCopy}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      class="new-bot-confirm-backdrop"
      role="presentation"
      onclick={(event) => { if (event.target === event.currentTarget) keepBot(); }}
    >
      <div
        bind:this={confirmEl}
        class="new-bot-confirm"
        data-testid="new-bot-cancel-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="new-bot-confirm-title"
        aria-describedby="new-bot-confirm-body"
      >
        <h2 id="new-bot-confirm-title">{confirmCopy.title}</h2>
        <p id="new-bot-confirm-body">{confirmCopy.body}</p>
        <div class="new-bot-confirm-actions">
          <button
            type="button"
            class="new-bot-waking-secondary"
            data-testid="new-bot-cancel-keep"
            use:focusOnMount
            onclick={keepBot}
          >{confirmCopy.keep}</button>
          <button
            type="button"
            class="new-bot-confirm-remove"
            data-testid="new-bot-cancel-remove"
            onclick={removeBot}
          >{confirmCopy.confirm}</button>
        </div>
      </div>
    </div>
  {/if}
</div>
