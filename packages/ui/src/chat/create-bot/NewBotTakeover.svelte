<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { newBotWallpaper } from "./new-bot-wallpapers.js";
  import NewBotKindChoice, { type NewBotKind } from "./NewBotKindChoice.svelte";
  import NewBotNameStep from "./NewBotNameStep.svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { focusOnMount, portal } from "../portal.js";
  import { suspendShortcuts } from "../../common/keyboard-shortcuts.js";
  import type { AdapterPromise, AgentProvisionOptionsView } from "@hq/platform";
  import type { CloudBotDraft, EntryPointResult } from "../lifecycle-entry-points.js";
  import NewBotCreateScreen, { type NewBotCreated, type NewBotUpgradeTarget } from "./NewBotCreateScreen.svelte";
  import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
  import { beginWakingSession, resumeWakingSession, type WakingBotSession } from "./waking-model.js";
  import {
    botRemovalDismissLabel,
    botRemovalLine,
    botRemovalRetryLabel,
    canRetryBotRemoval,
    cancelBotConfirmCopy,
    type BotRemoval,
  } from "./cancel-model.js";
  import type { BrainProvider } from "./bot-brain-approval.js";
  import "./new-bot-takeover.css";

  interface Props {
    canCreateLocalBot?: boolean;
    /**
     * Ask "Where should it live?" (Cloud or Local) after the name. "New bot"
     * opens with it; the takeover opened on a starting bot's row goes
     * straight to that bot.
     */
    choose?: boolean;
    /**
     * With `choose` and a name: open on the cloud create screen with the
     * choice behind Back ("Create a cloud bot instead" on the local steps).
     */
    openCloud?: boolean;
    /**
     * The name given earlier in this New bot (it went to the local steps and
     * came back). With it the takeover skips the name step.
     */
    initialName?: string;
    /** Why Cloud cannot be picked on the choice screen. Null when it can. */
    cloudReason?: string | null;
    /** Why Local cannot be picked on the choice screen. Null when it can. */
    localReason?: string | null;
    /**
     * Cloud was picked but this takeover lists no company for it: the host
     * opens the "+" window's cloud flow (companies without the takeover),
     * with the name given here.
     */
    onchoosecloud?: ((name: string) => void) | null;
    /** Local was picked: the host opens the local flow in the same shell, with the name given here. */
    onchooselocal?: ((name: string) => void) | null;
    oncancel: () => void;
    onopenlocal?: ((name: string) => void) | null;
    /** What the button for `onopenlocal` says on the create screen (see NewBotCreateScreen). */
    otherWayLabel?: string;
    /** True when the person belongs to more than one company: the last step names the target. */
    nameCompany?: boolean;
    companies?: ReadonlyArray<{ companyUid: string; label: string }>;
    currentCompanyUid?: string | null;
    runtimeReady?: Record<string, boolean> | null;
    loadProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    /**
     * Whether the Claude provider is on. The same reader the "+" modal's
     * create uses, so both flows agree. Without it, or until it answers yes,
     * Claude is not offered.
     */
    loadClaudeProviderFlag?: (() => AdapterPromise<boolean>) | null;
    oncreate?: ((companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>) | null;
    /**
     * True while the host looks for a bot whose create got no answer. The
     * create screen says so, and Create bot stays held.
     */
    checkingCreate?: boolean;
    getStatus?: ((agentUid: string, brain?: BrainProvider) => Promise<unknown>) | null;
    retryAgent?: ((agentUid: string) => Promise<unknown>) | null;
    restartBrainApproval?: ((agentUid: string, brain: BrainProvider) => Promise<unknown>) | null;
    submitClaudeLoginCode?: ((agentUid: string, code: string) => Promise<unknown>) | null;
    /** Open the sign-in page. `false` says it did not open (see NewBotWakingScreen). */
    openExternal?: ((url: string) => void | boolean | Promise<void | boolean>) | null;
    sendHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    checkHello?: ((session: WakingBotSession) => Promise<boolean>) | null;
    wakingSession?: WakingBotSession | null;
    onwaking?: ((session: WakingBotSession) => void) | null;
    /** The session moved on: a new status, a retry, a stop. */
    onwakingchange?: ((session: WakingBotSession) => void) | null;
    /** The bot is live and the wait for it is over. The host stops tracking this session. */
    onwakingdone?: ((session: WakingBotSession) => void) | null;
    onopenchat?: ((session: WakingBotSession) => void) | null;
    onclosewaking?: (() => void) | null;
    /** Cancel was pressed while the create request was still out. */
    oncancelcreate?: (() => void) | null;
    /**
     * The person confirmed that a bot that exists should be removed. Without
     * this the waiting screen offers only the way out that keeps the bot.
     */
    oncancelbot?: ((session: WakingBotSession) => void) | null;
    /**
     * False when this person is known to be neither owner nor admin of that
     * company: the server would refuse their removal. Cancel then says who
     * can remove the bot and closes the screen, and promises nothing.
     */
    canRemoveBot?: ((companyUid: string) => boolean) | null;
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
    choose = false,
    openCloud = false,
    initialName = "",
    cloudReason = null,
    localReason = null,
    onchoosecloud = null,
    onchooselocal = null,
    oncancel,
    onopenlocal = null,
    otherWayLabel = "",
    nameCompany = false,
    companies = [],
    currentCompanyUid = null,
    runtimeReady = null,
    loadProvisionOptions = null,
    loadClaudeProviderFlag = null,
    oncreate = null,
    checkingCreate = false,
    getStatus = null,
    retryAgent = null,
    restartBrainApproval = null,
    submitClaudeLoginCode = null,
    // "noopener" in the features makes the call answer null whether or not a
    // window opened, so the opener is cut by hand instead: a blocked window is
    // then reported as not opened, and the screen does not claim it is open.
    openExternal = (url) => {
      const opened = window.open(url, "_blank");
      if (!opened) return false;
      try {
        opened.opener = null;
      } catch {
        // A window that will not let its opener be changed is still open.
      }
      return true;
    },
    sendHello = null,
    checkHello = null,
    wakingSession = null,
    onwaking = null,
    onwakingchange = null,
    onwakingdone = null,
    onopenchat = null,
    onclosewaking = null,
    oncancelcreate = null,
    oncancelbot = null,
    canRemoveBot = null,
    removals = [],
    onretryremoval = null,
    ondismissremoval = null,
    onupgrade = null,
    wallpaperIndex = 0,
  }: Props = $props();

  const wallpaper = $derived(newBotWallpaper(wallpaperIndex));

  /** The takeover has its own cloud create screen to show. */
  const hasCloudScreen = $derived(!!(oncreate && loadProvisionOptions && companies.length));
  /**
   * Which create screen is on: the name (always first), "Where should it
   * live?", or the cloud create screen. Read once, at open: a name given
   * earlier skips the name step.
   */
  type Phase = "name" | "where" | "cloud";
  function openingPhase(): Phase {
    if (!initialName.trim()) return "name";
    if (openCloud && hasCloudScreen) return "cloud";
    return choose || !hasCloudScreen ? "where" : "cloud";
  }
  let phase = $state<Phase>(openingPhase());
  /** The bot's name, from the first step. Kept across Back and the other screens. */
  let botName = $state(untrack(() => initialName.trim()));
  /** The where question is part of this New bot's steps (and its dots). */
  const asksWhere = $derived(choose || !hasCloudScreen);
  /**
   * Step dots for the screens the takeover shows: the name, the where
   * question, then the steps after it. Local continues on one coding tool
   * step; Cloud on its brain step and, with more than one company, the
   * company step.
   */
  const leadSteps = $derived(asksWhere ? 2 : 1);
  const totalSteps = $derived(leadSteps + (hasCloudScreen && companies.length > 1 ? 2 : 1));

  function continueName(name: string): void {
    botName = name;
    phase = asksWhere ? "where" : "cloud";
  }

  function pickKind(kind: NewBotKind): void {
    if (kind === "local") {
      onchooselocal?.(botName);
      return;
    }
    if (hasCloudScreen || !onchoosecloud) {
      phase = "cloud";
      return;
    }
    onchoosecloud(botName);
  }

  let dialogEl = $state<HTMLDivElement | null>(null);

  // The takeover is a modal dialog over the whole window, and it owns the
  // keyboard while it is open: none of the app's shortcuts fires under it,
  // from a key or from the menu. One of them used to close or rebuild the
  // sidebar in the middle of a create (CardModal holds them the same way).
  onMount(() => suspendShortcuts());

  /**
   * Claude is offered only once the host says the provider is on. A read
   * that fails, or no reader at all, leaves it off: the server answers a
   * Claude create with a refusal for everyone who does not have it.
   */
  let claudeEnabled = $state(false);
  onMount(() => {
    if (!loadClaudeProviderFlag) return;
    let active = true;
    void loadClaudeProviderFlag()
      .then((result) => {
        if (active) claudeEnabled = result.ok && result.value === true;
      })
      .catch(() => {
        if (active) claudeEnabled = false;
      });
    return () => {
      active = false;
    };
  });
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
  /** Whether the person the question is put to may remove that bot. */
  const confirmCanRemove = $derived(
    confirmSession && canRemoveBot ? canRemoveBot(confirmSession.companyUid) : true,
  );
  const confirmCopy = $derived(
    confirmSession
      ? cancelBotConfirmCopy({
          name: confirmSession.name,
          companyLabel: companies.find((company) => company.companyUid === confirmSession?.companyUid)?.label ?? null,
          canRemove: confirmCanRemove,
        })
      : null,
  );
  /** The chat hand-off has begun: the bot is live and Cancel is no longer offered. */
  const handingOff = $derived(activeWakingSession?.phase === "ready");
  /** The bot was removed, or this person can no longer reach it: there is nothing to cancel. */
  const wakingStopped = $derived(activeWakingSession?.phase === "stopped");
  /** True while the server is being asked to start a failed bot again. */
  let retryBusy = $state(false);
  /** What to say when the server would not start it again. */
  let retryMessage = $state("");

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

  /** Back to the first step with nothing typed, for the next bot. */
  function startClean(): void {
    createScreenKey += 1;
    botName = "";
    phase = "name";
  }

  /** Cancel while the create request is out: stop here and start clean. */
  function cancelCreate(): void {
    createTurn += 1;
    creating = false;
    startClean();
    oncancelcreate?.();
  }

  function onHeaderCancel(): void {
    if (activeWakingSession) {
      if (cancelsBot && !wakingStopped) confirmSession = activeWakingSession;
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

  /**
   * The dialog's action for a person who may not remove the bot: close the
   * screen. The bot is left as it is and keeps its row; nothing is removed.
   */
  function leaveBot(): void {
    confirmSession = null;
    const held = heldReadySession;
    heldReadySession = null;
    // The bot became live while the question was open: closing is the hand-off.
    if (held) {
      finishHandoff(held);
      return;
    }
    closeWaking();
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
    startClean();
    oncancelbot?.(session);
  }

  function startWaking(created: NewBotCreated): void {
    retryMessage = "";
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
      readyHandoffTimer = setTimeout(() => finishHandoff(session), handoffDelay);
      return;
    }
    localWakingSession = session;
    onwakingchange?.(session);
  }

  /**
   * The bot is live: end the wait and take the person to the conversation.
   * Runs once the short "is live" moment has passed, or at once when the
   * person leaves during that moment.
   */
  function finishHandoff(session: WakingBotSession): void {
    if (readyHandoffTimer) {
      clearTimeout(readyHandoffTimer);
      readyHandoffTimer = null;
    }
    localWakingSession = null;
    ignoreExternalWakingSession = true;
    onwakingdone?.(session);
    onopenchat?.(session);
    onclosewaking?.();
  }

  function closeWaking(): void {
    const session = activeWakingSession;
    // Leaving in the moment before the hand-off (Escape, Close): the bot is
    // live, so leaving is the hand-off, done now. Stopping the timer and
    // walking away used to leave a session that said "ready" for ever.
    if (session?.phase === "ready") {
      finishHandoff(session);
      return;
    }
    if (readyHandoffTimer) {
      clearTimeout(readyHandoffTimer);
      readyHandoffTimer = null;
    }
    if (session) onwakingchange?.(session);
    onclosewaking?.();
  }

  // The takeover can go away while the hand-off timer is still out (the host
  // closed it). The timer must not fire into a screen that is gone, and the
  // host must not be left tracking a bot that is already live.
  onDestroy(() => {
    if (!readyHandoffTimer) return;
    clearTimeout(readyHandoffTimer);
    readyHandoffTimer = null;
    const session = localWakingSession;
    if (session?.phase === "ready") onwakingdone?.(session);
  });

  /**
   * Try again for a bot that failed to start. One request at a time: a
   * second press while the first is out does nothing. A request the server
   * refuses, or that never answers, says so instead of leaving the button
   * looking as if nothing was pressed.
   */
  async function retryWaking(): Promise<void> {
    const target = activeWakingSession;
    if (!target || !retryAgent || retryBusy) return;
    retryBusy = true;
    retryMessage = "";
    try {
      const result = await retryAgent(target.agentUid).catch((error: unknown) => {
        console.warn(
          "new-bot: retry failed",
          error instanceof Error ? error.message : String(error),
        );
        return null;
      });
      if (!(result as { ok?: unknown } | null)?.ok) {
        retryMessage = `We couldn't start ${target.name} again. Try again in a moment.`;
        return;
      }
      const session = resumeWakingSession(target);
      localWakingSession = session;
      onwakingchange?.(session);
    } finally {
      retryBusy = false;
    }
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
      ><RailIcon name="x" />
        {activeWakingSession && (!cancelsBot || wakingStopped) ? "Close" : "Cancel"}
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
          {retryBusy}
          {retryMessage}
        />
        {/key}
      {:else if phase === "name"}
        <div class="new-bot-create" data-testid="new-bot-name-screen" role="group">
          <NewBotNameStep name={botName} total={totalSteps} current={1} oncontinue={continueName} />
        </div>
      {:else if phase === "where" || !hasCloudScreen}
        <NewBotKindChoice
          name={botName}
          {cloudReason}
          {localReason}
          total={totalSteps}
          current={2}
          onback={() => (phase = "name")}
          onpick={pickKind}
        />
      {:else if oncreate && loadProvisionOptions}
        {#key createScreenKey}
        <NewBotCreateScreen
          {companies}
          {currentCompanyUid}
          {runtimeReady}
          {claudeEnabled}
          loadProvisionOptions={loadProvisionOptions}
          oncreate={createBot}
          oncomplete={startWaking}
          {onupgrade}
          onopenlocal={(canCreateLocalBot || otherWayLabel) && onopenlocal ? () => onopenlocal?.(botName) : null}
          {otherWayLabel}
          {nameCompany}
          checking={checkingCreate}
          name={botName}
          leadSteps={leadSteps}
          onback={creating ? null : () => (phase = asksWhere ? "where" : "name")}
        />
        {/key}
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
            >{botRemovalRetryLabel(removal)}</button>
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
          {#if confirmCanRemove}
            <button
              type="button"
              class="new-bot-confirm-remove"
              data-testid="new-bot-cancel-remove"
              onclick={removeBot}
            >{confirmCopy.confirm}</button>
          {:else}
            <!-- Not theirs to remove: the action closes the screen. -->
            <button
              type="button"
              class="new-bot-waking-secondary"
              data-testid="new-bot-cancel-leave"
              onclick={leaveBot}
            >{confirmCopy.confirm}</button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
</div>
