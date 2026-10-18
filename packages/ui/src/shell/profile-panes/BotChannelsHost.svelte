<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentsApi, PlatformAdapter } from '@hq/platform';
  import BotChannelsPanel from './BotChannelsPanel.svelte';
  import BotChannelManager from './BotChannelManager.svelte';
  import BotEmailManager from './BotEmailManager.svelte';
  import SlackConnectModal from '../../chat/messaging/SlackConnectModal.svelte';
  import { connectionCardArt } from '../../chat/messaging/connection-card-art.js';
  import { startVisibleInterval } from '../../common/visible-interval.js';
  import { channelRows } from './bot-channels.js';

  let { uid, runtimeKind = null, companyUid = null, name, agents = null, adapter = null, onopenurl }: {
    uid: string | null;
    runtimeKind?: "local" | "cloud" | null;
    companyUid?: string | null;
    name: string;
    agents?: AgentsApi | null;
    adapter?: PlatformAdapter | null;
    onopenurl?: (url: string) => void;
  } = $props();
  let status = $state.raw<unknown>(null);
  let profile = $state.raw<unknown>(null);
  let loading = $state(true);
  let error = $state('');
  let denied = $state(false);
  let checkedAt = $state(0);
  let slackOpen = $state(false);
  let managedOpen = $state<'telegram' | 'teams' | null>(null);
  let emailOpen = $state(false);
  let telegramStatus = $state<Record<string, unknown> | null>(null);
  let teamsStatus = $state<Record<string, unknown> | null>(null);
  const stableUid = $derived(uid);
  const stableCompanyUid = $derived(companyUid);
  const stableAgents = $derived(agents);
  let epoch = 0;
  let inflight: Promise<void> | null = null;
  const slackReady = $derived(!!adapter && !!onopenurl && typeof agents?.attachSlack === 'function' && typeof agents?.submitSlackAppToken === 'function' && !denied && !error);
  const rows = $derived.by(() => {
    const result = channelRows(status, profile, slackReady);
    if (runtimeKind !== 'local' && agents?.connectEmail) {
      const root = status as { agent?: { channels?: { email?: { address?: string } } } } | null;
      const address = root?.agent?.channels?.email?.address;
      const email = { id: 'email', name: 'Email', domain: '', description: 'Give your bot an email address.', state: address ? 'connected' as const : status ? 'not-connected' as const : 'unknown' as const, canConnect: true, detail: address };
      const i = result.findIndex(row => row.id === 'email');
      if (i < 0) result.push(email); else result[i] = email;
    }
    if (runtimeKind !== 'local' && agents?.channelStatus && agents?.channelContacts) {
      const telegram = result.find(r => r.id === 'telegram')!;
      telegram.canConnect = !!agents.connectTelegram;
      telegram.state = telegramStatus ? telegramStatus.configured === true ? 'connected' : 'not-connected' : 'unknown';
      telegram.detail = telegramStatus?.eligible === false ? 'This bot runtime cannot connect Telegram.' : undefined;
      let teams = result.find(r => r.id === 'teams');
      if (!teams) { teams = { id: 'teams', name: 'Microsoft Teams', domain: 'microsoft.com', description: 'Link company members to your bot through your company’s Teams app.', state: 'unknown', canConnect: true }; result.push(teams); }
      teams.canConnect = !!agents.addChannelContact;
      teams.name = 'Microsoft Teams'; teams.domain = 'microsoft.com'; teams.description = 'Link people through your company’s Teams app.';
      teams.state = teamsStatus && typeof teamsStatus.boundContactCount === 'number' ? teamsStatus.boundContactCount > 0 ? 'connected' : 'not-connected' : 'unknown';
      teams.detail = 'Manage linked contacts for your company’s Teams app.';
    }
    return result;
  });
  const catalog = $derived(rows.filter(row => row.canConnect));
  const art = connectionCardArt('slack');

  function refresh(background = false): Promise<void> {
    if (runtimeKind === 'local') { error = 'External channel management is not available for local bots in this desktop API. HQ chat remains available.'; loading = false; return Promise.resolve(); }
    if (inflight) return inflight;
    const api = agents;
    const agent = uid;
    const current = epoch;
    if (!api || !agent) { loading = false; error = 'Channel status is unavailable in this view.'; return Promise.resolve(); }
    if (!background) loading = true;
    error = '';
    const task = (async () => {
      try {
        const [statusResult, profileResult, telegramResult, teamsResult] = await Promise.allSettled([
          Promise.resolve().then(() => api.getStatus(agent)),
          Promise.resolve().then(() => api.getProfile ? api.getProfile(agent) : null),
          Promise.resolve().then(() => api.channelStatus?.(agent, 'telegram')),
          Promise.resolve().then(() => api.channelStatus?.(agent, 'teams')),
        ]);
        if (current !== epoch) return;
        telegramStatus = telegramResult.status === 'fulfilled' && telegramResult.value?.ok ? telegramResult.value.value as Record<string, unknown> : null;
        teamsStatus = teamsResult.status === 'fulfilled' && teamsResult.value?.ok ? teamsResult.value.value as Record<string, unknown> : null;
        const response = statusResult.status === 'fulfilled' ? statusResult.value : null;
        const details = profileResult.status === 'fulfilled' ? profileResult.value : null;
        status = response?.ok ? response.value : null;
        profile = details?.ok ? details.value : null;
        denied = !!response && !response.ok && (response.status === 403 || response.status === 401);
        error = response?.ok ? '' : denied ? 'You need owner or admin access to manage this bot’s channels.' : 'Could not refresh channel status. Try again.';
        checkedAt = Date.now();
      } catch { if (current === epoch) { status = null; profile = null; error = 'Could not refresh channel status. Try again.'; } } finally { if (current === epoch) { loading = false; inflight = null; } }
    })();
    inflight = task;
    return task;
  }
  $effect(() => {
    void stableUid; void stableCompanyUid; void stableAgents;
    untrack(() => { epoch++; inflight = null; status = null; profile = null; telegramStatus = null; teamsStatus = null; denied = false; slackOpen = false; managedOpen = null; emailOpen = false; error = ''; void refresh(); });
    return () => { epoch++; inflight = null; };
  });
  $effect(() => {
    const interval = slackOpen ? 4000 : 15000;
    return startVisibleInterval(() => { void refresh(true); }, interval);
  });
  async function connect(id: string): Promise<void> {
    if (id === 'slack' && slackReady) slackOpen = true;
    else if ((id === 'telegram' || id === 'teams') && runtimeKind !== 'local' && agents?.channelStatus) managedOpen = id;
    else if (id === 'email' && runtimeKind !== 'local' && agents?.connectEmail) emailOpen = true;
    else throw new Error('Channel setup unavailable');
  }
</script>

<BotChannelsPanel {rows} {catalog} {loading} {error} onrefresh={refresh} onconnect={connect} onconfigure={connect} />
{#if managedOpen && uid && agents}
  {#key `${uid}:${managedOpen}`}<BotChannelManager {uid} {name} channel={managedOpen} {companyUid} {agents} {adapter} {onopenurl} onchanged={refresh} onclose={() => { managedOpen = null; void refresh(); }} />{/key}
{/if}
{#if emailOpen && uid && agents}<BotEmailManager {uid} {agents} onchanged={refresh} onclose={() => { emailOpen = false; void refresh(); }} />{/if}
{#if slackOpen && adapter && uid && onopenurl}
  <SlackConnectModal frame={{ open: true, title: 'Connect Slack', icon: 'slack', art: art.url, artPosition: art.position, onclose: () => { slackOpen = false; void refresh(); } }}
    agentUid={uid} botName={name} target="slack" {companyUid} companySlug={null} {status} statusDenied={denied} {checkedAt} {adapter} openUrl={onopenurl} {refresh} started={() => {}}
    ondisconnect={agents?.disconnectSlack ? async () => { const r = await agents!.disconnectSlack!(uid!); if (!r.ok) throw new Error('Disconnect failed'); } : undefined} />
{/if}
