<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import {
    liveSessionStore,
    type Preflight,
    type ProviderLoginState,
    type SessionTool,
  } from '../lib/live-session-store.svelte';
  import { readSessionModels, type SessionModel } from '../../components/sessions/session-models';

  const PROVIDERS: Array<{ id: SessionTool; name: string; short: string }> = [
    { id: 'claude', name: 'Claude Code', short: 'Claude' },
    { id: 'codex', name: 'Codex', short: 'Codex' },
    { id: 'grok', name: 'Grok', short: 'Grok' },
  ];

  let preflight = $state<Preflight | null>(null);
  let loadError = $state('');
  let loading = $state(true);
  let busyTool = $state<SessionTool | null>(null);
  let action = $state<'install' | 'connect' | null>(null);
  let line = $state('');
  let modelsByTool = $state<Partial<Record<SessionTool, SessionModel[]>>>({});
  let modelErrorByTool = $state<Partial<Record<SessionTool, string>>>({});
  let loginState = $state<ProviderLoginState['state']>('disconnected');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function available(tool: SessionTool) {
    if (!preflight) return false;
    if (tool === 'claude') return preflight.claudeAvailable;
    if (tool === 'grok') return preflight.grokAvailable;
    return preflight.codexAvailable;
  }
  function signedIn(tool: SessionTool) {
    if (!preflight || !available(tool)) return false;
    if (tool === 'claude') return preflight.claudeLoggedIn;
    if (tool === 'grok') return preflight.grokLoggedIn;
    return preflight.codexLoggedIn;
  }
  function statusLabel(tool: SessionTool) {
    if (!preflight) return 'Checking…';
    if (signedIn(tool)) return 'Signed in on this device';
    if (available(tool)) return 'Installed, not signed in';
    return 'Not installed';
  }

  async function load(force = false) {
    loading = true;
    loadError = '';
    if (force) liveSessionStore.invalidatePreflight();
    try {
      preflight = await liveSessionStore.preflight();
      const nextModels: Partial<Record<SessionTool, SessionModel[]>> = {};
      const nextErrors: Partial<Record<SessionTool, string>> = {};
      await Promise.all(
        PROVIDERS.filter((provider) => {
          if (provider.id === 'claude') return preflight!.claudeAvailable;
          if (provider.id === 'grok') return preflight!.grokAvailable;
          return preflight!.codexAvailable;
        }).map(async (provider) => {
          try {
            const catalog = await liveSessionStore.slashCommands(provider.id, force);
            nextModels[provider.id] = readSessionModels(catalog.models, provider.id);
          } catch {
            nextModels[provider.id] = [];
            nextErrors[provider.id] =
              (provider.id === 'claude' ? preflight!.claudeLoggedIn : provider.id === 'grok' ? preflight!.grokLoggedIn : preflight!.codexLoggedIn)
                ? 'Could not load models. Connect again or retry.'
                : 'Connect to load this provider’s models.';
          }
        }),
      );
      modelsByTool = nextModels;
      modelErrorByTool = nextErrors;
    } catch {
      loadError = 'Could not read agent status. Retry.';
    } finally {
      loading = false;
    }
  }

  function stopPolling() {
    clearTimeout(timer);
    timer = undefined;
  }

  async function poll(tool: SessionTool, token: number) {
    try {
      const result = await liveSessionStore.providerLoginStatus(tool);
      if (token !== generation) return;
      loginState = result.state;
      line = result.message ?? line;
      if (result.state === 'connected') {
        stopPolling();
        busyTool = null;
        action = null;
        await load(true);
        return;
      }
      if (result.state === 'waiting') timer = setTimeout(() => void poll(tool, token), 1500);
    } catch {
      if (token === generation) {
        loginState = 'error';
        line = 'Could not check sign-in. Try Connect again.';
        busyTool = null;
      }
    }
  }

  async function connect(tool: SessionTool) {
    if (busyTool) return;
    stopPolling();
    busyTool = tool;
    action = 'connect';
    line = 'Opening sign-in…';
    const token = ++generation;
    try {
      const result = await liveSessionStore.providerLoginStart(tool);
      if (token !== generation) return;
      loginState = result.state;
      line = result.message ?? '';
      if (result.state === 'connected') {
        busyTool = null;
        action = null;
        await load(true);
        return;
      }
      if (result.state === 'waiting') timer = setTimeout(() => void poll(tool, token), 1500);
    } catch {
      if (token === generation) {
        loginState = 'error';
        line = `Could not open sign-in. If the browser did not open, run \`${tool === 'claude' ? 'claude' : tool} login\` in a terminal.`;
        busyTool = null;
      }
    }
  }

  async function install(tool: SessionTool) {
    if (busyTool) return;
    stopPolling();
    busyTool = tool;
    action = 'install';
    line = `Installing ${PROVIDERS.find((provider) => provider.id === tool)?.name ?? tool}…`;
    try {
      await liveSessionStore.installProvider(tool, (next) => {
        line = next;
      });
      line = 'Installed. Connect to sign in.';
      await load(true);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      line = detail.trim() || 'Install failed. Check your network and try again.';
    } finally {
      busyTool = null;
      action = action === 'install' ? null : action;
    }
  }

  onMount(() => {
    void load();
  });
  onDestroy(() => {
    ++generation;
    stopPolling();
  });
</script>

<section id="agents" class="settings-section" data-testid="settings-agents">
  <h2>Agents</h2>
  <p class="lead">
    Sessions use the Claude, Codex, or Grok CLI on this Mac. HQ can install the CLI and open the provider’s own sign-in. HQ sign-in is separate.
  </p>
  {#if loadError}
    <p class="error" role="alert">{loadError} <button type="button" class="quiet" onclick={() => void load(true)}>Retry</button></p>
  {/if}
  <div class="settings-card" data-testid="settings-agents-list">
    {#each PROVIDERS as provider}
      {@const ready = signedIn(provider.id)}
      {@const installed = available(provider.id)}
      {@const models = modelsByTool[provider.id] ?? []}
      {@const modelError = modelErrorByTool[provider.id]}
      <div class="agent-row" data-testid={`settings-agent-${provider.id}`}>
        <div>
          <strong>{provider.name}</strong>
          <small>{statusLabel(provider.id)}</small>
          {#if ready && models.length}
            <p class="models" data-testid={`settings-agent-${provider.id}-models`}>
              Models: {models.filter((model) => model.value).map((model) => model.label).join(', ') || 'Default'}
            </p>
          {:else if installed && modelError}
            <p class="models muted">{modelError}</p>
          {:else if ready}
            <p class="models muted">Usage stays with this provider’s account. Remaining quota is not shown in HQ yet.</p>
          {:else}
            <p class="models muted">Usage stays with this provider’s account. Remaining quota is not shown in HQ yet.</p>
          {/if}
        </div>
        <div class="actions">
          {#if ready}
            <span class="ok">Ready</span>
          {:else if installed}
            <button
              type="button"
              disabled={Boolean(busyTool) || loading}
              onclick={() => void connect(provider.id)}
            >
              {busyTool === provider.id && action === 'connect' ? 'Connecting…' : `Connect ${provider.short}`}
            </button>
          {:else}
            <button
              type="button"
              disabled={Boolean(busyTool) || loading}
              onclick={() => void install(provider.id)}
            >
              {busyTool === provider.id && action === 'install' ? 'Installing…' : `Install ${provider.short}`}
            </button>
          {/if}
        </div>
      </div>
    {/each}
  </div>
  {#if line}
    <p class="status" class:error={loginState === 'error'} aria-live="polite">{line}</p>
  {/if}
  {#if loginState === 'waiting'}
    <p class="status">Finish signing in in your browser. HQ will detect it automatically.</p>
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
  .lead, .models, .status, .error, small {
    font-size: 12px;
    line-height: 1.55;
    color: var(--v4-text-2);
    margin: 0;
  }
  .lead { margin: 0 0 8px; }
  .muted { color: var(--v4-text-3); }
  .error { color: var(--v4-danger, #dcaaa0); }
  .agent-row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 0;
    border-bottom: 1px solid var(--v4-hairline);
  }
  .agent-row:last-child { border-bottom: 0; }
  .agent-row strong { display: block; font-size: 14px; font-weight: 600; }
  .agent-row small { display: block; margin-top: 4px; }
  .models { margin-top: 8px; max-width: 42ch; }
  .actions { display: flex; align-items: center; gap: 8px; }
  .ok { font-size: 12px; color: var(--v4-text-3); }
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
  .quiet {
    border: 0;
    background: transparent;
    min-height: 0;
    padding: 0 6px;
    color: var(--v4-text-2);
  }
</style>
