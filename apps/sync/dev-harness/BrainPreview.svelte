<script lang="ts">
  import BotBrainPanel, { type BrainSwitchProgress } from '../../../packages/ui/src/shell/profile-panes/BotBrainPanel.svelte';
  import { brainRow, cloudBrainChoices, modelCatalog, BRAIN_PROVIDERS, type BrainProvider, type BrainRow } from '../../../packages/ui/src/shell/profile-panes/bot-brain';
  let { fail = false } = $props<{ fail?: boolean }>();
  const offered = (id: string, label: string, efforts: string[], extra = {}) => ({ id, label, authModes: ['subscription'], efforts, selectable: true, visibility: 'shown', isNew: false, ...extra });
  const catalog = modelCatalog({ providers: {
    codex: { defaultModel: 'gpt-6-sol', models: [offered('gpt-6.1-sol', 'GPT-6.1 Sol', ['low', 'medium', 'high', 'xhigh']), offered('gpt-6-sol', 'GPT-6 Sol', ['minimal', 'low', 'medium', 'high', 'xhigh']), offered('gpt-6-astra', 'GPT-6 Astra', ['low', 'medium', 'high']), offered('gpt-5.5', 'GPT-5.5', ['low', 'medium', 'high'], { visibility: 'legacy' })] },
    claude: { defaultModel: 'claude-opus-5-5', models: [offered('claude-opus-5-5', 'Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']), offered('claude-opus-5', 'Opus 5', ['low', 'medium', 'high', 'xhigh', 'max']), offered('claude-sonnet-5', 'Sonnet 5', ['low', 'medium', 'high'])] },
    grok: { defaultModel: 'grok-4.7', models: [offered('grok-4.7', 'Grok 4.7', ['low', 'medium', 'high', 'xhigh'])] },
  } });
  let rows = $state<BrainRow[]>(BRAIN_PROVIDERS.map(p => ({ ...brainRow(p.id), ...cloudBrainChoices(p.id, catalog), state: p.id === 'codex' ? 'disconnected' : 'connected', active: p.id === 'claude', canConnect: true, canSave: p.id === 'claude', detail: p.id === 'claude' ? 'Choose the model and thinking level this bot uses for future messages.' : 'Connected and ready. Use this brain to move the bot onto it; the current brain stays signed in.', model: p.id === 'claude' ? 'claude-opus-5-5' : '', effort: p.id === 'claude' ? 'medium' : '' })));
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
