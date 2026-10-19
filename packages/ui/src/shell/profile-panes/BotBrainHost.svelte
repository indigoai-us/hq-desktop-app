<script lang="ts">
  import { untrack } from 'svelte';
  import type { PlatformAdapter, LocalBotRow } from '@hq/platform';
  import { profileFromPayload } from '../../chat/agent-detail-model.js';
  import { brainApprovalFromStatus, approvalOpenUrl, approvalExpired, type BrainApproval } from '../../chat/create-bot/bot-brain-approval.js';
  import RuntimeSignIn, { type RuntimeSignInState } from '../../chat/create-bot/RuntimeSignIn.svelte';
  import { startVisibleInterval } from '../../common/visible-interval.js';
  import { dismissable } from '../../common/dismissable.js';
  import { portal, focusOnMount } from '../../chat/portal.js';
  import BotBrainPanel, { type BrainSwitchProgress } from './BotBrainPanel.svelte';
  import { BRAIN_PROVIDERS, brainRow, providerId, loginState, type BrainProvider, type BrainRow } from './bot-brain.js';
  let { uid, name, runtimeKind, adapter = null, onopenurl }: { uid: string | null; name: string; runtimeKind?: 'local' | 'cloud' | null; adapter?: PlatformAdapter | null; onopenurl?: (url: string) => void } = $props();
  let rows = $state<BrainRow[]>(BRAIN_PROVIDERS.map(p => brainRow(p.id)));
  let local = $state<LocalBotRow | null>(null);
  let loading = $state(true), error = $state(''), notice = $state('');
  let signing = $state<BrainProvider | null>(null), approval = $state<BrainApproval | null>(null);
  let code = $state(''), signError = $state(''), submitting = $state(false);
  const stableUid = $derived(uid);
  const stableRuntimeKind = $derived(runtimeKind);
  const stableAdapter = $derived(adapter);
  let generation = 0, readNumber = 0;
  let checking = $state(false);
  let multiProvider = false, signAttempt = 0, signStartedAt = 0;
  const launchFailure = 'Fleet could not launch sign-in on this bot. You can retry here. If it fails again, a Fleet administrator needs to repair the provider login service.';
  let starting = $state(false);
  let switching = $state<BrainSwitchProgress | null>(null), canSwitch = $state(false), switchAttempt = 0;
  let signFailed = $state(false);
  const isLocal = $derived(runtimeKind === 'local');
  const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  function signState(result: { ok: boolean; value?: unknown }): RuntimeSignInState {
    const state = record(result.value)?.state;
    return { state: result.ok && ['connected','waiting','disconnected','error'].includes(String(state)) ? state as RuntimeSignInState['state'] : 'error' };
  }
  async function refresh() {
    const version = generation, request = ++readNumber, api = adapter, bot = uid;
    loading = true; error = '';
    try {
      if (!api || !bot) throw new Error('Unavailable');
      if (isLocal) {
        if (!api.bots) throw new Error('Local bots unavailable');
        const [listed, ...logins] = await Promise.all([api.bots.list(), ...BRAIN_PROVIDERS.map(async p => { try { return await api.sessions.loginStatus?.(p.id); } catch { return null; } })]);
        if (version !== generation || request !== readNumber) return;
        // The uid, not the display name, identifies which local bot may be configured.
        local = listed && listed.ok && 'bots' in listed.value ? (listed.value as { bots: LocalBotRow[] }).bots.find(row => row.agentUid === bot) ?? null : null;
        if (!local) throw new Error('Local bot missing');
        rows = BRAIN_PROVIDERS.map((p, i) => {
          const result = logins[i];
          const active = local?.runtime === p.id;
          return { ...brainRow(p.id, active ? local?.model : ''), active, effort: active && !local?.effortIsDefault ? local?.effort ?? '' : '', state: result?.ok ? loginState(record(result.value)?.state) : 'unknown', canConnect: !!api.sessions.loginStart && !!api.sessions.loginStatus, canSave: active && !!api.bots?.configure, detail: active ? 'Configure the model this local bot uses. Sign-in is shared by local bots using this provider.' : 'You can connect this provider on this computer. Switching this bot’s runtime is not supported here yet.' };
        });
      } else {
        const result = await api.agents.getProfile?.(bot);
        if (version !== generation || request !== readNumber) return;
        const view = result?.ok ? profileFromPayload(result.value, { uid: bot, displayName: name }) : null;
        if (!view?.hasBox || view.freshness.source !== 'live') throw new Error('Cloud status unavailable');
        multiProvider = result?.ok === true && record(record(result.value)?.agent)?.provider === 'agents-v2';
        const activeId = providerId(view.brain.provider);
        canSwitch = multiProvider && !!api.agents.fetch;
        rows = BRAIN_PROVIDERS.map(p => ({ ...brainRow(p.id, p.id === activeId ? view.brain.model ?? '' : ''), models: brainRow(p.id, p.id === activeId ? view.brain.model ?? '' : '').models.filter(choice => choice.value !== ''), active: p.id === activeId, effort: p.id === activeId ? view.brain.reasoningEffort ?? '' : '', state: loginState(view.brain.logins.find(login => providerId(login.provider) === p.id)?.status), canConnect: !!(multiProvider ? api.agents.fetch : api.agents.restartBrainApproval) && !!onopenurl, canSave: p.id === activeId && !!api.agents.fetch, detail: p.id === activeId ? 'Choose the model and thinking level this bot uses for future messages.' : multiProvider ? 'Connected and ready. Use this brain to move the bot onto it; the current brain stays signed in.' : 'Connect this account for setup. Switching this cloud bot to another provider requires a separate runtime migration.' }));
      }
    } catch { if (version === generation && request === readNumber) { local = null; rows = BRAIN_PROVIDERS.map(p => brainRow(p.id)); error = 'Could not verify this bot’s brain configuration. Refresh to try again.'; } }
    finally { if (version === generation && request === readNumber) loading = false; }
  }
  function closeSignIn() { if (!submitting && !starting) { signAttempt++; signFailed = false; signing = null; approval = null; code = ''; signError = ''; } }
  async function checkSignIn() {
    const api = adapter, bot = uid, provider = signing, version = generation, attempt = signAttempt;
    if (!api || !bot || !provider || isLocal || checking || starting) return;
    checking = true;
    try {
      const result = await api.agents.getStatus(bot, provider);
      if (version !== generation || provider !== signing || attempt !== signAttempt) return;
      if (!result.ok) { signError = 'Could not check sign-in. Try checking again.'; return; }
      const root = record(result.value), agent = record(root?.agent);
      if (root?.signIn === 'failed') { signFailed = true; approval = null; signError = launchFailure; return; }
      const signedIn = record(record(root?.brainSignIn ?? agent?.brainSignIn)?.[provider])?.signedIn === true;
      if (signedIn) { signing = null; approval = null; code = ''; signError = ''; await refresh(); notice = 'Provider sign-in confirmed. Connecting does not change the active model.'; return; }
      const next = brainApprovalFromStatus(result.value, provider);
      if (next?.provider === provider) { approval = next; signFailed = false; signError = ''; }
      const details = await api.agents.getProfile?.(bot);
      if (version !== generation || signing !== provider || attempt !== signAttempt) return;
      const view = details?.ok ? profileFromPayload(details.value, { uid: bot, displayName: name }) : null;
      if (view?.freshness.source === 'live' && view.brain.logins.some(login => providerId(login.provider) === provider && loginState(login.status) === 'connected')) {
        signing = null; approval = null; code = ''; await refresh(); notice = 'Provider sign-in confirmed. Connecting does not change the active model.';
      }
      if (signing && !approval && Date.now() - signStartedAt > 90000) { signFailed = true; signError = 'Fleet has not returned a sign-in link yet. Check again or retry. If this continues, ask a Fleet administrator to check the provider login service.'; }
      else if (!signFailed) signError = '';
    } catch { if (version === generation && attempt === signAttempt && signing === provider) signError = 'Could not check sign-in. Try again.'; }
    finally { checking = false; }
  }
  async function connect(provider: BrainProvider) {
    const api = adapter, bot = uid, version = generation;
    if (!api || !bot || starting || !rows.find(row => row.id === provider)?.canConnect) throw new Error('Unavailable');
    if (isLocal) { signing = provider; return; }
    starting = true;
    const attempt = ++signAttempt;
    signing = provider; approval = null; code = ''; signError = ''; signFailed = false; signStartedAt = Date.now();
    try {
      let value: unknown;
      if (multiProvider && api.agents.fetch) {
        // Authorize adds one provider without restarting an existing Grok login.
        // Do not fall back to reauth on a refusal: that can invalidate its code.
        const response = await api.agents.fetch(`/v1/agents/${encodeURIComponent(bot)}/brains/${provider}/authorize`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (version !== generation || attempt !== signAttempt) return;
        if (response.status < 200 || response.status >= 300) {
          signFailed = true;
          signError = response.status === 401 || response.status === 403 ? 'Your HQ account does not have permission to connect this provider. Ask a company owner or administrator.' : response.status === 404 || response.status === 409 ? 'Provider setup is not available for this bot on the current Fleet version. Ask a Fleet administrator to check it.' : 'Fleet could not start sign-in. Retry when the service is available.';
          return;
        }
        value = JSON.parse(await response.text());
      } else {
        const result = await api.agents.restartBrainApproval!(bot, provider);
        if (version !== generation || attempt !== signAttempt) return;
        if (!result.ok) { signFailed = true; signError = 'Fleet could not start sign-in. Check your HQ permissions or try again.'; return; }
        value = result.value;
      }
      if (version !== generation || attempt !== signAttempt) return;
      const response = record(value);
      if (response?.brain && response.brain !== provider) { signFailed = true; signError = 'Fleet returned a different provider. Close this window and refresh before trying again.'; return; }
      if (response?.authorized === true && response.brain === provider) { signing = null; await refresh(); notice = 'Provider is already connected. Your active model is unchanged.'; return; }
      if (response?.signIn === 'failed') { signFailed = true; signError = launchFailure; return; }
      approval = brainApprovalFromStatus(value, provider);
    } catch { if (version === generation && attempt === signAttempt) { signFailed = true; signError = 'Could not reach Fleet to start sign-in. Retry when the connection is available.'; } }
    finally { starting = false; }
    if (version === generation && attempt === signAttempt && !signFailed) await checkSignIn();
  }

  async function submitCode() {
    const api = adapter, bot = uid, version = generation;
    if (!api?.agents.submitClaudeLoginCode || !bot || signing !== 'claude' || !code.trim() || submitting) return;
    submitting = true; signError = '';
    const value = code.trim(); code = '';
    try { const result = await api.agents.submitClaudeLoginCode(bot, value); if (version !== generation) return; if (!result.ok) signError = 'The code was not accepted. Get a fresh code and try again.'; else await checkSignIn(); }
    catch { if (version === generation) signError = 'Could not submit the code. Get a fresh code and try again.'; }
    finally { submitting = false; }
  }
  function switchFailure(status: number, body: Record<string, unknown> | null): string {
    if (status === 401 || status === 403) return 'Your HQ account does not have permission to switch this bot’s brain. Ask a company owner or administrator.';
    if (body?.code === 'BRAIN_SWITCH_IN_PROGRESS') return 'A switch is already running for this bot. Wait for it to finish.';
    if (body?.code === 'BRAIN_SWITCH_DISABLED') return 'Brain switching is turned off right now.';
    if (body?.code === 'BRAIN_NOT_AUTHORIZED') return 'Connect this provider on the bot first, then switch.';
    if (body?.code === 'BOX_NOT_RUNNING') return 'The bot is not running, so its brain cannot be switched right now.';
    if (status === 404 || body?.code === 'BRAIN_SWITCH_V2_ONLY' || body?.code === 'BRAIN_SWITCH_UNAVAILABLE') return 'Brain switching is not available for this bot on the current Fleet version.';
    if (status === 400) return 'That model or thinking level is not available for this brain. Choose another and try again.';
    return 'Could not start the switch. Try again when the service is available.';
  }
  function switchView(value: unknown): { status: string; provider: BrainProvider | null; error: string | null } | null {
    const view = record(record(value)?.switch);
    if (!view) return null;
    return { status: String(view.status ?? ''), provider: providerId(typeof view.to === 'string' ? view.to : null), error: typeof view.error === 'string' ? view.error : null };
  }
  async function switchBrain(provider: BrainProvider, model: string, effort: string) {
    const api = adapter, bot = uid, version = generation;
    const row = rows.find(row => row.id === provider);
    if (!api?.agents.fetch || !bot || !canSwitch || !row || row.active || row.state !== 'connected' || switching) throw new Error('This brain cannot be switched to right now.');
    if (!row.models.some(choice => choice.value === model) || (effort && !row.efforts.includes(effort))) throw new Error('Choose a model and thinking level for this brain.');
    const body = JSON.stringify({ brain: provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
    let response: { status: number; text: () => Promise<string> };
    try { response = await api.agents.fetch(`/v1/agents/${encodeURIComponent(bot)}/brain-switch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }); }
    catch { throw new Error('Could not reach Fleet to start the switch. Try again when the connection is available.'); }
    if (version !== generation) return;
    let parsed: Record<string, unknown> | null = null;
    try { parsed = record(JSON.parse(await response.text())); } catch { parsed = null; }
    if (response.status < 200 || response.status >= 300) throw new Error(switchFailure(response.status, parsed));
    const view = switchView(parsed);
    switchAttempt++;
    switching = { provider, status: view?.status === 'waiting' ? 'waiting' : 'running' };
    notice = '';
  }
  async function pollSwitch() {
    const api = adapter, bot = uid, version = generation, attempt = switchAttempt, inFlight = switching;
    if (!api?.agents.fetch || !bot || !inFlight) return;
    try {
      const response = await api.agents.fetch(`/v1/agents/${encodeURIComponent(bot)}/brain-switch`, { method: 'GET' });
      if (version !== generation || attempt !== switchAttempt || !switching) return;
      if (response.status < 200 || response.status >= 300) return;
      const view = switchView(JSON.parse(await response.text()));
      if (!view) return;
      if (view.status === 'running' || view.status === 'waiting') { switching = { provider: view.provider ?? inFlight.provider, status: view.status }; return; }
      switching = null;
      const name = BRAIN_PROVIDERS.find(p => p.id === (view.provider ?? inFlight.provider))?.name ?? 'the new brain';
      await refresh();
      if (version !== generation) return;
      notice = view.status === 'done' ? `Now using ${name}. The bot answered a test message on it.` : view.error ?? (view.status === 'rolled-back' ? `The switch to ${name} did not work. The bot is back on its previous brain.` : `The switch to ${name} did not finish.`);
    } catch { /* the next poll tries again */ }
  }
  async function save(provider: BrainProvider, model: string, effort: string) {
    const api = adapter, bot = local, version = generation;
    const row = rows.find(row => row.id === provider);
    if (!isLocal) {
      if (!api?.agents.fetch || !uid || !row?.active || !row.canSave || row.state !== 'connected' || !model || !row.models.some(choice => choice.value === model) || effort && !row.efforts.includes(effort)) throw new Error('Unavailable');
      const botUid = uid;
      const latest = await api.agents.getProfile?.(botUid);
      if (version !== generation) return;
      const view = latest?.ok ? profileFromPayload(latest.value, { uid: botUid, displayName: name }) : null;
      if (view?.freshness.source !== 'live' || providerId(view.brain.provider) !== provider) throw new Error('Provider changed');
      const patch = { codexModel: model, ...(effort ? { codexReasoningEffort: effort } : {}) };
      const result = await api.agents.fetch(`/v1/agents/${encodeURIComponent(botUid)}/runtime-config`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      if (version !== generation) return;
      if (result.status < 200 || result.status >= 300) throw new Error('Save refused');
      const saved = JSON.parse(await result.text());
      if (saved.uid !== botUid || saved.codexModel !== model || effort && saved.codexReasoningEffort !== effort) throw new Error('Unverified save');
      await refresh(); notice = saved.applied === true ? 'Configuration saved for future messages.' : 'Configuration saved. The bot will apply it when it next checks in.';
      return;
    }
    if (!api?.bots?.configure || !bot || bot.agentUid !== uid || bot.runtime !== provider || !row?.canSave || row.state !== 'connected' || !row.models.some(choice => choice.value === model) || effort && !row.efforts.includes(effort)) throw new Error('Unavailable');
    const result = await api.bots.configure(bot.name, { model: model || null, effort: effort || null });
    if (version !== generation) return;
    if (!result.ok) throw new Error('Save refused');
    await refresh(); notice = 'Configuration saved for future messages.';
  }
  $effect(() => { void stableUid; void stableRuntimeKind; void stableAdapter; untrack(() => { generation++; local = null; switching = null; canSwitch = false; closeSignIn(); notice = ''; void refresh(); }); return () => { generation++; code = ''; approval = null; }; });
  $effect(() => { if (signing && !isLocal && !signFailed) return startVisibleInterval(() => { void checkSignIn(); }, 3000); });
  $effect(() => { if (switching && !isLocal) return startVisibleInterval(() => { void pollSwitch(); }, 3000); });
</script>
<BotBrainPanel {rows} {loading} {error} {notice} {canSwitch} {switching} onrefresh={refresh} onconnect={connect} onsave={save} onswitch={switchBrain} />
{#if signing && adapter}
<div class="overlay" use:portal><div class="dialog" tabindex="-1" role="dialog" aria-modal="true" aria-label="Connect provider" use:focusOnMount use:dismissable={{ onclose: closeSignIn }}>
  <h3>Connect {BRAIN_PROVIDERS.find(p => p.id === signing)?.name}</h3>
  {#if isLocal}
    <p>This sign-in is shared by local bots using this provider on this computer.</p>
    <RuntimeSignIn runtime={signing} api={{ loginStart: async provider => signState(await adapter!.sessions.loginStart!(provider)), loginStatus: async provider => signState(await adapter!.sessions.loginStatus!(provider)), loginCancel: async provider => adapter!.sessions.loginCancel ? signState(await adapter!.sessions.loginCancel(provider)) : { state: 'disconnected' } }} onconnected={async () => { closeSignIn(); await refresh(); }} oncancel={closeSignIn} />
  {:else}
    <p>Sign in on the provider’s website, then return here to verify the connection.</p>
    {#if approval && !approvalExpired(approval)}
      {#if approval.code}<label>Device code<input readonly value={approval.code} aria-label="Provider device code" /></label>{/if}
      <button onclick={() => approval && onopenurl?.(approvalOpenUrl(approval))}>Open provider sign-in</button>
    {:else if !signError}<p role="status">{starting ? 'Starting provider sign-in…' : approval ? 'This sign-in link has expired.' : 'Preparing your sign-in link. This panel checks automatically.'}</p>{/if}
    {#if signing === 'claude' && adapter.agents.submitClaudeLoginCode}<label>Code from Claude<input type="password" autocomplete="off" bind:value={code} /></label><button disabled={!code.trim() || submitting} onclick={submitCode}>{submitting ? 'Checking…' : 'Submit code'}</button>{/if}
    {#if signError}<p role="alert">{signError}</p>{/if}
    <footer><button disabled={submitting || starting} onclick={closeSignIn}>Close</button><button disabled={submitting || starting || checking} onclick={() => checkSignIn()}>{checking ? 'Checking…' : 'Check connection'}</button><button disabled={submitting || starting} onclick={() => { if (signing) void connect(signing).catch(() => signError = 'Could not restart sign-in. Try again.'); }}>{starting ? 'Starting…' : 'Retry sign-in'}</button></footer>
  {/if}
</div></div>
{/if}
<style>.overlay { position:fixed; inset:0; z-index:10040; display:grid; place-items:center; background:rgb(0 0 0/.55); padding:16px; }.dialog { box-sizing:border-box; width:min(480px,100%); max-height:calc(100dvh - 32px); overflow:auto; padding:24px; border:1px solid var(--v4-control-border,var(--line)); border-radius:20px; background:var(--v4-secondary-sidebar,var(--side-bg,#191919)); } h3 { font:italic 400 24px Georgia,serif; margin:0; } p { font-size:13px; color:var(--v4-text-3); line-height:1.6; } label { display:grid; gap:8px; margin:16px 0; font-size:13px; } input { min-width:0; padding:10px; color:var(--v4-text-1); background:var(--v4-control-bg); border:1px solid var(--v4-control-border,var(--line)); border-radius:8px; font:inherit; } button { border:1px solid var(--v4-control-border,var(--line)); border-radius:999px; padding:8px 12px; background:none; color:var(--v4-text-1); font:inherit; cursor:pointer; } button:disabled { opacity:.45; } footer { display:flex; flex-wrap:wrap; gap:8px; margin-top:20px; }</style>
