<script lang="ts">
  import { untrack } from 'svelte';
  import { BOT_INTEGRATION_CONTROL_FLAG, type PlatformAdapter } from '@hq/platform';
  import { profileFromPayload, type AgentProfileView } from '../../chat/agent-detail-model.js';
  import { readCompanyConnections, appLogo, type CompanyConnections } from '../../chat/messaging/integration-cards-model.js';
  import { readConnectionAccess, type ConnectionAccess } from '../../chat/messaging/bot-integration-access-model.js';
  import { createFirstRunAppsHost } from '../../chat/first-run/first-run-hosts.js';
  import IntegrationConnectModal from '../../chat/messaging/IntegrationConnectModal.svelte';
  import { integrationCardArt } from '../../chat/messaging/connection-card-art.js';
  import BotAppCredentials from './BotAppCredentials.svelte';
  import { credentialConfigs, type AppCredentialConfig } from './bot-app-credentials.js';
  import BotAppsPanel from './BotAppsPanel.svelte';
  import BotPersonalApps from './BotPersonalApps.svelte';
  import { botApps, companyHasCatalogApp, supportedApps, type ConnectResult, type SupportedApp } from './bot-apps.js';
  let { uid, companyUid, name, runtimeKind = null, adapter = null, onopenurl }: { uid: string | null; companyUid: string | null; name: string; runtimeKind?: 'local' | 'cloud' | null; adapter?: PlatformAdapter | null; onopenurl?: (url: string) => void } = $props();
  let personalAppsUnavailableFor = $state<string | null>(null);
  const personalApps = $derived(runtimeKind === 'cloud' && uid && personalAppsUnavailableFor !== uid ? adapter?.personalApps ?? null : null);
  let facts = $state<CompanyConnections | null>(null);
  let access = $state<Record<string, ConnectionAccess | null>>({});
  let profile = $state<AgentProfileView | null>(null);
  let controls = $state(false);
  let loading = $state(true);
  let error = $state('');
  let notice = $state('');
  let catalog = $state<SupportedApp[]>([]);
  let catalogLoading = $state(false);
  let catalogError = $state('');
  let credentialOptions = $state<Record<string, AppCredentialConfig>>({});
  let configuring = $state<AppCredentialConfig | null>(null);
  let keyApp = $state<SupportedApp | null>(null);
  const stableUid = $derived(uid);
  const stableCompanyUid = $derived(companyUid);
  const stableAdapter = $derived(adapter);
  let generation = 0, readNumber = 0, searchNumber = 0;
  let abort: AbortController | null = null;
  const art = integrationCardArt(0);
  const rows = $derived(botApps(facts?.connections ?? [], access, profile, uid ?? '', controls && !error && !loading));
  const canConnect = $derived(!!facts?.canManage && !!adapter?.integrations && !!onopenurl && !error && !loading);
  async function refresh() {
    const api = adapter, company = companyUid, bot = uid;
    const version = generation, request = ++readNumber;
    loading = true; notice = ''; error = '';
    if (!api?.integrations || !company || !bot) { error = 'Apps are unavailable in this view. Open a bot in a company to manage its apps.'; loading = false; return; }
    try {
      const [connections, details, flag] = await Promise.allSettled([
        api.integrations.listConnections(company),
        api.agents.getProfile?.(bot),
        api.identity?.hasFeature?.(BOT_INTEGRATION_CONTROL_FLAG, { companyUid: company }),
      ]);
      if (generation !== version || request !== readNumber) return;
      const result = connections.status === 'fulfilled' ? connections.value : null;
      const value = details.status === 'fulfilled' ? details.value : null;
      const nextProfile = value?.ok ? profileFromPayload(value.value, { uid: bot, displayName: name }) : null;
      const nextControls = flag.status === 'fulfilled' && flag.value?.ok === true && flag.value.value === true;
      if (!result?.ok) { facts = null; access = {}; error = 'Could not load company connections. Refresh to try again.'; return; }
      const nextFacts = readCompanyConnections(result.value, true);
      const nextCredentials = credentialConfigs(result.value);
      const entries = await Promise.all((nextFacts?.connections ?? []).map(async connection => {
        try { const read = await api.integrations.getConnectionAccess({ companyUid: company, connectionId: connection.id }); return [connection.id, read.ok ? readConnectionAccess(read.value) : null] as const; }
        catch { return [connection.id, null] as const; }
      }));
      if (generation !== version || request !== readNumber) return;
      facts = nextFacts; profile = nextProfile; controls = nextControls; credentialOptions = nextCredentials;
      error = facts ? '' : 'The connection list could not be read. Refresh to try again.';
      access = Object.fromEntries(entries);
      if (!profile || profile.freshness.source !== 'live') notice = 'Bot runtime status is unavailable or cached. Access changes are disabled until it can be verified.';
    } catch { if (generation === version && request === readNumber) { facts = null; access = {}; error = 'Could not load apps. Refresh to try again.'; } }
    finally { if (generation === version && request === readNumber) loading = false; }
  }
  async function search(query: string) {
    const api = adapter?.integrations, company = companyUid;
    const version = generation, request = ++searchNumber;
    catalog = []; catalogError = ''; catalogLoading = true;
    try {
      if (!api || !company || !facts?.canManage) { catalogError = 'The supported catalog requires company owner or admin access.'; return; }
      const result = await api.catalogSearch(company, query.trim(), 100);
      if (version !== generation || request !== searchNumber) return;
      if (result.ok) catalog = supportedApps(result.value);
      else catalogError = result.status === 403 ? 'You need company owner or admin access to browse and connect apps.' : 'Could not load the catalog. Try searching again.';
    } catch { if (version === generation && request === searchNumber) catalogError = 'Could not load the catalog. Try searching again.'; }
    finally { if (version === generation && request === searchNumber) catalogLoading = false; }
  }
  async function toggle(id: string, enabled: boolean) {
    const api = adapter?.integrations, company = companyUid, bot = uid, version = generation;
    const row = rows.find(item => item.id === id);
    if (!api || !company || !bot || !row?.canToggle) throw new Error('Access unavailable');
    const result = await (enabled ? api.grantConnectionAccess({ companyUid: company, connectionId: id, granteeUid: bot }) : api.revokeConnectionAccess({ companyUid: company, connectionId: id, granteeUid: bot }));
    if (version !== generation) return;
    if (!result.ok) throw new Error('Access change refused');
    notice = 'Access change saved. Checking current access…';
    await refresh();
    if (!access[id]) notice = 'Saved, but access could not be verified. Refresh to check before making another change.';
    else notice = enabled ? 'App access added to this bot.' : 'This bot’s explicit app access was removed.';
  }
  async function connect(app: SupportedApp): Promise<ConnectResult> {
    const api = adapter?.integrations, company = companyUid, version = generation;
    if (!api || !company || !canConnect || !onopenurl) throw new Error('Setup unavailable');
    notice = '';
    const before = new Set(rows.map(row => row.id));
    if (app.authClass === 'key') { keyApp = app; return { kind: 'handoff' }; }
    if (app.authClass === 'none') {
      const result = await api.install({ companyUid: company, ...(app.entryId ? { catalogEntryId: app.entryId } : { domain: app.domain }) });
      if (version !== generation) return { kind: 'connected', id: null };
      if (!result.ok) throw new Error('Install refused');
    } else {
      abort = new AbortController();
      const host = createFirstRunAppsHost({ dry: false, openUrl: onopenurl, listConnections: company => api.listConnections(company), startOAuth: input => api.startOAuth(input) });
      const result = await host.connect(company, app, abort.signal);
      if (version !== generation) return { kind: 'connected', id: null };
      abort = null;
      if (!result.ok) { notice = result.reason || 'Sign-in check cancelled. Refresh if you completed sign-in in the browser.'; throw new Error('Connection not verified'); }
    }
    await refresh();
    if (version !== generation) return { kind: 'connected', id: null };
    const matching = rows.filter(row => companyHasCatalogApp([row], app));
    return { kind: 'connected', id: (matching.find(row => !before.has(row.id)) ?? matching[0])?.id ?? null };
  }
  $effect(() => {
    void stableUid; void stableCompanyUid; void stableAdapter;
    untrack(() => { generation++; credentialOptions = {}; configuring = null; facts = null; access = {}; profile = null; controls = false; catalog = []; keyApp = null; notice = ''; void refresh(); });
    return () => { generation++; abort?.abort(); abort = null; };
  });
</script>
<BotAppsPanel title={personalApps ? 'Company apps' : null} configurable={error || loading ? [] : Object.keys(credentialOptions)} onconfigure={id => { configuring = credentialOptions[id] ?? null; }} {rows} {catalog} {loading} {error} {notice} {catalogLoading} {catalogError} {canConnect} onsearch={search} onrefresh={refresh} onconnect={connect} ontoggle={toggle} oncancel={() => abort?.abort()} />
{#if personalApps && uid}<BotPersonalApps {uid} api={personalApps} {onopenurl} onunavailable={() => personalAppsUnavailableFor = uid} />{/if}
{#if keyApp && adapter && uid && onopenurl}
  <IntegrationConnectModal frame={{ open: true, title: `Connect ${keyApp.name}`, icon: 'integration', logo: appLogo(keyApp.domain), art: art.url, artPosition: art.position, onclose: () => { keyApp = null; void refresh(); } }}
    agentUid={uid} botName={name} target="integration" {companyUid} companySlug={null} status={null} statusDenied={false} checkedAt={0} {adapter} openUrl={onopenurl} refresh={refresh} started={() => {}}
    integration={{ domain: keyApp.domain, name: keyApp.name, authClass: keyApp.authClass, catalogEntryId: keyApp.entryId, connected: () => { notice = 'App connected to the company. Open Browse apps and choose it under Company connections to add it to this bot.'; void refresh(); } }} />
{/if}

{#if configuring && companyUid && adapter}
  {#key `${companyUid}:${configuring.id}`}
    <BotAppCredentials config={configuring} {companyUid} {onopenurl} api={adapter.integrations} onclose={() => configuring = null} onsaved={() => { void refresh(); }} />
  {/key}
{/if}
