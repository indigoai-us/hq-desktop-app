<script lang="ts">
  /**
   * Preview stage for the cloud bot pane's tabs
   * (packages/ui/src/shell/profile-panes/cloud/CloudBotPane.svelte) over an
   * in-memory control API. ?tab=channels|routines|persona|brain opens a tab,
   * ?offline=1 shows the offline state, ?empty=1 the empty states. Size the
   * viewport to ~900x760.
   */
  import type { AgentControlApi } from "@hq/platform";
  import CloudBotPane from "../../../packages/ui/src/shell/profile-panes/cloud/CloudBotPane.svelte";
  import { rememberTab } from "../../../packages/ui/src/shell/profile-panes/cloud/cloud-bot-tabs.js";

  const params = new URLSearchParams(window.location.search);
  const offline = params.get("offline") === "1";
  const empty = params.get("empty") === "1";
  const UID = "agt_01PREVIEW";
  const tab = params.get("tab");
  if (tab) rememberTab(UID, tab);

  const hour = 3600_000;
  const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

  const state = {
    agent: {
      uid: UID,
      displayName: "Nova",
      title: "Research analyst",
      avatarUrl: null,
      online: !offline,
      lastSeenAt: offline ? iso(-2 * hour) : null,
    },
    channels: [
      { kind: "hq", enabled: true, status: "connected", detail: null },
      { kind: "slack", enabled: true, status: "connected", detail: "#research, #ops" },
      { kind: "telegram", enabled: false, status: "not_connected", detail: null },
      { kind: "email", enabled: false, status: "connected", detail: "nova@indigo.example" },
    ],
    routines: empty
      ? []
      : [
          { id: "r1", name: "Morning brief", schedule: "0 9 * * 1-5", timezone: "America/Denver", prompt: "Summarize overnight messages and post the brief in #ops.", enabled: true, lastRunAt: iso(-20 * hour), nextRunAt: iso(3 * hour), lastStatus: "ok" },
          { id: "r2", name: "Competitor scan", schedule: "0 14 * * 1", timezone: "America/Denver", prompt: "Check competitor changelogs and flag anything new.", enabled: true, lastRunAt: iso(-6 * 24 * hour), nextRunAt: iso(26 * hour), lastStatus: "failed" },
          { id: "r3", name: "Inbox sweep", schedule: "*/30 * * * *", timezone: "UTC", prompt: "Triage the shared inbox.", enabled: false, lastRunAt: null, nextRunAt: null, lastStatus: null },
        ],
    persona: {
      displayName: "Nova",
      title: "Research analyst",
      description: "Tracks the market and writes short briefs for the team.",
      instructions: empty
        ? ""
        : "You are Nova, the team's research analyst.\n\nKeep answers short. Lead with the finding, then the source.\nWhen you are not sure, say so and name what would settle it.\nPost briefs in #ops before 9:30 on weekdays.\nNever share client names outside the company.\nUse plain words. No jargon.",
      instructionsPath: "SOUL.md",
      updatedAt: iso(-3 * 24 * hour),
    },
    brain: {
      model: "claude-opus-5-5",
      provider: "Anthropic",
      availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    },
    source: "live",
    fetchedAt: iso(0),
  };


  const ok = (value: unknown) => Promise.resolve({ ok: true as const, value });
  const refuse = () =>
    Promise.resolve({ ok: false as const, reason: "error" as const, code: "BOX_OFFLINE", message: "The bot's computer is not answering." });
  const write = <T,>(fn: () => T) => (offline ? refuse() : ok(fn()));

  const api: AgentControlApi = {
    getControl: () => ok(structuredClone(state)),
    listChannels: () => ok(state.channels),
    updateChannel: (_u, kind, patch) =>
      write(() => {
        const ch = state.channels.find((c) => c.kind === kind)!;
        if (typeof patch.enabled === "boolean") ch.enabled = patch.enabled;
        return ch;
      }),
    listRoutines: () => ok(state.routines),
    createRoutine: (_u, input) =>
      write(() => {
        const r = { id: `r${state.routines.length + 1}`, timezone: null, enabled: true, lastRunAt: null, nextRunAt: null, lastStatus: null, ...input };
        state.routines.push(r as (typeof state.routines)[number]);
        return r;
      }),
    updateRoutine: (_u, id, patch) => write(() => Object.assign(state.routines.find((r) => r.id === id)!, patch)),
    deleteRoutine: (_u, id) => write(() => void (state.routines = state.routines.filter((r) => r.id !== id))),
    runRoutine: () => write(() => ({ started: true })),
    getPersona: () => ok(state.persona),
    updatePersona: (_u, patch) => write(() => ({ persona: Object.assign(state.persona, patch) })),
    getBrain: () => ok(state.brain),
    setModel: (_u, model) => write(() => ((state.brain.model = model), { model })),
  };
</script>

<div class="stage" data-testid="agent-control-preview">
  <div class="conversation" aria-hidden="true"></div>
  <div class="column">
    <CloudBotPane uid={UID} name="nova" live={!offline} control={api} onconnect={() => {}} onopenurl={() => {}} />
  </div>
</div>

<style>
  .stage {
    display: flex;
    height: 100vh;
    background: var(--v4-ground);
  }
  .conversation { flex: 1; }
  .column {
    height: 100%;
    border-left: 1px solid var(--v4-rowline, var(--line));
  }
</style>
