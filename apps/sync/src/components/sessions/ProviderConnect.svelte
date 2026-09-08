<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { SessionToolId } from './session-models';
  import { liveSessionStore, type ProviderLoginState } from '../../desktop-alt/lib/live-session-store.svelte';
  interface Props {
    selected: SessionToolId;
    claudeAvailable: boolean;
    codexAvailable: boolean;
    claudeConnected: boolean;
    codexConnected: boolean;
    onconnected: (tool: SessionToolId) => void;
    onchoose: (tool: SessionToolId) => void;
    onrefresh?: () => Promise<void>;
  }
  let { selected, claudeAvailable, codexAvailable, claudeConnected, codexConnected, onconnected, onchoose, onrefresh }: Props = $props();
  let active = $state<SessionToolId | null>(null);
  let loginState = $state<ProviderLoginState['state']>('disconnected');
  let message = $state('');
  let busy = $state(false);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const name = (tool: SessionToolId) => tool === 'claude' ? 'Claude Code' : 'Codex';
  const available = (tool: SessionToolId) => tool === 'claude' ? claudeAvailable : codexAvailable;
  const connected = (tool: SessionToolId) => available(tool) && (tool === 'claude' ? claudeConnected : codexConnected);
  function stopPolling() { clearTimeout(timer); timer = undefined; }
  function apply(result: ProviderLoginState, tool: SessionToolId, token: number) {
    if (token !== generation) return;
    loginState = result.state;
    message = result.message ?? '';
    if (result.state === 'connected') { stopPolling(); onconnected(tool); }
    else if (result.state === 'waiting') timer = setTimeout(() => void poll(tool, token), 1500);
  }
  async function poll(tool: SessionToolId, token: number) {
    try { apply(await liveSessionStore.providerLoginStatus(tool), tool, token); }
    catch { if (token === generation) { loginState = 'error'; message = 'Could not check sign-in. Please try again.'; } }
  }
  async function start(tool: SessionToolId) {
    if (busy || loginState === 'waiting') return;
    stopPolling(); active = tool; busy = true; message = '';
    const token = ++generation;
    try { apply(await liveSessionStore.providerLoginStart(tool), tool, token); }
    catch { if (token === generation) { loginState = 'error'; message = 'Could not open sign-in. Check that the provider is installed, then try again.'; } }
    finally { if (token === generation) busy = false; }
  }
  async function cancel() {
    const tool = active;
    if (!tool || busy) return;
    stopPolling(); const token = ++generation; busy = true;
    try { const result = await liveSessionStore.providerLoginCancel(tool); if (token !== generation) return; apply(result, tool, token); if (result.state === 'disconnected') { active = null; message = ''; } }
    catch { loginState = 'error'; message = 'Could not cancel sign-in. Try again.'; }
    finally { busy = false; }
  }
  async function check() {
    if (busy || loginState === 'waiting') return;
    active = selected; busy = true; message = '';
    const token = ++generation;
    try { await onrefresh?.(); apply(await liveSessionStore.providerLoginStatus(selected), selected, token); if (token === generation && loginState === 'disconnected') message = 'No sign-in found yet. Connect an agent to continue.'; }
    catch { if (token === generation) { loginState = 'error'; message = 'Could not check sign-in. Please try again.'; } }
    finally { if (token === generation) busy = false; }
  }
  onDestroy(() => { ++generation; stopPolling(); });
</script>

<section class="connect" aria-label="Connect an agent" data-testid="provider-connect">
  <div class="eyebrow">Your agents, inside HQ</div>
  <h2>Connect an agent to continue.</h2>
  <p>Use your Claude or ChatGPT account. You only need one to get started.</p>
  <div class="providers">
    {#each ['claude', 'codex'] as id}
      {@const tool = id as SessionToolId}
      <div class="provider">
        <div class="identity"><strong>{name(tool)}</strong><span>{connected(tool) ? 'Connected on this device' : available(tool) ? 'Not connected on this device' : 'Not installed on this device'}</span></div>
        {#if connected(tool)}
          <button disabled={busy || loginState === 'waiting'} onclick={() => onchoose(tool)}>Use {name(tool)}</button>
        {:else if available(tool)}
          <button class:primary={tool === selected} disabled={busy || loginState === 'waiting'} onclick={() => void start(tool)}>{busy && active === tool ? 'Opening sign-in…' : `Connect ${tool === 'claude' ? 'Claude' : 'Codex'}`}</button>
        {:else}
          <span class="install-note">Install {name(tool)}, then check again.</span>
        {/if}
      </div>
    {/each}
  </div>
  {#if active && (loginState === 'waiting' || loginState === 'error' || message)}
    <div class="flow" aria-live="polite">
      {#if loginState === 'waiting'}
        <strong>Finish signing in to {name(active)} in your browser.</strong>
        <p>HQ will detect the connection automatically. Your draft stays here.</p>
        <div class="waiting">Waiting for browser sign-in…</div>
        <button class="quiet" disabled={busy} onclick={() => void cancel()}>Cancel sign-in</button>
      {:else}
        <p class:error={loginState === 'error'}>{message || 'Sign-in did not complete.'}</p>
        <button disabled={busy} onclick={() => void start(active!)}>Try again</button>
        <button class="quiet" disabled={busy} onclick={() => void cancel()}>Cancel</button>
      {/if}
    </div>
  {/if}
  <div class="foot"><button class="quiet" disabled={busy || loginState === 'waiting'} onclick={() => void check()}>{busy ? 'Checking…' : 'Already signed in? Check again'}</button><span>HQ sign-in is separate. Your provider’s plan and limits apply.</span></div>
</section>

<style>
  .connect{width:min(600px,100%);box-sizing:border-box;margin:24px auto;padding:24px;flex-shrink:0;color:var(--v4-text-1);font-family:var(--font-sans)}
  .eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--v4-text-3);margin-bottom:12px}
  h2{font-size:24px;font-weight:550;letter-spacing:-.5px;line-height:1.25;margin:0 0 10px}
  p{font-size:13px;line-height:1.6;color:var(--v4-text-2);margin:0 0 18px}
  .providers{border-top:1px solid var(--v4-hairline);margin-top:24px}
  .provider{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding:18px 0;border-bottom:1px solid var(--v4-hairline)}
  .identity{display:grid;gap:6px}.identity strong{font-size:15px;font-weight:600}.identity span,.install-note{font-size:12px;color:var(--v4-text-3)}
  button{font:inherit;font-size:13px;min-height:40px;padding:8px 14px;border:1px solid var(--v4-hairline);border-radius:8px;background:var(--v4-control-bg);color:var(--v4-text-1);cursor:pointer}
  button:hover:not(:disabled){background:var(--v4-active-row)}button:focus-visible{outline:2px solid var(--v4-text-2);outline-offset:3px}button:disabled{opacity:.5;cursor:default}
  .primary{background:var(--v4-text-1);color:var(--v4-bg,var(--v4-raised));border-color:transparent}.primary:hover:not(:disabled){opacity:.85;background:var(--v4-text-1)}
  .quiet{border-color:transparent;background:transparent;color:var(--v4-text-2);padding-inline:0;margin-right:16px}
  .flow{padding-top:20px}.flow strong{font-size:14px}.flow p{margin:8px 0}.waiting{font-size:12px;color:var(--v4-text-2);margin:12px 0}.error{color:var(--v4-danger,#dcaaa0)}
  .foot{display:grid;gap:5px;margin-top:12px;justify-items:start}.foot span{font-size:11px;line-height:1.6;color:var(--v4-text-3)}
  @media(max-width:520px){.connect{padding:16px;margin:12px auto}h2{font-size:21px}}
</style>
