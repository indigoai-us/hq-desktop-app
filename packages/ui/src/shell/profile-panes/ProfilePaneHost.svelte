<script lang="ts">
  /**
   * Name-click destination: bot or person profile, with the session pane and
   * edit sheet layered on the bot. The first frame uses the roster snapshot.
   */
  import BotProfilePane from "./BotProfilePane.svelte";
  import BotSessionPane from "./BotSessionPane.svelte";
  import EditBotSheet from "./EditBotSheet.svelte";
  import UserProfilePane from "./UserProfilePane.svelte";
  import {
    botProfileFromCache,
    userProfileFromCache,
    type BotProfileSnapshot,
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
  }: Props = $props();

  let mode = $state<"profile" | "session">("profile");
  let editing = $state(false);
  let phase = $state<SessionPhase>("live");

  const botView = $derived(
    bot ?? (name.trim() ? botProfileFromCache({ name, email, owner, live, company }) : null),
  );
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
  {#if kind === "bot" && mode === "session"}
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
      onsession={() => (mode = "session")}
      onedit={() => (editing = true)}
    />
  {:else}
    <UserProfilePane snapshot={personView} {onclose} {onmessage} {onatlas} />
  {/if}
  {#if editing}
    <EditBotSheet {name} onclose={() => (editing = false)} onsave={() => (editing = false)} />
  {/if}
</div>

<style>
  .host { position: relative; height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .host > :global(aside) { flex: 1; }
</style>
