<script lang="ts">
  import aurora from "./assets/new-bot-wallpapers/aurora.jpg";
  import glassWhiteboard from "./assets/new-bot-wallpapers/glass-whiteboard.jpg";
  import nodeConstellation from "./assets/new-bot-wallpapers/node-constellation.jpg";
  import roadSunrise from "./assets/new-bot-wallpapers/road-sunrise.jpg";
  import { focusOnMount, portal } from "../portal.js";
  import type { AdapterPromise, AgentProvisionOptionsView } from "@hq/platform";
  import type { CloudBotDraft, EntryPointResult } from "../lifecycle-entry-points.js";
  import NewBotCreateScreen, { type NewBotCreated } from "./NewBotCreateScreen.svelte";
  import NewBotWakingScreen from "./NewBotWakingScreen.svelte";
  import { beginWakingSession, resumeWakingSession, type WakingBotSession } from "./waking-model.js";
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
    wakingSession?: WakingBotSession | null;
    onwaking?: ((session: WakingBotSession) => void) | null;
    onwakingchange?: ((session: WakingBotSession | null) => void) | null;
    onopenchat?: ((session: WakingBotSession) => void) | null;
    onclosewaking?: (() => void) | null;
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
    wakingSession = null,
    onwaking = null,
    onwakingchange = null,
    onopenchat = null,
    onclosewaking = null,
    wallpaperIndex = 0,
  }: Props = $props();

  const wallpapers = [glassWhiteboard, roadSunrise, nodeConstellation, aurora];
  const wallpaper = $derived(wallpapers[Math.abs(wallpaperIndex) % wallpapers.length] ?? glassWhiteboard);

  let dialogEl = $state<HTMLDivElement | null>(null);
  let localWakingSession = $state<WakingBotSession | null>(null);
  let ignoreExternalWakingSession = $state(false);
  let readyHandoffTimer: ReturnType<typeof setTimeout> | null = null;
  const activeWakingSession = $derived(
    localWakingSession ?? (ignoreExternalWakingSession ? null : wakingSession),
  );

  const focusableSelector =
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (activeWakingSession) closeWaking();
      else oncancel();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = dialogEl
      ? [...dialogEl.querySelectorAll<HTMLElement>(focusableSelector)]
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

  function startWaking(created: NewBotCreated): void {
    const session = beginWakingSession({
      agentUid: created.target.agentUid ?? "",
      channelId: created.target.channelId,
      companyUid: created.companyUid,
      name: created.name,
      brain: created.brain,
    });
    ignoreExternalWakingSession = false;
    localWakingSession = session;
    onwaking?.(session);
  }

  function updateWaking(session: WakingBotSession): void {
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

  function openWakingChat(): void {
    if (!activeWakingSession) return;
    onopenchat?.(activeWakingSession);
    closeWaking();
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
    <button
      type="button"
      class="new-bot-takeover-cancel"
      data-testid="new-bot-takeover-cancel"
      use:focusOnMount
      onclick={activeWakingSession ? closeWaking : oncancel}
    >
      {activeWakingSession ? "Close" : "Cancel"}
    </button>
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
          onupdate={updateWaking}
          onclose={closeWaking}
          onretry={retryWaking}
          onopenchat={openWakingChat}
        />
        {/key}
      {:else if oncreate && loadProvisionOptions && companies.length}
        <NewBotCreateScreen
          {companies}
          {currentCompanyUid}
          {runtimeReady}
          loadProvisionOptions={loadProvisionOptions}
          oncreate={oncreate}
          oncomplete={startWaking}
          onopenlocal={canCreateLocalBot ? onopenlocal : null}
        />
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
</div>
