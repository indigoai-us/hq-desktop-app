<script lang="ts">
  import BotBrainPanel, { type BrainSwitchProgress } from '../../../packages/ui/src/shell/profile-panes/BotBrainPanel.svelte';
  import { brainRow, BRAIN_PROVIDERS, type BrainProvider, type BrainRow } from '../../../packages/ui/src/shell/profile-panes/bot-brain';
  let { fail = false } = $props<{ fail?: boolean }>();
  let rows = $state<BrainRow[]>(BRAIN_PROVIDERS.map(p => ({ ...brainRow(p.id), models: brainRow(p.id).models.filter(choice => choice.value !== ''), state: p.id === 'grok' ? 'disconnected' : 'connected', active: p.id === 'claude', canConnect: true, canSave: p.id === 'claude', detail: p.id === 'claude' ? 'Choose the model and thinking level this bot uses for future messages.' : 'Connected and ready. Use this brain to move the bot onto it; the current brain stays signed in.', model: p.id === 'claude' ? 'claude-opus-5-5' : '', effort: p.id === 'claude' ? 'medium' : '' })));
  let notice = $state('');
  let switching = $state<BrainSwitchProgress | null>(null);
  async function connect(id: BrainProvider) {
    if (fail) throw new Error('Demo failure');
    rows = rows.map(row => row.id === id ? { ...row, state: 'connected' } : row);
    notice = 'Demo account connected.';
  }
  async function save(id: BrainProvider, model: string, effort: string) {
    if (fail) throw new Error('Demo failure');
    rows = rows.map(row => row.id === id ? { ...row, model, effort } : row);
    notice = 'Demo brain configuration saved.';
  }
  async function switchBrain(id: BrainProvider, model: string, effort: string) {
    if (fail) throw new Error('Demo: the switch could not start.');
    switching = { provider: id, status: 'waiting' };
    await new Promise(resolve => setTimeout(resolve, 1200));
    switching = { provider: id, status: 'running' };
    await new Promise(resolve => setTimeout(resolve, 1200));
    rows = rows.map(row => row.id === id ? { ...row, active: true, model, effort, canSave: true } : { ...row, active: false, canSave: false, model: '', effort: '' });
    switching = null;
    notice = `Now using ${BRAIN_PROVIDERS.find(p => p.id === id)?.name}. The bot answered a test message on it.`;
  }
</script>
<p class="preview-note">Preview · Demo provider connections, model settings and brain switching</p>
<BotBrainPanel {rows} {notice} {switching} canSwitch onconnect={connect} onsave={save} onswitch={switchBrain} onrefresh={async () => {}} />
<style>.preview-note { font-size:11px; color:var(--v4-text-3); margin:0 0 12px; }</style>
