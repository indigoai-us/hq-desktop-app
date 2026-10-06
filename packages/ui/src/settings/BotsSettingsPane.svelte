<script lang="ts">
  import RailIcon from "../common/button/RailIcon.svelte";
  import CompanyLabel from "../company/CompanyLabel.svelte";
  import RailButton from "../common/button/RailButton.svelte";
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
  import type {
    BotRestoreResult,
    LocalBotCreateInput,
    LocalBotRow,
    LocalBotWorkerOption,
    PlatformAdapter,
    RemoteBotRow,
  } from "@hq/platform";
  import { hostComputerNoun, startJitteredPoll } from "@hq/platform";
  import type { Workspace } from "../chat/workspaces.js";
  import BotKindChip from "../chat/BotKindChip.svelte";
  import { LOCAL_BOT_RUNTIMES, localBotCompanies, localBotKindLabel } from "../chat/local-bots.js";
  import { botRowDisplayName, loadBotDisplayNames, rememberBotDisplayName } from "../chat/bot-display-names.js";
  import {
    BOT_RESTORE_FROM_SETTINGS,
    BOT_START_HERE,
    BOT_START_HERE_BUSY,
    botFailureReason,
    BOT_LIVE_ELSEWHERE_NOTICE,
    botLiveElsewhere,
    botRestoreRowLine,
    botRestoreSummary,
    botsLiveElsewhereNotice,
    botsNotHere,
    botStaysInCloudLine,
    botStoppedRemedy,
    botStoppedReasonFor,
    classifyRemoteBotFailure,
    isNotRunnableHereReason,
    remoteBotListingNotice,
    REMOTE_BOTS_CALL_TIMEOUT_MS,
    REMOTE_BOTS_TIMEOUT_LOG,
    withPollTimeout,
    type RemoteBotListFailure,
  } from "../chat/bot-restore.js";
  import { botNeedsSignIn, expiredRuntimeOf } from "../chat/runtime-sign-in-again.js";
  import CreateBotFlow, { type CreateBotExtras } from "../chat/create-bot/CreateBotFlow.svelte";
  import CardModal from "../chat/messaging/CardModal.svelte";
  import CardModalStatus from "../chat/messaging/CardModalStatus.svelte";
  import { paintableAvatarSrc } from "../avatars/csp-image-src.js";
  import { SETUP_HERO_ART } from "../chat/setup-welcome-art.js";
  import { parseRuntimeStatus, type RuntimeStatus } from "../chat/create-bot/runtime-status.js";
  import type { RuntimeSignInApi, RuntimeSignInState } from "../chat/create-bot/RuntimeSignIn.svelte";
  import "../chat/tokens.css";
  import "../chat/chat-tokens.css";
  import {
    cloudBotInitial,
    cloudBotStatusLabel,
    cloudBotsFromRoster,
    fetchCloudRoster,
    type CloudBotRow,
  } from "./cloud-bots.js";
  import "./settings-chrome.css";
  import { friendlyApiError } from "../common/api-error.js";

  interface Props {
    adapter?: PlatformAdapter | null;
    /** Signed-in memberships; names the Cloud rows and gates their actions. */
    companies?: Workspace[] | null;
    /** Explicit admin override (host-known); null defers to membership roles. */
    isAdmin?: boolean | null;
    /**
     * Open the one New bot modal (the Messages "New" flow). The host closes
     * Settings first; creating lands in the bot's DM. Without it the pane
     * falls back to its own local-only dialog.
     */
    onnewbot?: (() => void) | null;
  }
  let { adapter = null, companies = null, isAdmin = null, onnewbot = null }: Props = $props();

  type Runtime = LocalBotRow["runtime"];
  const RUNTIMES = LOCAL_BOT_RUNTIMES;
  const POLL_MS = 30_000;
  const SUCCESS_NOTE_MS = 4_000;

  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). Read once so status/adopt lines never rename the machine
   * mid-flight; the neutral fallback covers a probe that has not landed.
   */
  const hostNoun = hostComputerNoun();

  // ── Local group ─────────────────────────────────────────────────────────────
  let bots = $state<LocalBotRow[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let busy = $state<string | null>(null);
  let line = $state("");
  let lineIsError = $state(false);
  let flags = $state<Record<string, boolean> | null>(null);
  /** Per-runtime state, so the flow can tell WHICH problem a runtime has. */
  let runtimeStatuses = $state<Record<string, RuntimeStatus> | null>(null);
  /** The New bot flow, hosted in a lightweight dialog over the pane. */
  let createOpen = $state(false);
  let createBusy = $state<"bot" | null>(null);
  let createError = $state<string | null>(null);
  let workers = $state<LocalBotWorkerOption[] | null>(null);
  let removedLocal = $state<Set<string>>(new Set());
  let localAction = $state<{
    name: string;
    message: string;
    isError: boolean;
    verb: "start" | "stop";
  } | null>(null);
  let localActionTimeout: ReturnType<typeof setTimeout> | undefined;
  let stopPoll: (() => void) | undefined;

  // ── Bots this account owns that are not set up on this Mac ─────────────────
  // `hq bot list` only knows this computer, so a reinstall (or a second Mac)
  // used to make an owned bot simply vanish from Settings. `hq bot list
  // --remote` is the account's own listing; the rows it flags `here: false`
  // get their own group with the one action that fixes them.
  let remoteBots = $state<RemoteBotRow[] | null>(null);
  /**
   * Why the listing could not be read, or null while it is fine. A failure
   * keeps the last good rows and takes the ACTIONS away, never the rows: an
   * HQ Cloud without the route is why "Restore my bots" cannot work, and a
   * pane that simply showed nothing left the person with no explanation at
   * all (the owner's VM, round 6).
   */
  let remoteFailure = $state<RemoteBotListFailure | null>(null);
  const remoteFailureNotice = $derived(remoteBotListingNotice(remoteFailure));
  let adoptBusy = $state<string | null>(null);
  let adoptAction = $state<{ name: string; message: string; isError: boolean } | null>(null);
  let restoreBusy = $state(false);
  let restoreResult = $state<BotRestoreResult | null>(null);
  /**
   * The rows this pane may offer, and only those: `botsNotHere` drops any bot
   * this Mac could never run (a company bot), because restoring one creates
   * credentials, a state directory and a startup agent for something whose
   * runtime refuses it at every login — round 4, Defect 7.
   */
  const missingHere = $derived(botsNotHere(remoteBots));
  /**
   * The ones among those that are RUNNING on another computer.
   *
   * Bringing a bot here re-issues its machine credentials, and the old secret
   * stops working — so starting it here stops it there. The row says that
   * before the button is pressed; the app never does it unasked.
   */
  const liveElsewhere = $derived(missingHere.filter((bot) => botLiveElsewhere(bot)));
  /** The account's listing by identity, for the stopped-bot remedy below. */
  const remoteByUid = $derived.by(() => {
    const out = new Map<string, RemoteBotRow>();
    for (const bot of remoteBots ?? []) {
      const uid = bot.agentUid?.trim();
      if (uid) out.set(uid, bot);
    }
    return out;
  });
  /**
   * The one sentence under a stopped bot, keyed on what is actually wrong.
   *
   * `hq bot adopt` writes `kind=personal` locally whatever the cloud record
   * says, so a company bot brought back here looks like an ordinary local bot
   * that keeps failing. The account's own listing is the only thing that knows
   * better, which is why the remedy is looked up by identity there.
   */
  function stoppedRemedy(bot: LocalBotRow): string {
    return botStoppedRemedy(
      botStoppedReasonFor(botNeedsSignIn(bot), remoteByUid.get(bot.agentUid?.trim() ?? "")),
      runtimeLabel(expiredRuntimeOf(bot)),
    );
  }

  // ── Cloud group ─────────────────────────────────────────────────────────────
  let cloudBots = $state<CloudBotRow[]>([]);
  let cloudLoading = $state(true);
  let cloudError = $state("");
  let cloudBusy = $state<string | null>(null);
  type RemoveDialog =
    | {
        kind: "local";
        bot: LocalBotRow;
        displayName: string;
        returnFocus: HTMLElement | null;
        error: string | null;
      }
    | {
        kind: "cloud";
        bot: CloudBotRow;
        returnFocus: HTMLElement | null;
        instanceId: string | null;
        error: string | null;
      };
  let removeDialog = $state<RemoveDialog | null>(null);
  let cloudAction = $state<{
    uid: string;
    message: string;
    isError: boolean;
    verb: "pause" | "resume";
  } | null>(null);
  let cloudActionTimeout: ReturnType<typeof setTimeout> | undefined;
  let removedCloud = $state<Set<string>>(new Set());
  let brokenAvatarSources = $state<Set<string>>(new Set());
  const visibleBots = $derived(bots.filter((bot) => !removedLocal.has(bot.name)));
  const visibleCloudBots = $derived(cloudBots.filter((bot) => !removedCloud.has(bot.uid)));
  /** Bots this pane paused; the roster carries no runtime state of its own. */
  let pausedCloud = $state<Set<string>>(new Set());

  function botAvatarSource(url: string | null | undefined): string | null {
    const source = paintableAvatarSrc(url);
    return source && !brokenAvatarSources.has(source) ? source : null;
  }

  function noteBrokenAvatar(source: string): void {
    brokenAvatarSources = new Set(brokenAvatarSources).add(source);
  }

  function runtimeLabel(id: string): string {
    return RUNTIMES.find((r) => r.id === id)?.label ?? id;
  }
  function runtimeReady(id: Runtime): boolean {
    if (!flags) return true;
    return Boolean(flags[`${id}Available`]) && Boolean(flags[`${id}LoggedIn`]);
  }
  function presenceLabel(bot: LocalBotRow): string {
    // A bot whose coding tool needs a new sign-in is up but not working.
    if (botNeedsSignIn(bot)) return "Needs sign-in";
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

  function clearLocalActionAfterSuccess(name: string): void {
    if (localActionTimeout) clearTimeout(localActionTimeout);
    localActionTimeout = setTimeout(() => {
      if (localAction?.name === name && !localAction.isError) localAction = null;
    }, SUCCESS_NOTE_MS);
  }

  function clearCloudActionAfterSuccess(uid: string): void {
    if (cloudActionTimeout) clearTimeout(cloudActionTimeout);
    cloudActionTimeout = setTimeout(() => {
      if (cloudAction?.uid === uid && !cloudAction.isError) cloudAction = null;
    }, SUCCESS_NOTE_MS);
  }

  async function load(quiet = false): Promise<boolean> {
    const api = adapter?.bots;
    if (!api) {
      loading = false;
      loadError = "";
      return false;
    }
    if (!quiet) {
      loading = true;
      loadError = "";
    }
    const result = await api.list();
    if (!result.ok) {
      loadError = friendlyApiError(result, "Could not read your local bots.", "bots");
    } else {
      const nextBots = result.value.bots ?? [];
      bots = nextBots;
      removedLocal = new Set([...removedLocal].filter((name) => !nextBots.some((bot) => bot.name === name)));
      loadError = "";
    }
    loading = false;
    return result.ok;
  }

  async function act(name: string, verb: "start" | "stop"): Promise<void> {
    const api = adapter?.bots;
    if (!api || busy) return;
    busy = name;
    localAction = {
      name,
      verb,
      message: `${verb === "start" ? "Starting" : "Stopping"}…`,
      isError: false,
    };
    const result = await api[verb](name);
    if (!result.ok) {
      if (result.message) console.warn(`[hq-desktop] local bot ${verb} failed:`, result.message);
      localAction = { name, verb, message: `Could not ${verb} ${name}. Try again.`, isError: true };
    } else {
      localAction = { name, verb, message: `${verb === "start" ? "Started" : "Stopped"}.`, isError: false };
      clearLocalActionAfterSuccess(name);
      await load(true);
    }
    busy = null;
  }

  function openLocalRemove(bot: LocalBotRow, target: EventTarget | null): void {
    removeDialog = {
      kind: "local",
      bot,
      displayName: botRowDisplayName(bot, botDisplayNames),
      returnFocus: target instanceof HTMLElement ? target : null,
      error: null,
    };
  }

  function openCloudRemove(bot: CloudBotRow, target: EventTarget | null): void {
    removeDialog = {
      kind: "cloud",
      bot,
      returnFocus: target instanceof HTMLElement ? target : null,
      instanceId: bot.machineInstanceId,
      error: null,
    };
  }

  /**
   * The line in the remove dialog after a failed attempt. The red button
   * already reads "Try again", so the line names the cause, not the action.
   */
  function removeFailedLine(name: string): string {
    return `Couldn't remove ${name}. Check your connection.`;
  }

  function closeRemoveDialog(): void {
    if (busy || cloudBusy) return;
    removeDialog = null;
  }

  async function removeLocal(dialog: Extract<RemoveDialog, { kind: "local" }>): Promise<void> {
    const api = adapter?.bots;
    if (!api || busy) return;
    busy = dialog.bot.name;
    const result = await api.remove(dialog.bot.name);
    if (!result.ok) {
      if (result.message) console.warn("[hq-desktop] local bot remove failed:", result.message);
      removeDialog = { ...dialog, error: removeFailedLine(dialog.displayName) };
    } else {
      removedLocal = new Set(removedLocal).add(dialog.bot.name);
      await load(true);
      removeDialog = null;
    }
    busy = null;
  }

  async function openCreate(): Promise<void> {
    if (onnewbot) {
      onnewbot();
      return;
    }
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

  /** agentUid → display name, for bots whose label differs from their handle. */
  let botDisplayNames = $state(loadBotDisplayNames());

  /** The flow hands us the CLI input; the same `hq bot create` the sidebar runs. */
  async function create(input: LocalBotCreateInput, extras: CreateBotExtras): Promise<void> {
    const api = adapter?.bots;
    if (!api || createBusy) return;
    createBusy = "bot";
    createError = null;
    const result = await api.create(input);
    if (!result.ok) {
      createError = friendlyApiError(result, `Could not create ${input.name}.`, "bots");
      createBusy = null;
      return;
    }
    createBusy = null;
    createOpen = false;
    const displayName = extras.displayName?.trim() ?? "";
    if (displayName) await saveDisplayName(result.value, displayName);
    line = `${displayName || input.name} is set up. It will send you a hello in Messages once it comes online.`;
    lineIsError = false;
    await load(true);
  }

  /**
   * `hq bot create` takes only the handle, so a bot named "Dr Love" is
   * created as `dr-love` and labelled on its agent profile afterwards. The
   * local copy is written first: the label must survive a failed PATCH.
   */
  async function saveDisplayName(value: unknown, displayName: string): Promise<void> {
    const uid =
      value && typeof value === "object" && typeof (value as { agentUid?: unknown }).agentUid === "string"
        ? (value as { agentUid: string }).agentUid.trim()
        : "";
    if (!uid) return;
    botDisplayNames = rememberBotDisplayName(botDisplayNames, uid, displayName);
    try {
      await adapter?.identity?.updateAgentProfile(uid, { displayName });
    } catch (err) {
      // The bot exists and works; only its label is missing in the cloud.
      console.warn("[hq-desktop] bot display name save failed:", err);
    }
  }

  async function loadRemote(): Promise<void> {
    const listRemote = adapter?.bots?.listRemote;
    if (!listRemote) return;
    // Bounded for the same reason the shell's poller is: a listing that never
    // comes back must not silently become a pane that never asks again.
    const outcome = await withPollTimeout(() => listRemote(), REMOTE_BOTS_CALL_TIMEOUT_MS);
    if (outcome.timedOut) {
      console.warn(REMOTE_BOTS_TIMEOUT_LOG);
      return;
    }
    const result = outcome.value;
    if (result.ok && Array.isArray(result.value?.bots)) {
      remoteBots = result.value.bots;
      remoteFailure = null;
      return;
    }
    // An answer we could not read is not evidence that a bot is gone: the
    // rows stay exactly as they were and only the actions change.
    if (!result.ok && result.message) {
      console.warn("[hq-desktop] remote bot list failed:", result.message);
    }
    remoteFailure = result.ok ? "malformed" : classifyRemoteBotFailure(result.reason, result.message);
  }

  /** "Start here" on a row that lives elsewhere: `hq bot adopt <name>`. */
  async function adopt(name: string): Promise<void> {
    const api = adapter?.bots;
    if (!api?.adopt || adoptBusy) return;
    adoptBusy = name;
    adoptAction = { name, message: `Bringing ${name} back to this ${hostNoun}…`, isError: false };
    const result = await api.adopt(name);
    if (!result.ok) {
      // The CLI's own words go to the log, never onto the pane.
      if (result.message) console.warn("[hq-desktop] bot adopt failed:", result.message);
      // A named refusal is permanent, so it must not read "please try again".
      adoptAction = {
        name,
        message: isNotRunnableHereReason(botFailureReason(result.message))
          ? botStaysInCloudLine(name)
          : `Could not bring ${name} back to this ${hostNoun}. Please try again.`,
        isError: true,
      };
    } else {
      adoptAction = { name, message: `${name} is back on this ${hostNoun}.`, isError: false };
      await Promise.all([load(true), loadRemote()]);
    }
    adoptBusy = null;
  }

  /** The re-offer of the first-launch prompt: `hq bot restore --all`. */
  async function restoreAll(): Promise<void> {
    const api = adapter?.bots;
    if (!api?.restore || restoreBusy) return;
    restoreBusy = true;
    restoreResult = null;
    const result = await api.restore({ all: true });
    restoreBusy = false;
    if (!result.ok || !result.value) {
      if (!result.ok && result.message) console.warn("[hq-desktop] bot restore failed:", result.message);
      restoreResult = { ok: false, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 1, bots: [] };
      return;
    }
    restoreResult = result.value;
    await Promise.all([load(true), loadRemote()]);
  }

  async function loadPreflight(): Promise<void> {
    const preflight = adapter?.sessions?.preflight;
    if (!preflight) return;
    const result = await preflight();
    if (!result.ok) return;
    const rec = result.value as Record<string, unknown>;
    const next: Record<string, boolean> = {};
    const statuses: Record<string, RuntimeStatus> = {};
    for (const id of ["claude", "codex", "grok"]) {
      next[`${id}Available`] = rec[`${id}Available`] === true;
      next[`${id}LoggedIn`] = rec[`${id}LoggedIn`] === true;
      const status = parseRuntimeStatus(rec[`${id}Status`]);
      if (status) statuses[id] = status;
    }
    flags = next;
    // Only when the host actually reported them: an empty map would read as
    // "every runtime unknown" and hide the states this exists to show.
    runtimeStatuses = Object.keys(statuses).length > 0 ? statuses : null;
  }

  /**
   * Re-run the preflight on demand (Check again / Try again in the flow).
   *
   * The old readings are kept while it runs: clearing them first would read as
   * "unknown", which the flow treats as ready, and Next would blink enabled on
   * a runtime that still cannot host a bot.
   */
  async function recheckRuntimes(): Promise<void> {
    await loadPreflight();
  }

  async function loadCloud(quiet = false): Promise<boolean> {
    const agents = adapter?.agents;
    if (!agents?.listMobileRoster) {
      cloudLoading = false;
      cloudError = "Cloud bots are unavailable in this host.";
      return false;
    }
    if (!quiet) {
      cloudLoading = true;
      cloudError = "";
    }
    try {
      const roster = await fetchCloudRoster(
        (uid) => agents.listMobileRoster(uid),
        (companies ?? []).map((company) => company.cloudUid),
      );
      if (roster.failure) {
        cloudError = friendlyApiError(roster.failure, "Could not read your cloud bots.", "bots");
      } else {
        const nextCloudBots = cloudBotsFromRoster({ agents: roster.agents }, { companies, isAdmin });
        cloudBots = nextCloudBots;
        // A successful delete hides the row immediately. A later authoritative
        // roster that still carries it wins: the server did not delete it.
        removedCloud = new Set([...removedCloud].filter((uid) => !nextCloudBots.some((bot) => bot.uid === uid)));
        cloudError = "";
      }
    } catch (error) {
      cloudError = friendlyApiError(error, "Could not read your cloud bots.", "bots");
    }
    cloudLoading = false;
    return !cloudError;
  }

  async function actCloud(bot: CloudBotRow, verb: "pause" | "resume"): Promise<void> {
    const agents = adapter?.agents;
    if (!agents || cloudBusy) return;
    cloudBusy = bot.uid;
    cloudAction = {
      uid: bot.uid,
      verb,
      message: verb === "pause" ? "Pausing…" : "Resuming…",
      isError: false,
    };
    const result = verb === "pause" ? await agents.stop(bot.uid) : await agents.start(bot.uid);
    if (!result.ok) {
      if (result.message) console.warn(`[hq-desktop] cloud bot ${verb} failed:`, result.message);
      cloudAction = { uid: bot.uid, verb, message: `Could not ${verb} ${bot.displayName}. Try again.`, isError: true };
    } else {
      const next = new Set(pausedCloud);
      if (verb === "pause") next.add(bot.uid);
      else next.delete(bot.uid);
      pausedCloud = next;
      cloudAction = { uid: bot.uid, verb, message: verb === "pause" ? "Paused." : "Resumed.", isError: false };
      clearCloudActionAfterSuccess(bot.uid);
      await loadCloud(true);
    }
    cloudBusy = null;
  }

  async function removeCloud(dialog: Extract<RemoveDialog, { kind: "cloud" }>): Promise<void> {
    const agents = adapter?.agents;
    if (!agents || cloudBusy) return;
    const { bot, instanceId } = dialog;
    cloudBusy = bot.uid;
    const result = instanceId
      ? await agents.deprovision(bot.uid, { confirmDestroyInstanceId: instanceId })
      : await agents.deprovision(bot.uid);
    const alreadyRemoved = !result.ok && result.status === 404;
    if (!result.ok && !alreadyRemoved) {
      const protectedInstanceId = result.code === "AGENTS_V2_BOX_PROTECTED" ? result.instanceId?.trim() : "";
      if (protectedInstanceId) {
        // The server, not a stale roster, names the machine that needs an
        // additional deliberate confirmation. Keep the same dialog in place.
        removeDialog = { ...dialog, instanceId: protectedInstanceId, error: null };
      } else {
        if (result.message) console.warn("[hq-desktop] cloud bot remove failed:", result.message);
        removeDialog = { ...dialog, error: removeFailedLine(bot.displayName) };
      }
    } else {
      removedCloud = new Set(removedCloud).add(bot.uid);
      removeDialog = null;
    }
    cloudBusy = null;
  }

  function confirmRemoveDialog(): void {
    if (!removeDialog) return;
    if (removeDialog.kind === "local") void removeLocal(removeDialog);
    else void removeCloud(removeDialog);
  }

  onMount(() => {
    void load();
    void loadRemote();
    void loadPreflight();
    void loadCloud();
    stopPoll = startJitteredPoll({
      intervalMs: POLL_MS,
      tick: async () => {
        await Promise.all([load(true), loadRemote(), loadCloud(true)]);
      },
    });
  });
  onDestroy(() => {
    stopPoll?.();
    if (localActionTimeout) clearTimeout(localActionTimeout);
    if (cloudActionTimeout) clearTimeout(cloudActionTimeout);
  });
</script>

<section class="settings-section bots-pane" data-testid="settings-bots">
  <p class="lead">
    Every bot you work with, in one place. Cloud bots run in a company's cloud
    and are always on; local bots run on this {hostNoun} with your own Claude Code,
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
          Local bots run from the HQ desktop app on your {hostNoun}. Open HQ
          there to create one.
        </p>
      </div>
    {:else}
      {#if loadError}
        <p class="bots-error" data-testid="settings-bots-error">
          {loadError}
          <button type="button" class="quiet" onclick={() => void load()}><RailIcon name="refresh" />Retry</button>
        </p>
      {/if}
      <div class="settings-card" data-testid="settings-bots-list">
        {#if !loading && bots.length === 0 && !loadError}
          <p class="muted empty" data-testid="settings-bots-empty">
            No local bots yet. Create one below. It takes about half a minute.
          </p>
        {/if}
        {#each visibleBots as bot (bot.name)}
          <div
            class="bot-row"
            data-testid={`settings-bot-${bot.name}`}
            data-online={bot.online === true}
          >
            <div class="bot-main">
              <strong>
                <span class="dot" class:online={bot.online === true} aria-hidden="true"></span>
                <span class="initial" aria-hidden="true">{cloudBotInitial(botRowDisplayName(bot, botDisplayNames))}</span>
                <span data-testid={`settings-bot-${bot.name}-label`}>{botRowDisplayName(bot, botDisplayNames)}</span>
                <BotKindChip kind="local" runtime={bot.runtime} variant="label" />
              </strong>
              <small>
                {runtimeLabel(bot.runtime)}{bot.model ? ` · ${bot.model}` : ""} · {presenceLabel(bot)} · {heartbeatLabel(bot)}
              </small>
              {#if localBotKindLabel(bot)}
                <small class="muted" data-testid={`settings-bot-${bot.name}-kind`}>{localBotKindLabel(bot)}</small>
              {/if}
              {#if bot.state === "failed"}
                <small class="muted" data-testid={`settings-bot-${bot.name}-stopped`}>
                  {stoppedRemedy(bot)}
                </small>
              {/if}
              {#if localAction?.name === bot.name}
                <small
                  class="muted"
                  class:error={localAction.isError}
                  aria-live="polite"
                  data-testid={`settings-bot-${bot.name}-action-status`}
                >
                  {localAction.message}
                </small>
              {/if}
            </div>
            <div class="actions">
              {#if bot.processAlive}
                <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, "stop")}><RailIcon name="stop" />
                  {busy === bot.name ? "Working…" : "Stop"}
                </button>
              {:else}
                <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, "start")}><RailIcon name="play" />
                  {busy === bot.name ? "Working…" : "Start"}
                </button>
              {/if}
              <button
                type="button"
                class="quiet"
                data-testid={`settings-bot-${bot.name}-remove`}
                disabled={Boolean(busy)}
                onclick={(event) => openLocalRemove(bot, event.currentTarget)}
              ><RailIcon name="trash" />
                Remove
              </button>
              {#if localAction?.name === bot.name && localAction.isError}
                <button
                  type="button"
                  class="quiet"
                  data-testid={`settings-bot-${bot.name}-retry-action`}
                  disabled={Boolean(busy)}
                  onclick={() => void act(bot.name, localAction!.verb)}
                >
                  Retry
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>

      {#if remoteFailureNotice}
        <!-- Bringing bots back goes through HQ Cloud. When the app cannot read
             the account's own listing, the buttons above would fail, so they
             are not offered — and this one sentence takes their place rather
             than leaving the person with an unexplained blank. -->
        <div class="settings-card" data-testid="settings-bots-remote-unavailable">
          <div class="bot-row">
            <div class="bot-main">
              <strong>Bots on other computers</strong>
              <small>{remoteFailureNotice}</small>
            </div>
            {#if remoteFailure !== "server-unsupported"}
              <div class="actions">
                <RailButton icon="refresh"
                  data-testid="settings-bots-remote-recheck"
                  disabled={restoreBusy || Boolean(adoptBusy)}
                  onclick={() => void loadRemote()}
                >
                  Check again
                </RailButton>
              </div>
            {/if}
          </div>
        </div>
      {/if}

      {#if missingHere.length > 0}
        <!-- Owned elsewhere: the bot's identity, memory and conversations are
             safe in HQ; only the half that runs it is missing here. -->
        <div class="settings-card" data-testid="settings-bots-elsewhere">
          <div class="bot-row">
            <div class="bot-main">
              <strong>On another computer</strong>
              <small>
                These bots are yours, but they aren't set up on this {hostNoun} yet.
                Bringing one back keeps its name, its memory and your
                conversations with it.
              </small>
              {#if liveElsewhere.length > 0}
                <small data-testid="settings-bots-live-elsewhere">
                  {botsLiveElsewhereNotice(liveElsewhere.length)}
                </small>
              {/if}
            </div>
            {#if adapter?.bots?.restore && !remoteFailure}
              <div class="actions">
                <button
                  type="button"
                  data-testid="settings-bots-restore-all"
                  disabled={restoreBusy || Boolean(adoptBusy)}
                  onclick={() => void restoreAll()}
                ><RailIcon name="refresh" />
                  {restoreBusy ? "Restoring…" : BOT_RESTORE_FROM_SETTINGS}
                </button>
                {#if restoreResult}
                  <div class="restore-result" aria-live="polite" data-testid="settings-bots-restore-result">
                    <small class:error={restoreResult.failed > 0}>{botRestoreSummary(restoreResult)}</small>
                    {#each restoreResult.bots ?? [] as row (row.agentUid)}
                      <small data-testid={`settings-bots-restore-row-${row.name}`}>{botRestoreRowLine(row)}</small>
                    {/each}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
          {#each missingHere as bot (bot.agentUid)}
            <div class="bot-row" data-testid={`settings-remote-bot-${bot.name}`}>
              <div class="bot-main">
                <strong>
                  <span class="dot" aria-hidden="true"></span>
                  {bot.name}
                </strong>
                <small>
                  {botLiveElsewhere(bot)
                    ? BOT_LIVE_ELSEWHERE_NOTICE
                    : "Set up on another computer"}
                </small>
              </div>
              {#if adapter?.bots?.adopt && !remoteFailure}
                <div class="actions">
                  <button
                    type="button"
                    data-testid={`settings-remote-bot-${bot.name}-start`}
                    disabled={Boolean(adoptBusy) || restoreBusy}
                    onclick={() => void adopt(bot.name)}
                  >
                    {adoptBusy === bot.name ? BOT_START_HERE_BUSY : BOT_START_HERE}
                  </button>
                  {#if adoptAction?.name === bot.name}
                    <small
                      class="muted adopt-result"
                      class:error={adoptAction.isError}
                      aria-live="polite"
                      data-testid={`settings-remote-bot-${bot.name}-action-status`}
                    >
                      {adoptAction.message}
                    </small>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <div class="settings-card create" data-testid="settings-bots-create">
        <div class="bot-main">
          <strong>New bot</strong>
          <small>Blank, from a template, or a copy of a bot you have - thinking with a tool signed in on this {hostNoun}.</small>
        </div>
        <div class="create-controls">
          <button
            type="button"
            data-testid="settings-bots-create-button"
            disabled={Boolean(busy) || createOpen}
            onclick={() => void openCreate()}
          ><RailIcon name="plus" />
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
          <button type="button" class="quiet" onclick={() => void loadCloud()}><RailIcon name="refresh" />Retry</button>
        {/if}
      </p>
    {/if}
    <div class="settings-card" data-testid="settings-bots-cloud-list">
        {#if !cloudLoading && visibleCloudBots.length === 0 && !cloudError}
        <p class="muted empty" data-testid="settings-bots-cloud-empty">
          No cloud bots yet — add one from a company channel with Add bot.
        </p>
      {/if}
      {#each visibleCloudBots as bot (bot.uid)}
        {@const avatarSource = botAvatarSource(bot.avatarUrl)}
        <div class="bot-row" data-testid={`settings-cloud-bot-${bot.uid}`} data-status={bot.status}>
          <div class="bot-main">
            <strong>
              {#if avatarSource}
                <img
                  class="bot-avatar"
                  src={avatarSource}
                  alt=""
                  onerror={() => noteBrokenAvatar(avatarSource)}
                />
              {:else}
                <span class="initial" aria-hidden="true">{cloudBotInitial(bot.displayName)}</span>
              {/if}
              {bot.displayName}
              <BotKindChip kind="cloud" variant="label" />
            </strong>
            <small>
              {#if bot.companyLabel}<CompanyLabel
                  name={bot.companyLabel}
                  companyUid={bot.companyUid}
                />{" · "}{/if}{pausedCloud.has(bot.uid)
                ? "Paused"
                : cloudBotStatusLabel(bot.status, bot.phase)}
            </small>
            {#if cloudAction?.uid === bot.uid}
              <small
                class="muted"
                class:error={cloudAction.isError}
                aria-live="polite"
                data-testid={`settings-cloud-bot-${bot.uid}-action-status`}
              >
                {cloudAction.message}
              </small>
            {/if}
          </div>
          {#if bot.canManage}
            <div class="actions">
              {#if pausedCloud.has(bot.uid)}
                <button
                  type="button"
                  data-testid={`settings-cloud-bot-${bot.uid}-resume`}
                  disabled={Boolean(cloudBusy)}
                  onclick={() => void actCloud(bot, "resume")}
                ><RailIcon name="play" />
                  {cloudBusy === bot.uid ? "Working…" : "Resume"}
                </button>
              {:else}
                <button
                  type="button"
                  data-testid={`settings-cloud-bot-${bot.uid}-pause`}
                  disabled={Boolean(cloudBusy) || bot.status === "PROVISIONING"}
                  onclick={() => void actCloud(bot, "pause")}
                ><RailIcon name="stop" />
                  {cloudBusy === bot.uid ? "Working…" : "Pause"}
                </button>
              {/if}
              <button
                type="button"
                class="quiet"
                data-testid={`settings-cloud-bot-${bot.uid}-remove`}
                disabled={Boolean(cloudBusy)}
                onclick={(event) => openCloudRemove(bot, event.currentTarget)}
              ><RailIcon name="trash" />
                Remove
              </button>
              {#if cloudAction?.uid === bot.uid && cloudAction.isError}
                <button
                  type="button"
                  class="quiet"
                  data-testid={`settings-cloud-bot-${bot.uid}-retry-action`}
                  disabled={Boolean(cloudBusy)}
                  onclick={() => void actCloud(bot, cloudAction!.verb)}
                >
                  Retry
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</section>

{#if removeDialog}
  {@const dialog = removeDialog}
  {@const dialogName = dialog.kind === "local" ? dialog.displayName : dialog.bot.displayName}
  {@const dialogAvatarSource = dialog.kind === "cloud" ? botAvatarSource(dialog.bot.avatarUrl) : null}
  {@const dialogBusy = dialog.kind === "local" ? busy === dialog.bot.name : cloudBusy === dialog.bot.uid}
  {@const machineInstanceId = dialog.kind === "cloud" ? dialog.instanceId : null}
  <CardModal
    open={true}
    title={`Say goodbye to ${dialogName}?`}
    icon="tools"
    art={SETUP_HERO_ART.dark}
    artLight={SETUP_HERO_ART.light}
    artPosition="center 42%"
    artLightPosition="center top"
    appearance="surface"
    busy={dialogBusy}
    returnFocus={dialog.returnFocus}
    onclose={closeRemoveDialog}
  >
    {#snippet heroMark()}
      <span class="remove-bot-avatar" data-testid="settings-bot-remove-dialog-avatar">
        {#if dialogAvatarSource}
          <img src={dialogAvatarSource} alt="" onerror={() => noteBrokenAvatar(dialogAvatarSource)} />
        {:else}
          <span aria-hidden="true">{cloudBotInitial(dialogName)}</span>
        {/if}
      </span>
    {/snippet}
    {#snippet body()}
      <div class="remove-dialog-body" data-testid="settings-bot-remove-dialog" data-machine={machineInstanceId ? "true" : "false"}>
        <p class="card-modal-copy">
          {#if dialog.kind === "cloud"}
            {dialogName} runs on its own cloud machine. Removing {dialogName} deletes that machine and everything on it. This can't be undone.
          {:else}
            {dialogName} will stop working and leave your bots. This can't be undone.
          {/if}
        </p>
        {#if dialog.error}
          <CardModalStatus kind="problem" text={dialog.error} />
        {/if}
      </div>
    {/snippet}
    {#snippet footer()}
      <div class="remove-dialog-actions">
        <button
          type="button"
          class="card-modal-btn is-quiet remove-dialog-button"
          data-testid="settings-bot-remove-dialog-keep"
          aria-label={`Keep ${dialogName}`}
          disabled={dialogBusy}
          onclick={closeRemoveDialog}
        >
          <span class="remove-dialog-button-label">Keep {dialogName}</span>
        </button>
        <button
          type="button"
          class="card-modal-btn is-danger remove-dialog-button"
          data-testid="settings-bot-remove-dialog-confirm"
          aria-label={dialogBusy ? `Removing ${dialogName}` : dialog.error ? "Try again" : `Remove ${dialogName}`}
          disabled={dialogBusy}
          onclick={confirmRemoveDialog}
        >
          {#if dialogBusy}
            <span class="remove-dialog-button-label">Removing {dialogName}…</span>
          {:else if dialog.error}
            <span class="remove-dialog-button-label">Try again</span>
          {:else}
            <span class="remove-dialog-button-label">Remove {dialogName}</span>
          {/if}
        </button>
      </div>
    {/snippet}
  </CardModal>
{/if}

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
        botRuntimeStatus={runtimeStatuses}
        onrecheckruntimes={recheckRuntimes}
        botWorkers={workers}
        existingNames={bots.map((b) => b.name)}
        botCompanies={localBotCompanies(companies)}
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
  .bot-avatar {
    width: 22px;
    height: 22px;
    flex: 0 0 22px;
    border-radius: 50%;
    object-fit: cover;
  }
  .actions { display: flex; align-items: center; gap: 8px; }
  .adopt-result, .restore-result { display: grid; gap: 2px; }
  .remove-bot-avatar {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    padding: 3px;
    border: 1px solid var(--v4-hairline);
    border-radius: 50%;
    background: var(--v4-surface-solid);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.24);
  }
  .remove-bot-avatar > img,
  .remove-bot-avatar > span {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    object-fit: cover;
    background: var(--v4-control-bg);
    color: var(--v4-text-2);
    font-size: 16px;
    font-weight: 600;
  }
  .remove-dialog-body { display: grid; gap: 12px; }
  /* One row, right-aligned. Each button caps at half the row so a long
     name truncates inside its button instead of wrapping the pair. */
  .remove-dialog-actions {
    display: flex;
    flex: 1 1 auto;
    flex-wrap: nowrap;
    justify-content: flex-end;
    gap: 10px;
    min-width: 0;
  }
  .remove-dialog-actions > .remove-dialog-button {
    flex: 0 1 auto;
    min-width: 0;
    max-width: calc((100% - 10px) / 2);
  }
  .remove-dialog-actions > .remove-dialog-button:disabled { opacity: 0.55; }
  /* The action under way keeps its full red while Keep steps back. */
  .remove-dialog-actions > .remove-dialog-button.is-danger:disabled { opacity: 1; cursor: progress; }
  .remove-dialog-button-label {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .create { display: grid; gap: 10px; }
  .create-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button {
    font: inherit;
    font-size: 13px;
    min-height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: default; }
  .quiet {
    border: 0;
    background: transparent;
    min-height: 0;
    padding: 0 6px;
    color: var(--v4-text-2);
  }
</style>
