<script lang="ts">
  /**
   * Settings → Bots (local-bots US-009), Work shell.
   *
   * Personal bots that run on THIS computer under the user's own model login.
   * Every action goes through the platform adapter's desktop-only `bots`
   * group, which shells to the hq CLI (`hq bot … --json`) behind the host's
   * launch boundary; nothing here talks to hq-pro directly and no credential
   * is ever shown.
   */
  import { onDestroy, onMount } from "svelte";
  import type { LocalBotRow, PlatformAdapter } from "@hq/platform";
  import { LOCAL_BOT_RUNTIMES, isValidLocalBotName } from "../chat/local-bots.js";
  import "./settings-chrome.css";

  interface Props {
    adapter?: PlatformAdapter | null;
  }
  let { adapter = null }: Props = $props();

  type Runtime = LocalBotRow["runtime"];
  const RUNTIMES = LOCAL_BOT_RUNTIMES;
  const POLL_MS = 30_000;

  let bots = $state<LocalBotRow[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let busy = $state<string | null>(null);
  let line = $state("");
  let lineIsError = $state(false);
  let newName = $state("assistant");
  let newRuntime = $state<Runtime>("claude");
  let flags = $state<Record<string, boolean> | null>(null);
  let confirmRemove = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

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
  const validBotName = isValidLocalBotName;

  async function load(quiet = false): Promise<void> {
    const api = adapter?.bots;
    if (!api) {
      loading = false;
      loadError = "Bots are only available in the HQ desktop app.";
      return;
    }
    if (!quiet) {
      loading = true;
      loadError = "";
    }
    const result = await api.list();
    if (!result.ok) {
      loadError = result.message || "Could not read your bots.";
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

  async function create(): Promise<void> {
    const api = adapter?.bots;
    const name = newName.trim().toLowerCase();
    if (!api || busy) return;
    if (!validBotName(name)) {
      line = "Use lowercase letters, digits, and single hyphens for the bot name.";
      lineIsError = true;
      return;
    }
    busy = "__create__";
    line = `Creating ${name} — this takes about half a minute…`;
    lineIsError = false;
    const result = await api.create({ name, runtime: newRuntime });
    if (!result.ok) {
      line = result.message || `Could not create ${name}.`;
      lineIsError = true;
    } else {
      line = `${name} is set up. It will send you a hello in Messages once it comes online.`;
      newName = "";
      await load(true);
    }
    busy = null;
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

  onMount(() => {
    void load();
    void loadPreflight();
    timer = setInterval(() => void load(true), POLL_MS);
  });
  onDestroy(() => clearInterval(timer));
</script>

<section class="settings-section bots-pane" data-testid="settings-bots">
  <p class="lead">
    Your personal bot runs on this Mac with your own Claude Code, Codex, or Grok
    login and works inside your HQ. Message it from the desktop app or your
    phone whenever this computer is on.
  </p>
  {#if loadError}
    <p class="bots-error" data-testid="settings-bots-error">
      {loadError}
      {#if adapter?.bots}
        <button type="button" class="quiet" onclick={() => void load()}>Retry</button>
      {/if}
    </p>
  {/if}
  <div class="settings-card" data-testid="settings-bots-list">
    {#if !loading && bots.length === 0 && !loadError}
      <p class="muted empty" data-testid="settings-bots-empty">
        No bots yet. Create one below — it takes about half a minute.
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

  {#if adapter?.bots}
    <div class="settings-card create" data-testid="settings-bots-create">
      <div class="bot-main">
        <strong>New bot</strong>
        <small>
          Pick a name and which signed-in tool it should think with.
        </small>
      </div>
      <div class="create-controls">
        <input
          type="text"
          placeholder="assistant"
          aria-label="Bot name"
          bind:value={newName}
          disabled={Boolean(busy)}
          onkeydown={(e) => {
            if (e.key === "Enter") void create();
          }}
        />
        <select aria-label="Runtime" bind:value={newRuntime} disabled={Boolean(busy)}>
          {#each RUNTIMES as r (r.id)}
            <option value={r.id}>{r.label}{runtimeReady(r.id) ? "" : " (not signed in)"}</option>
          {/each}
        </select>
        <button
          type="button"
          data-testid="settings-bots-create-button"
          disabled={Boolean(busy) || !newName.trim()}
          onclick={() => void create()}
        >
          {busy === "__create__" ? "Creating…" : "Create"}
        </button>
      </div>
      {#if !runtimeReady(newRuntime)}
        <small class="muted">
          {runtimeLabel(newRuntime)} is not signed in on this Mac yet — connect it under Agents first, or pick another.
        </small>
      {/if}
    </div>
  {/if}
  {#if line}
    <p class="status" class:error={lineIsError} aria-live="polite" data-testid="settings-bots-status">{line}</p>
  {/if}
</section>

<style>
  .bots-pane { display: grid; gap: 12px; }
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
  .actions { display: flex; align-items: center; gap: 8px; }
  .create { display: grid; gap: 10px; }
  .create-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  input, select {
    font: inherit;
    font-size: 13px;
    min-height: 36px;
    padding: 6px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: 8px;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }
  input { flex: 1 1 160px; min-width: 120px; }
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
