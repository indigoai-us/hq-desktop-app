<script lang="ts">
  import BrainPreview from "./BrainPreview.svelte";
  import AppsPreview from "./AppsPreview.svelte";
  import RoutinesPreview from "./RoutinesPreview.svelte";
  import BotChannelsPanel from '../../../packages/ui/src/shell/profile-panes/BotChannelsPanel.svelte';
  import { DEFAULT_CHANNELS, type BotChannel } from '../../../packages/ui/src/shell/profile-panes/bot-channels';
  import BotIdentityEditor from '../../../packages/ui/src/shell/profile-panes/BotIdentityEditor.svelte';
  import type { AgentsApi, AgentProfilePatch } from '@hq/platform';
  import BotProfilePane from '../../../packages/ui/src/shell/profile-panes/BotProfilePane.svelte';
  import BotJobsPane from '../../../packages/ui/src/shell/profile-panes/BotJobsPane.svelte';
  import { botProfileFromCache } from '../../../packages/ui/src/shell/profile-panes/profile-pane-model';

  const previewState = new URLSearchParams(window.location.search).get('state');
  let snapshot = $state( previewState === 'loading' ? null : {
    ...botProfileFromCache({ name: 'Scout', owner: 'You', company: 'Indigo', live: false }),
    idleNote: 'Ready for work',
    runtime: [{ label: 'Provider', value: 'Claude' }, { label: 'Model', value: 'Opus' }],
  });
  let channels = $state<BotChannel[]>(DEFAULT_CHANNELS.map(channel => ({ ...channel, state: channel.id === 'slack' ? 'connected' : 'not-connected', canConnect: true, canDisconnect: true })));
  const catalog = $derived([...channels, ...(!channels.some(channel => channel.id === 'discord') ? [{ id: 'discord', name: 'Discord', domain: 'discord.com', description: 'Join your community’s conversations.', state: 'not-connected' as const, canConnect: true, canDisconnect: true }] : [])]);
  async function connectChannel(id: string) {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (previewState === 'channel-error') throw new Error('Demo connection failure');
    const channel = catalog.find(row => row.id === id);
    if (channel) channels = [...channels.filter(row => row.id !== id), { ...channel, state: 'connected' }].sort((a, b) => ['slack', 'telegram', 'discord'].indexOf(a.id) - ['slack', 'telegram', 'discord'].indexOf(b.id));
  }
  let profile = { displayName: 'Scout', title: 'Research assistant', description: 'Help the team research, organize findings, and stay informed.' };
  const agents = {
    getProfile: async () => ({ ok: true, value: { agent: { uid: 'agt_preview_scout', ...profile }, editable: { title: true, description: true } } }),
    updateProfile: async (_uid: string, patch: AgentProfilePatch) => {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (previewState === 'save-error') return { ok: false, reason: 'network' };
      profile = { ...profile, ...patch };
      return { ok: true, value: {} };
    },
  } as unknown as AgentsApi;
</script>

<main>
  <BotProfilePane {snapshot} uid="agt_preview_scout" runtimeKind="cloud" jobsPanel={routines} detailsEditor={editor} channelsPanel={channelPanel} appsPanel={appsPanel} brainPanel={brainPanel} />
</main>

{#snippet brainPanel()}<BrainPreview fail={previewState === "brain-error"} />{/snippet}

{#snippet appsPanel()}<AppsPreview fail={previewState === "app-error"} />{/snippet}

{#snippet channelPanel()}
  <p class="preview-note">Preview · Demo connections and catalog</p>
  <BotChannelsPanel rows={channels} {catalog} onconnect={connectChannel} onrefresh={async () => {}}
    ondisconnect={async id => { channels = channels.map(row => row.id === id ? { ...row, state: 'not-connected' } : row); }} />
{/snippet}

{#snippet editor()}
  <BotIdentityEditor uid="agt_preview_scout" name={snapshot?.name ?? 'Scout'} handle="@scout" {agents}
    onupdated={(patch) => { if (snapshot && patch.displayName) snapshot = { ...snapshot, name: patch.displayName }; }} />
{/snippet}

{#snippet routines()}
  {#if previewState === "loading-routines" || previewState === "error"}
  <BotJobsPane jobs={previewState === 'loading-routines' || previewState === 'error' ? null : []}
    unavailable={previewState === 'error' ? 'Could not load routines. Open this view again to retry.' : null} />
  {:else}<RoutinesPreview fail={previewState === 'routine-error'} />{/if}
{/snippet}

<style>
  .preview-note { font-size: 11px; color: var(--v4-text-3); margin: 0 0 12px; }
  main { height: 100dvh; width: 100%; display: flex; justify-content: center; background: var(--v4-bg); }
</style>
