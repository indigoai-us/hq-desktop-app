<script lang="ts">
  import { compactNumber } from "../../common/compact-number.js";
  /**
   * Name-click destination: bot or person profile, with the session pane and
   * edit sheet layered on the bot. The first frame uses the roster snapshot.
   */
  import BotProfilePane from "./BotProfilePane.svelte";
  import BotSessionPane from "./BotSessionPane.svelte";
  import EditBotSheet from "./EditBotSheet.svelte";
  import UserProfilePane from "./UserProfilePane.svelte";
  import type { AgentsApi } from "@hq/platform";
  import {
    defaultTelemetryRange,
    jobsFromPayload,
    unavailableMessage,
    usageFromCompanyTelemetry,
  } from "../../chat/agent-detail-model.js";
  import {
    botMembershipsFromPayload,
    botProfileFromCache,
    botNameFromPayload,
    withBotMemberships,
    userProfileFromCache,
    type BotProfileSnapshot,
    type EditBotTab,
    type ProfileCompany,
    type ProfileRun,
    type SessionLine,
    type SessionPhase,
    type SessionTotals,
    type UserProfileSnapshot,
  } from "./profile-pane-model.js";

  interface Props {
    kind: "bot" | "person";
    name: string;
    email?: string | null;
    role?: string | null;
    owner?: string | null;
    company?: string | null;
    live?: boolean;
    bot?: BotProfileSnapshot | null;
    person?: UserProfileSnapshot | null;
    onclose?: () => void;
    onmessage?: () => void;
    onatlas?: () => void;
    onmanage?: () => void;
    /** Bot controls: the agent UID, where it runs, and the hq-pro agents API. */
    agentUid?: string | null;
    runtimeKind?: "local" | "cloud" | null;
    companyUid?: string | null;
    agents?: AgentsApi | null;
  }

  let {
    kind,
    name,
    email = null,
    role = null,
    owner = null,
    company = null,
    live = false,
    bot = null,
    person = null,
    onclose,
    onmessage,
    onatlas,
    onmanage,
    agentUid = null,
    runtimeKind = null,
    companyUid = null,
    agents = null,
  }: Props = $props();

  let mode = $state<"profile" | "session">("profile");
  let editing = $state(false);
  let editTab = $state<EditBotTab>("identity");
  let jobs = $state<ProfileRun[] | null>(null);
  let usage = $state<{ status: "loading" | "ready" | "unavailable"; tokens?: string; sessions?: number | null; daily?: number[]; message?: string } | null>(null);
  let memberships = $state<ProfileCompany[] | null>(null);
  /** Name from the bot's own status record; wins over the cached name. */
  let refreshedName = $state("");
  let paused = $state(false);
  let controlBusy = $state(false);
  let actionError = $state<string | null>(null);

  // Jobs and usage refresh behind the cached first frame; the usage row paints
  // a skeleton until the telemetry call settles.
  $effect(() => {
    const uid = (agentUid ?? "").trim();
    const api = agents;
    const company = companyUid ?? null;
    jobs = null;
    memberships = null;
    refreshedName = "";
    actionError = null;
    if (!uid || !api) {
      usage = null;
      return;
    }
    usage = { status: "loading" };
    let cancelled = false;
    const range = defaultTelemetryRange(30);
    // The bot's own membership list is agent-scoped, so it reads the same from
    // every company's Bots page. Until it lands the pane shows only this
    // company's row, labelled "In this company".
    void Promise.resolve()
      .then(() => api.getStatus(uid))
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          memberships = botMembershipsFromPayload(res.value);
          refreshedName = botNameFromPayload(res.value);
        }
        else console.warn("[hq-desktop] bot memberships refresh failed", res.message ?? res.reason);
      })
      .catch((err: unknown) => {
        if (!cancelled) console.warn("[hq-desktop] bot memberships refresh failed", err);
      });
    void Promise.all([
      api.listJobs(uid),
      company
        ? api.getCompanyTelemetry(company, range.from, range.to)
        : Promise.resolve({ ok: false as const, reason: "unavailable" as const, message: "No company is bound to this bot." }),
    ])
      .then(([jobsRes, usageRes]) => {
        if (cancelled) return;
        if (jobsRes.ok) {
          jobs = jobsFromPayload(jobsRes.value).map((job) => ({
            id: job.jobId,
            title: job.title,
            meta: job.cadence,
            trailing: job.active ? (job.lastRan ?? "") : "paused",
            state: job.lastOutcomeKind === "failed" ? "failed" : "done",
          }));
        }
        if (usageRes.ok) {
          const view = usageFromCompanyTelemetry(usageRes.value, uid);
          usage = {
            status: "ready",
            tokens: compactNumber(view?.tokens ?? 0),
            sessions: view?.sessions ?? 0,
            daily: view?.dailyTokens ?? [],
          };
        } else {
          usage = { status: "unavailable", message: unavailableMessage(usageRes, "usage") };
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn("[hq-desktop] bot profile refresh failed", err);
        usage = { status: "unavailable", message: "Not available yet." };
      });
    return () => {
      cancelled = true;
    };
  });

  async function setPaused(next: boolean): Promise<void> {
    const uid = (agentUid ?? "").trim();
    if (!uid || !agents || controlBusy) return;
    controlBusy = true;
    actionError = null;
    // Paint the new state this frame; roll back if the server says no.
    paused = next;
    const res = await (next ? agents.stop(uid) : agents.start(uid));
    controlBusy = false;
    if (!res.ok) {
      paused = !next;
      actionError = next ? "Could not pause the bot." : "Could not resume the bot.";
      console.warn("[hq-desktop] bot pause/resume failed", res.message ?? res.reason);
    }
  }

  function openEdit(tab: EditBotTab = "identity"): void {
    editTab = tab;
    editing = true;
  }

  function stopSession(): void {
    mode = "session";
    phase = "confirm-stop";
  }
  let phase = $state<SessionPhase>("live");

  const botName = $derived(kind === "bot" && refreshedName ? refreshedName : name);
  const cachedBot = $derived(
    bot ?? (botName.trim() ? botProfileFromCache({ name: botName, email, owner, live, company }) : null),
  );
  const botView = $derived.by(() => {
    if (!cachedBot) return cachedBot;
    const withRows = withBotMemberships(cachedBot, memberships);
    return jobs ? { ...withRows, jobs } : withRows;
  });
  const personView = $derived(
    person ?? (name.trim() ? userProfileFromCache({ name, email, role, live, company }) : null),
  );

  const totals: SessionTotals = $derived({
    elapsed: phase === "ended" ? "22:41" : "14:02",
    tokensIn: phase === "ended" ? "71.4k" : "18.2k",
    tokensOut: phase === "ended" ? "14.9k" : "4.1k",
    turns: phase === "ended" ? 14 : 6,
    model: "Opus",
    outcome: phase === "ended"
      ? "Stopped. The transcript is kept. Scheduled jobs were not touched."
      : "",
  });

  const lines = $derived<SessionLine[]>([
    { id: "s1", kind: "speech", at: "9:40:07", who: name || "bot", text: "Working from the cached session. Refresh follows in the background." },
    { id: "t1", kind: "tool", at: "9:40:09", name: "Bash", detail: "pnpm test", result: null, running: phase === "live" },
  ]);
</script>

<div class="host" data-testid="profile-pane-host" data-kind={kind} data-mode={mode}>
  {#if kind === "bot" && mode === "session" && botView}
    <BotSessionPane
      {name}
      context={botView.nowTitle}
      {lines}
      {totals}
      {phase}
      onclose={() => (mode = "profile")}
      onphase={(next) => (phase = next)}
    />
  {:else if kind === "bot"}
    <BotProfilePane
      snapshot={botView}
      {onclose}
      {onmessage}
      uid={agentUid}
      {runtimeKind}
      {usage}
      {paused}
      busy={controlBusy}
      {actionError}
      onsession={() => (mode = "session")}
      onedit={openEdit}
      onpause={() => void setPaused(true)}
      onresume={() => void setPaused(false)}
      onstop={stopSession}
    />
  {:else}
    <UserProfilePane snapshot={personView} {onclose} {onmessage} {onatlas} {onmanage} />
  {/if}
  {#if editing}
    <EditBotSheet {name} initialTab={editTab} onclose={() => (editing = false)} onsave={() => (editing = false)} />
  {/if}
</div>

<style>
  .host { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .host > :global(aside) { flex: 1; }
</style>
