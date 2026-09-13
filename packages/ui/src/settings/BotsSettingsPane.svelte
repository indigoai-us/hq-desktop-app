<script lang="ts">
  /**
   * Settings → Bots — the one pane for every bot the user works with.
   *
   * Every AI teammate is a bot (owner decision, 2026-09-11); the only split is
   * Cloud (company-hosted, always on) vs Local (this Mac, the user's own
   * Claude Code / Codex / Grok login).
   *
   * - Local group: personal bots from the platform adapter's desktop-only
   *   `bots` group, which shells to the hq CLI (`hq bot … --json`) behind the
   *   host's launch boundary. Absent on the web build.
   * - Cloud group: the caller's cross-company roster via `adapter.agents`
   *   (member-safe `GET /v1/agents/mobile-roster`). Pause/Resume/Remove only
   *   for bots whose company the caller owns/administers.
   *
   * Nothing here talks to hq-pro directly and no credential is ever shown.
   */
  import { onDestroy, onMount } from "svelte";
  import type { LocalBotCreateInput, LocalBotRow, LocalBotWorkerOption, PlatformAdapter } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import BotKindChip from "../chat/BotKindChip.svelte";
  import { LOCAL_BOT_RUNTIMES } from "../chat/local-bots.js";
  import CreateBotFlow, { type CreateBotExtras } from "../chat/create-bot/CreateBotFlow.svelte";
  import type { RuntimeSignInApi, RuntimeSignInState } from "../chat/create-bot/RuntimeSignIn.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    cloudBotInitial,
    cloudBotStatusLabel,
    cloudBotsFromRoster,
    type CloudBotRow,
  } from "./cloud-bots.js";
  import "./settings-chrome.css";

  interface Props {
    adapter?: PlatformAdapter | null;
    /** Signed-in memberships; names the Cloud rows and gates their actions. */
    companies?: Workspace[] | null;
    /** Explicit admin override (host-known); null defers to membership roles. */
    isAdmin?: boolean | null;
  }
  let { adapter = null, companies = null, isAdmin = null }: Props = $props();

  type Runtime = LocalBotRow["runtime"];
  const RUNTIMES = LOCAL_BOT_RUNTIMES;
  const POLL_MS = 30_000;

  // ── Local group ─────────────────────────────────────────────────────────────
  let bots = $state<LocalBotRow[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let busy = $state<string | null>(null);
  let line = $state("");
  let lineIsError = $state(false);
  let flags = $state<Record<string, boolean> | null>(null);
  /** The New bot flow, hosted in a lightweight dialog over the pane. */
  let createOpen = $state(false);
  let createBusy = $state<"bot" | null>(null);
  let createError = $state<string | null>(null);
  let workers = $state<LocalBotWorkerOption[] | null>(null);
  let confirmRemove = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  // ── Cloud group ─────────────────────────────────────────────────────────────
  let cloudBots = $state<CloudBotRow[]>([]);
  let cloudLoading = $state(true);
  let cloudError = $state("");
  let cloudBusy = $state<string | null>(null);
  let cloudLine = $state("");
  let cloudLineIsError = $state(false);
  let cloudConfirmRemove = $state<string | null>(null);
  /** Bots this pane paused; the roster carries no runtime state of its own. */
  let pausedCloud = $state<Set<string>>(new Set());

  function runtimeLabel(id: string): string {
    return RUNTIMES.find((r) => r.id === id)?.label ?? id;
  }
  function runtimeReady(id: Runtime): boolean {
    if (!flags) return true;
    return Boolean(flags[`${id}Available`]) && Boolean(flags[`${id}LoggedIn`]);
  }
  function presenceLabel(bot: LocalBotRow): string {
    if (bot.online === true) return "Online";
    if (bot.state === "failed") return "Stopped after errors";
    if (bot.processAlive) return "Starting…";
    return "Offline";
  }
  function heartbeatLabel(bot: LocalBotRow): string {
    if (!bot.lastHeartbeatAt) return "Never checked in";
    const t = Date.parse(bot.lastHeartbeatAt);
    if (Number.isNaN(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `Checked in ${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `Checked in ${m}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `Checked in ${h}h ago` : `Checked in ${Math.round(h / 24)}d ago`;
  }
  /** `{ claude: true, … }` for the flow's Home step. */
  const runtimeReadyById = $derived.by<Record<string, boolean> | null>(() => {
    if (!flags) return null;
    const out: Record<string, boolean> = {};
    for (const r of RUNTIMES) out[r.id] = runtimeReady(r.id);
    return out;
  });
  const botSignIn = $derived.by<RuntimeSignInApi | null>(() => {
    const sessions = adapter?.sessions;
    if (!sessions?.loginStart || !sessions.loginStatus) return null;
    const toState = (result: { ok: true; value: unknown } | { ok: false; message?: string }): RuntimeSignInState => {
      if (!result.ok) return { state: "error", message: result.message || "Could not reach the sign-in." };
      const rec = (result.value ?? {}) as { state?: string; message?: string };
      const state = rec.state === "waiting" || rec.state === "connected" || rec.state === "error" ? rec.state : "disconnected";
      return { state, message: rec.message };
    };
    return {
      loginStart: async (runtime) => toState(await sessions.loginStart!(runtime)),
      loginStatus: async (runtime) => toState(await sessions.loginStatus!(runtime)),
      loginCancel: sessions.loginCancel ? async (runtime) => toState(await sessions.loginCancel!(runtime)) : undefined,
    };
  });

  async function load(quiet = false): Promise<void> {
    const api = adapter?.bots;
    if (!api) {
      loading = false;
      loadError = "";
      return;
    }
    if (!quiet) {
      loading = true;
      loadError = "";
    }
    const result = await api.list();
    if (!result.ok) {
      loadError = result.message || "Could not read your local bots.";
    } else {
      bots = result.value.bots ?? [];
      loadError = "";
    }
    loading = false;
  }

  async function act(name: string, verb: "start" | "stop" | "remove"): Promise<void> {
    const api = adapter?.bots;
    if (!api || busy) return;
    busy = name;
    line = `${verb === "start" ? "Starting" : verb === "stop" ? "Stopping" : "Removing"} ${name}…`;
    lineIsError = false;
    const result = await api[verb](name);
    if (!result.ok) {
      line = result.message || `Could not ${verb} ${name}.`;
      lineIsError = true;
    } else {
      line = "";
      await load(true);
    }
    busy = null;
    confirmRemove = null;
  }

  async function openCreate(): Promise<void> {
    if (!adapter?.bots) return;
    createError = null;
    createOpen = true;
    const list = adapter.bots.workers;
    if (list && workers === null) {
      const result = await list();
      workers = result.ok ? (result.value.workers ?? []) : [];
    }
  }

  function closeCreate(): void {
    if (createBusy) return;
    createOpen = false;
    createError = null;
  }

  /** The flow hands us the CLI input; the same `hq bot create` the sidebar runs. */
  async function create(input: LocalBotCreateInput, _extras: CreateBotExtras): Promise<void> {
    const api = adapter?.bots;
    if (!api || createBusy) return;
    createBusy = "bot";
    createError = null;
    const result = await api.create(input);
    if (!result.ok) {
      createError = result.message || `Could not create ${input.name}.`;
      createBusy = null;
      return;
    }
    createBusy = null;
    createOpen = false;
    line = `${input.name} is set up. It will send you a hello in Messages once it comes online.`;
    lineIsError = false;
    await load(true);
  }

  async function loadPreflight(): Promise<void> {
    const preflight = adapter?.sessions?.preflight;
    if (!preflight) return;
    const result = await preflight();
    if (!result.ok) return;
    const rec = result.value as Record<string, unknown>;
    const next: Record<string, boolean> = {};
    for (const id of ["claude", "codex", "grok"]) {
      next[`${id}Available`] = rec[`${id}Available`] === true;
      next[`${id}LoggedIn`] = rec[`${id}LoggedIn`] === true;
    }
    flags = next;
  }

  async function loadCloud(quiet = false): Promise<void> {
    const agents = adapter?.agents;
    if (!agents?.listMobileRoster) {
      cloudLoading = false;
      cloudError = "Cloud bots are unavailable in this host.";
      return;
    }
    if (!quiet) {
      cloudLoading = true;
      cloudError = "";
    }
    try {
      const result = await agents.listMobileRoster(null);
      if (!result.ok) {
        cloudError = result.message || "Could not read your cloud bots.";
      } else {
        cloudBots = cloudBotsFromRoster(result.value, { companies, isAdmin });
        cloudError = "";
      }
    } catch (error) {
      cloudError = error instanceof Error ? error.message : "Could not read your cloud bots.";
    }
    cloudLoading = false;
  }

  async function actCloud(
    bot: CloudBotRow,
    verb: "pause" | "resume" | "remove",
  ): Promise<void> {
    const agents = adapter?.agents;
    if (!agents || cloudBusy) return;
    cloudBusy = bot.uid;
    cloudLine = `${verb === "pause" ? "Pausing" : verb === "resume" ? "Resuming" : "Removing"} ${bot.displayName}…`;
    cloudLineIsError = false;
    const result =
      verb === "pause"
        ? await agents.stop(bot.uid)
        : verb === "resume"
          ? await agents.start(bot.uid)
          : await agents.deprovision(bot.uid);
    if (!result.ok) {
      cloudLine = result.message || `Could not ${verb} ${bot.displayName}.`;
      cloudLineIsError = true;
    } else {
      cloudLine = "";
      const next = new Set(pausedCloud);
      if (verb === "pause") next.add(bot.uid);
      else next.delete(bot.uid);
      pausedCloud = next;
      await loadCloud(true);
    }
    cloudBusy = null;
    cloudConfirmRemove = null;
  }

  onMount(() => {
    void load();
    void loadPreflight();
    void loadCloud();
    timer = setInterval(() => {
      void load(true);
      void loadCloud(true);
    }, POLL_MS);
  });
  onDestroy(() => clearInterval(timer));
</script>

<section class="settings-section bots-pane" data-testid="settings-bots">
  <p class="lead">
    Every bot you work with, in one place. Cloud bots run in a company's cloud
    and are always on; local bots run on this Mac with your own Claude Code,
    Codex, or Grok login. Message either from the desktop app or your phone.
  </p>

  <!-- ── Local ─────────────────────────────────────────────────────────── -->
  <div class="group" data-testid="settings-bots-local">
    <div class="group-head">
      <h3 class="group-title">Local</h3>
      <BotKindChip kind="local" variant="label" />
    </div>
    {#if !adapter?.bots}
      <div class="settings-card">
        <p class="muted empty" data-testid="settings-bots-local-unavailable">
          Local bots run from the HQ desktop app on your Mac. Open HQ there to
          create one.
        </p>
      </div>
    {:else}
      {#if loadError}
        <p class="bots-error" data-testid="settings-bots-error">
          {loadError}
          <button type="button" class="quiet" onclick={() => void load()}>Retry</button>
        </p>
      {/if}
      <div class="settings-card" data-testid="settings-bots-list">
        {#if !loading && bots.length === 0 && !loadError}
          <p class="muted empty" data-testid="settings-bots-empty">
            No local bots yet — create one below. It takes about half a minute.
          </p>
        {/if}
        {#each bots as bot (bot.name)}
          <div
            class="bot-row"
            data-testid={`settings-bot-${bot.name}`}
            data-online={bot.online === true}
          >
            <div class="bot-main">
              <strong>
                <span class="dot" class:online={bot.online === true} aria-hidden="true"></span>
                {bot.name}
                <BotKindChip kind="local" runtime={bot.runtime} variant="label" />
              </strong>
              <small>
                {runtimeLabel(bot.runtime)}{bot.model ? ` · ${bot.model}` : ""} · {presenceLabel(bot)} · {heartbeatLabel(bot)}
              </small>
              {#if bot.state === "failed"}
                <small class="muted">
                  The bot stopped after repeated errors. Check that {runtimeLabel(bot.runtime)} is signed in, then start it again.
                </small>
              {/if}
            </div>
            <div class="actions">
              {#if bot.processAlive}
                <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, "stop")}>
                  {busy === bot.name ? "Working…" : "Stop"}
                </button>
              {:else}
                <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, "start")}>
                  {busy === bot.name ? "Working…" : "Start"}
                </button>
              {/if}
              {#if confirmRemove === bot.name}
                <button type="button" class="danger" disabled={Boolean(busy)} onclick={() => void act(bot.name, "remove")}>
                  Really remove
                </button>
                <button type="button" class="quiet" disabled={Boolean(busy)} onclick={() => (confirmRemove = null)}>
                  Keep
                </button>
              {:else}
                <button type="button" class="quiet" disabled={Boolean(busy)} onclick={() => (confirmRemove = bot.name)}>
                  Remove
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      <div class="settings-card create" data-testid="settings-bots-create">
        <div class="bot-main">
          <strong>New bot</strong>
          <small>Blank, from a template, or a copy of a bot you have — thinking with a tool signed in on this Mac.</small>
        </div>
        <div class="create-controls">
          <button
            type="button"
            data-testid="settings-bots-create-button"
            disabled={Boolean(busy) || createOpen}
            onclick={() => void openCreate()}
          >
            New bot
          </button>
        </div>
      </div>
      {#if line}
        <p class="status" class:error={lineIsError} aria-live="polite" data-testid="settings-bots-status">{line}</p>
      {/if}
    {/if}
  </div>

  <!-- ── Cloud ─────────────────────────────────────────────────────────── -->
  <div class="group" data-testid="settings-bots-cloud">
    <div class="group-head">
      <h3 class="group-title">Cloud</h3>
      <BotKindChip kind="cloud" variant="label" />
    </div>
    {#if cloudError}
      <p class="bots-error" data-testid="settings-bots-cloud-error">
        {cloudError}
        {#if adapter?.agents?.listMobileRoster}
          <button type="button" class="quiet" onclick={() => void loadCloud()}>Retry</button>
        {/if}
      </p>
    {/if}
    <div class="settings-card" data-testid="settings-bots-cloud-list">
      {#if !cloudLoading && cloudBots.length === 0 && !cloudError}
        <p class="muted empty" data-testid="settings-bots-cloud-empty">
          No cloud bots yet — add one from a company channel with Add bot.
        </p>
      {/if}
      {#each cloudBots as bot (bot.uid)}
        <div class="bot-row" data-testid={`settings-cloud-bot-${bot.uid}`} data-status={bot.status}>
          <div class="bot-main">
            <strong>
              <span class="initial" aria-hidden="true">{cloudBotInitial(bot.displayName)}</span>
              {bot.displayName}
              <BotKindChip kind="cloud" variant="label" />
            </strong>
            <small>
              {#if bot.companyLabel}{bot.companyLabel} · {/if}{pausedCloud.has(bot.uid)
                ? "Paused"
                : cloudBotStatusLabel(bot.status, bot.phase)}
            </small>
          </div>
          {#if bot.canManage}
            <div class="actions">
              {#if pausedCloud.has(bot.uid)}
                <button
                  type="button"
                  data-testid={`settings-cloud-bot-${bot.uid}-resume`}
                  disabled={Boolean(cloudBusy)}
                  onclick={() => void actCloud(bot, "resume")}
                >
                  {cloudBusy === bot.uid ? "Working…" : "Resume"}
                </button>
              {:else}
                <button
                  type="button"
                  data-testid={`settings-cloud-bot-${bot.uid}-pause`}
                  disabled={Boolean(cloudBusy) || bot.status === "PROVISIONING"}
                  onclick={() => void actCloud(bot, "pause")}
                >
                  {cloudBusy === bot.uid ? "Working…" : "Pause"}
                </button>
              {/if}
              {#if cloudConfirmRemove === bot.uid}
                <button
                  type="button"
                  class="danger"
                  data-testid={`settings-cloud-bot-${bot.uid}-confirm-remove`}
                  disabled={Boolean(cloudBusy)}
                  onclick={() => void actCloud(bot, "remove")}
                >
                  Really remove
                </button>
                <button type="button" class="quiet" disabled={Boolean(cloudBusy)} onclick={() => (cloudConfirmRemove = null)}>
                  Keep
                </button>
              {:else}
                <button
                  type="button"
                  class="quiet"
                  data-testid={`settings-cloud-bot-${bot.uid}-remove`}
                  disabled={Boolean(cloudBusy)}
                  onclick={() => (cloudConfirmRemove = bot.uid)}
                >
                  Remove
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
    {#if cloudLine}
      <p class="status" class:error={cloudLineIsError} aria-live="polite" data-testid="settings-bots-cloud-status">{cloudLine}</p>
    {/if}
  </div>
</section>

{#if createOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="create-overlay"
    data-testid="settings-bots-create-dialog"
    onkeydown={(event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeCreate();
      }
    }}
  >
    <div class="create-card" role="dialog" aria-modal="true" aria-label="New bot" tabindex="-1">
      <div class="create-card-head">
        <span class="create-card-title">New bot</span>
        <button type="button" class="quiet create-close" aria-label="Close" disabled={Boolean(createBusy)} onclick={closeCreate}>×</button>
      </div>
      <CreateBotFlow
        botRuntimeReady={runtimeReadyById}
        botWorkers={workers}
        existingNames={bots.map((b) => b.name)}
        agentTargets={[]}
        oncreate={create}
        onback={closeCreate}
        entryBusy={createBusy}
        entryError={createError}
        signInApi={botSignIn}
        onsignedin={() => loadPreflight()}
      />
    </div>
  </div>
{/if}

<style>
  .create-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    background: rgba(0, 0, 0, 0.45);
  }
  .create-card {
    display: flex;
    flex-direction: column;
    width: min(880px, 100%);
    max-height: min(88vh, 720px);
    overflow: hidden;
    border: 1px solid var(--v4-hairline);
    border-radius: 14px;
    background: var(--v4-surface-solid, #fff);
    box-shadow: var(--v4-shadow-window, var(--panel-shadow));
    outline: none;
  }
  .create-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--v4-hairline);
  }
  .create-card-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--t1);
  }
  .create-close {
    font-size: 16px;
    line-height: 1;
    padding: 2px 8px;
  }
  .bots-pane { display: grid; gap: 16px; }
  .group { display: grid; gap: 10px; }
  .group-head { display: flex; align-items: center; gap: 8px; }
  .group-title {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--v4-text-3);
  }
  .lead, .status, .bots-error, small {
    font-size: 12px;
    line-height: 1.55;
    color: var(--v4-text-2);
    margin: 0;
  }
  .muted { color: var(--v4-text-3); }
  .empty { padding: 12px 0; }
  .error, .bots-error { color: var(--v4-danger, #dcaaa0); }
  .bot-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--v4-hairline);
  }
  .bot-row:last-child { border-bottom: 0; }
  .bot-main { display: grid; gap: 4px; min-width: 0; }
  .bot-main strong { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--v4-text-3);
    flex: 0 0 8px;
  }
  .dot.online { background: var(--v4-ok, #42d77d); }
  .initial {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border-radius: 50%;
    background: var(--v4-control-bg);
    border: 1px solid var(--v4-hairline);
    color: var(--v4-text-2);
    font-size: 11px;
    font-weight: 600;
  }
  .actions { display: flex; align-items: center; gap: 8px; }
  .create { display: grid; gap: 10px; }
  .create-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button {
    font: inherit;
    font-size: 13px;
    min-height: 36px;
    padding: 6px 12px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  button.danger { color: var(--v4-danger, #dcaaa0); }
  .quiet {
    border: 0;
    background: transparent;
    min-height: 0;
    padding: 0 6px;
    color: var(--v4-text-2);
  }
</style>
