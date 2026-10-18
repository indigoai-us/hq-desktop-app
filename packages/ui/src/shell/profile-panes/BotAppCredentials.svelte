<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { IntegrationsApi, IntegrationInstallInput } from '@hq/platform';
  import Dropdown from '../../common/Dropdown.svelte';
  import { dismissable } from '../../common/dismissable.js';
  import { credentialConfigs, credentialUpdate, type AppCredentialConfig } from './bot-app-credentials.js';
  let { config, companyUid, api, onclose, onsaved, onopenurl }: { config: AppCredentialConfig; companyUid: string; api: IntegrationsApi; onclose: () => void; onsaved: () => void; onopenurl?: (url: string) => void } = $props();
  let key = $state(''), scheme = $state(''), extra = $state(''), error = $state('');
  let busy = $state(false), done = $state(false), gone = false;
  let awaitingSignIn = $state(false), beforeUpdate = '';
  async function currentConfig() {
    const latest = await api.listConnections(companyUid);
    const target = latest.ok ? credentialConfigs(latest.value)[config.id] : null;
    if (!target || target.kind !== config.kind || target.provider !== config.provider || target.mcpUrl !== config.mcpUrl) throw new Error('Connection changed');
    return target;
  }
  async function reconnect() {
    if (busy || !onopenurl) return;
    busy = true; error = '';
    try {
      const target = await currentConfig();
      if (gone) return;
      const callback = await api.oauthCallbackUrl?.();
      if (!callback?.ok) throw new Error('Callback unavailable');
      if (gone) return;
      const result = await api.startOAuth({ companyUid, provider: target.provider, mcpUrl: target.mcpUrl, displayName: target.name, domain: target.domain, pullAllHistory: target.pullAllHistory, redirectUri: callback.value });
      if (gone) return;
      if (!result.ok || result.value.provider !== target.provider) throw new Error('Sign-in unavailable');
      const url = new URL(result.value.authorizationUrl);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid sign-in URL');
      beforeUpdate = target.updatedAt;
      onopenurl(url.href);
      awaitingSignIn = true;
    } catch { if (!gone) error = 'Could not start sign-in. Refresh the connection and try again.'; }
    finally { if (!gone) busy = false; }
  }
  async function checkSignIn() {
    if (busy) return;
    busy = true; error = '';
    try {
      const target = await currentConfig();
      if (gone) return;
      if (target.connected && target.updatedAt && target.updatedAt !== beforeUpdate) { done = true; onsaved(); }
      else error = 'Sign-in has not been confirmed yet. Finish in your browser, then check again.';
    } catch { if (!gone) error = 'Could not verify the connection. Refresh and try again.'; }
    finally { if (!gone) busy = false; }
  }
  const options = [{ value: '', label: 'Choose authentication method', disabled: true }, { value: 'bearer', label: 'Bearer token' }, { value: 'header', label: 'API key header' }, { value: 'prefix', label: 'Custom authorization prefix' }, { value: 'basic', label: 'Basic authentication' }];
  const valid = $derived(key.trim().length > 0 && (scheme === 'bearer' || scheme === 'basic' || scheme === 'header' && /^[A-Za-z0-9_-]+$/.test(extra) || scheme === 'prefix' && extra.length > 0 && extra.length <= 128 && !/[\r\n]/.test(extra)));
  function close() { if (!busy) { key = ''; extra = ''; onclose(); } }
  function wipe(node: HTMLInputElement) { return { destroy() { node.value = ''; } }; }
  onDestroy(() => { gone = true; key = ''; extra = ''; });
  async function save() {
    if (!valid || busy || config.kind !== 'key') return;
    busy = true; error = '';
    try {
      // Re-read permissions and exact target before submitting any secret.
      const latest = await api.listConnections(companyUid);
      if (gone) return;
      const target = latest.ok ? credentialConfigs(latest.value)[config.id] : null;
      if (!target || target.kind !== 'key' || target.provider !== config.provider || target.mcpUrl !== config.mcpUrl) {
        error = 'This connection or your access has changed. Close this window and refresh before trying again.'; return;
      }
      const authScheme: IntegrationInstallInput['authScheme'] = scheme === 'header' ? { placement: 'header', header: extra }
        : scheme === 'prefix' ? { placement: 'authorization', format: 'prefix', prefix: extra }
        : scheme === 'basic' ? { placement: 'authorization', format: 'basic', ...(extra ? { username: extra } : {}) }
        : { placement: 'authorization', format: 'bearer' };
      const result = await api.install(credentialUpdate(companyUid, target, key, authScheme));
      if (gone) return;
      if (!result.ok) { error = 'Could not update the connection. Check the key and authentication method, then try again.'; return; }
      const answer = result.value as { connection?: { id?: string; status?: string }; installation?: { status?: string } };
      if (answer.connection?.id !== config.id || answer.connection.status !== 'connected' || answer.installation?.status !== 'installed') {
        error = 'The update could not be verified. Refresh the connection before trying again.'; return;
      }
      done = true; onsaved();
    } catch { if (!gone) error = 'Could not reach HQ. Refresh the connection before trying again.'; }
    finally { key = ''; if (!gone) busy = false; }
  }
</script>
<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="Connection settings" tabindex="-1" use:dismissable={{ onclose: close }}>
  <header><div><h3>{config.name}</h3><p>Connection settings</p></div><button disabled={busy} aria-label="Close connection settings" onclick={close}>×</button></header>
  {#if done}<p role="status">{config.kind === 'oauth' ? 'Connection updated.' : 'Credentials updated.'}</p><button onclick={close}>Done</button>
  {:else if config.kind === 'oauth'}
    <p>Sign in to {config.name} in your browser to update access. This reconnects the shared company connection.</p>
    {#if awaitingSignIn}<p role="status">Finish signing in in your browser, then check the connection here.</p>{/if}
    {#if error}<p role="alert">{error}</p>{/if}
    <footer><button disabled={busy} onclick={close}>Close</button><button class:primary={!awaitingSignIn} disabled={busy || !onopenurl} onclick={reconnect}>{busy ? 'Please wait…' : awaitingSignIn ? 'Restart sign-in' : `Reconnect ${config.name}`}</button>{#if awaitingSignIn}<button class="primary" disabled={busy} onclick={checkSignIn}>Check connection</button>{/if}</footer>
  {:else if config.kind === 'key'}
    <p>This updates the shared company connection for everyone who uses it.</p>
    <form onsubmit={event => { event.preventDefault(); void save(); }}>
      <label>New API key<input use:wipe type="password" autocomplete="new-password" spellcheck="false" bind:value={key} disabled={busy} required /></label>
      <p class="hint">Your saved key is never displayed. The new key will be used with {new URL(config.mcpUrl).hostname}.</p>
      <div class="method"><p class="hint">Choose the authentication method required by your provider.</p><Dropdown label="Authentication method" block {options} bind:value={scheme} disabled={busy} onchange={() => extra = ''} />
        {#if scheme && scheme !== 'bearer'}<label>{scheme === 'header' ? 'Header name' : scheme === 'prefix' ? 'Authorization prefix' : 'Username (optional)'}<input bind:value={extra} disabled={busy} autocomplete="off" placeholder={scheme === 'header' ? 'X-API-Key' : scheme === 'prefix' ? 'Token' : ''} /></label>{/if}
      </div>
      {#if error}<p role="alert">{error}</p>{/if}
      <footer><button type="button" disabled={busy} onclick={close}>Cancel</button><button class="primary" disabled={busy || !valid}>{busy ? 'Updating…' : 'Update credentials'}</button></footer>
    </form>
  {:else}<p>{config.kind === 'none' ? 'This connection does not use credentials.' : 'This connection does not support API key editing here. Use its original provider sign-in or connection setup to reconnect.'}</p><footer><button onclick={close}>Done</button></footer>{/if}
</div></div>
<style>
  .overlay { position:fixed; inset:0; z-index:110; display:grid; place-items:center; padding:16px; background:rgb(0 0 0/.55); }
  .dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--v4-control-border,var(--line)); border-radius:20px; background:var(--v4-secondary-sidebar,var(--side-bg,#191919)); color:var(--v4-text-1); }
  header,footer { display:flex; align-items:center; justify-content:space-between; gap:12px; } header { margin-bottom:16px; } h3 { margin:0; font:italic 400 24px/1.3 Georgia,serif; } p { font-size:13px; line-height:1.6; } header p,.hint { color:var(--v4-text-3); font-size:12px; } form { display:grid; gap:12px; } label { display:grid; gap:8px; font-size:12px; } input { box-sizing:border-box; width:100%; border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; background:transparent; color:inherit; font:inherit; padding:10px; } button { font:inherit; color:inherit; border:1px solid var(--v4-control-border,var(--line)); background:transparent; border-radius:999px; padding:8px 12px; cursor:pointer; } button:disabled { opacity:.45; cursor:default; }.primary { background:var(--v4-primary-bg); color:var(--v4-primary-fg); } footer { justify-content:flex-end; margin-top:12px; } .method label { margin-top:12px; } [role=alert] { color:var(--v4-error); } button:focus-visible,input:focus-visible { outline:2px solid var(--v4-text-2); outline-offset:3px; }
</style>
