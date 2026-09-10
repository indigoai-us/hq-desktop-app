<script lang="ts">
  /**
   * Settings → Bots (local-bots US-009).
   *
   * Personal bots that run on THIS computer under the user's own model login.
   * Every action goes to the hq CLI through the host's launch boundary
   * (`local_bots_*` commands → `hq bot … --json`); nothing here talks to
   * hq-pro directly and no credential is ever shown.
   */
  import { onDestroy, onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { liveSessionStore, type Preflight } from '../lib/live-session-store.svelte';

  type Runtime = 'claude' | 'codex' | 'grok';
  interface BotRow {
    name: string;
    agentUid: string;
    runtime: Runtime;
    model?: string;
    state: string;
    pid: number | null;
    processAlive: boolean;
    online: boolean | null;
    lastHeartbeatAt: string | null;
    daemonInstalled: boolean;
    daemonLoaded: boolean;
  }

  const RUNTIMES: Array<{ id: Runtime; label: string }> = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'codex', label: 'Codex' },
    { id: 'grok', label: 'Grok' },
  ];
  const POLL_MS = 30_000;
  const MAX_BOTS = 3;

  let bots = $state<BotRow[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let busy = $state<string | null>(null);
  let line = $state('');
  let lineIsError = $state(false);
  let newName = $state('assistant');
  let newRuntime = $state<Runtime>('claude');
  let preflight = $state<Preflight | null>(null);
  let confirmRemove = $state<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  function runtimeLabel(id: string): string {
    return RUNTIMES.find((r) => r.id === id)?.label ?? id;
  }
  function runtimeReady(id: Runtime): boolean {
    if (!preflight) return true;
    if (id === 'claude') return preflight.claudeAvailable && preflight.claudeLoggedIn;
    if (id === 'codex') return preflight.codexAvailable && preflight.codexLoggedIn;
    return preflight.grokAvailable && preflight.grokLoggedIn;
  }
  function presenceLabel(bot: BotRow): string {
    if (bot.online === true) return 'Online';
    if (bot.state === 'failed') return 'Stopped after errors';
    if (bot.processAlive) return 'Starting…';
    return 'Offline';
  }
  function heartbeatLabel(bot: BotRow): string {
    if (!bot.lastHeartbeatAt) return 'Never checked in';
    const t = Date.parse(bot.lastHeartbeatAt);
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `Checked in ${s}s ago`;
    const m = Math.round(s / 60);
    if (m < 60) return `Checked in ${m}m ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `Checked in ${h}h ago` : `Checked in ${Math.round(h / 24)}d ago`;
  }
  function validName(name: string): boolean {
    return /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name) && !name.includes('--');
  }

  async function load(quiet = false): Promise<void> {
    if (!quiet) {
      loading = true;
      loadError = '';
    }
    try {
      const result = await invoke<{ bots?: BotRow[] }>('local_bots_list');
      bots = result.bots ?? [];
      loadError = '';
    } catch (err) {
      loadError = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function act(name: string, command: 'local_bots_start' | 'local_bots_stop' | 'local_bots_remove', verb: string): Promise<void> {
    if (busy) return;
    busy = name;
    line = `${verb} ${name}…`;
    lineIsError = false;
    try {
      await invoke(command, { name });
      line = '';
      await load(true);
    } catch (err) {
      line = err instanceof Error ? err.message : String(err);
      lineIsError = true;
    } finally {
      busy = null;
      confirmRemove = null;
    }
  }

  async function create(): Promise<void> {
    const name = newName.trim().toLowerCase();
    if (busy) return;
    if (!validName(name)) {
      line = 'Use lowercase letters, digits, and single hyphens for the bot name.';
      lineIsError = true;
      return;
    }
    busy = '__create__';
    line = `Creating ${name} — this takes about half a minute…`;
    lineIsError = false;
    try {
      await invoke('local_bots_create', { name, runtime: newRuntime });
      line = `${name} is set up. It will send you a hello in Messages once it comes online.`;
      newName = '';
      await load(true);
    } catch (err) {
      line = err instanceof Error ? err.message : String(err);
      lineIsError = true;
    } finally {
      busy = null;
    }
  }

  onMount(() => {
    void load();
    void liveSessionStore.preflight().then((p) => (preflight = p)).catch(() => {});
    timer = setInterval(() => void load(true), POLL_MS);
  });
  onDestroy(() => clearInterval(timer));
</script>

<section id="bots" class="settings-section" data-testid="settings-bots">
  <h2>Bots</h2>
  <p class="lead">
    Your personal bot runs on this Mac with your own Claude Code, Codex, or Grok login and works inside your HQ. Message it from the desktop app or your phone whenever this computer is on.
  </p>
  {#if loadError}
    <p class="bots-error" data-testid="settings-bots-error">{loadError} <button type="button" class="quiet" onclick={() => void load()}>Retry</button></p>
  {/if}
  <div class="settings-card" data-testid="settings-bots-list">
    {#if !loading && bots.length === 0}
      <p class="muted empty" data-testid="settings-bots-empty">No bots yet. Create one below — it takes about half a minute.</p>
    {/if}
    {#each bots as bot (bot.name)}
      <div class="bot-row" data-testid={`settings-bot-${bot.name}`} data-online={bot.online === true}>
        <div class="bot-main">
          <strong>
            <span class="dot" class:online={bot.online === true} aria-hidden="true"></span>
            {bot.name}
          </strong>
          <small>{runtimeLabel(bot.runtime)}{bot.model ? ` · ${bot.model}` : ''} · {presenceLabel(bot)} · {heartbeatLabel(bot)}</small>
          {#if bot.state === 'failed'}
            <small class="muted">The bot stopped after repeated errors. Check that {runtimeLabel(bot.runtime)} is signed in, then start it again.</small>
          {/if}
        </div>
        <div class="actions">
          {#if bot.processAlive}
            <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, 'local_bots_stop', 'Stopping')}>
              {busy === bot.name ? 'Working…' : 'Stop'}
            </button>
          {:else}
            <button type="button" disabled={Boolean(busy)} onclick={() => void act(bot.name, 'local_bots_start', 'Starting')}>
              {busy === bot.name ? 'Working…' : 'Start'}
            </button>
          {/if}
          {#if confirmRemove === bot.name}
            <button type="button" class="danger" disabled={Boolean(busy)} onclick={() => void act(bot.name, 'local_bots_remove', 'Removing')}>
              Really remove
            </button>
            <button type="button" class="quiet" disabled={Boolean(busy)} onclick={() => (confirmRemove = null)}>Keep</button>
          {:else}
            <button type="button" class="quiet" disabled={Boolean(busy)} onclick={() => (confirmRemove = bot.name)}>Remove</button>
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="settings-card create" data-testid="settings-bots-create">
    <div class="bot-main">
      <strong>New bot</strong>
      <small>
        {#if bots.length >= MAX_BOTS}
          You have {MAX_BOTS} bots, the most this version allows. Remove one to create another.
        {:else}
          Pick a name and which signed-in tool it should think with.
        {/if}
      </small>
    </div>
    <div class="create-controls">
      <input
        type="text"
        placeholder="assistant"
        aria-label="Bot name"
        bind:value={newName}
        disabled={Boolean(busy) || bots.length >= MAX_BOTS}
        onkeydown={(e) => {
          if (e.key === 'Enter') void create();
        }}
      />
      <select aria-label="Runtime" bind:value={newRuntime} disabled={Boolean(busy) || bots.length >= MAX_BOTS}>
        {#each RUNTIMES as r}
          <option value={r.id}>{r.label}{runtimeReady(r.id) ? '' : ' (not signed in)'}</option>
        {/each}
      </select>
      <button
        type="button"
        data-testid="settings-bots-create-button"
        disabled={Boolean(busy) || bots.length >= MAX_BOTS || !newName.trim()}
        onclick={() => void create()}
      >
        {busy === '__create__' ? 'Creating…' : 'Create'}
      </button>
    </div>
    {#if !runtimeReady(newRuntime)}
      <small class="muted">{runtimeLabel(newRuntime)} is not signed in on this Mac yet — connect it under Agents first, or pick another.</small>
    {/if}
  </div>
  {#if line}
    <p class="status" class:error={lineIsError} aria-live="polite" data-testid="settings-bots-status">{line}</p>
  {/if}
</section>

<style>
  h2 {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-weight: 500;
    line-height: 1.25;
  }
  .lead, .status, .bots-error, small {
    font-size: 12px;
    line-height: 1.55;
    color: var(--v4-text-2);
    margin: 0;
  }
  .lead { margin: 0 0 8px; }
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
  .create { display: grid; gap: 10px; padding-top: 14px; }
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
