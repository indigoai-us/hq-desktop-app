<script lang="ts">
  import BotBrainPanel from '../../../packages/ui/src/shell/profile-panes/BotBrainPanel.svelte';
  import { brainRow, BRAIN_PROVIDERS, type BrainProvider, type BrainRow } from '../../../packages/ui/src/shell/profile-panes/bot-brain';
  let { fail = false } = $props<{ fail?: boolean }>();
  let rows = $state<BrainRow[]>(BRAIN_PROVIDERS.map(p => ({ ...brainRow(p.id), state: p.id === 'claude' ? 'connected' : 'disconnected', active: p.id === 'claude', canConnect: true, canSave: true, detail: 'Demo provider connection. Choose a model and thinking level to activate it.', effort: 'medium' })));
  let notice = $state('');
  async function connect(id: BrainProvider) {
    if (fail) throw new Error('Demo failure');
    rows = rows.map(row => row.id === id ? { ...row, state: 'connected' } : row);
    notice = 'Demo account connected. Configure a model to make it active.';
  }
  async function save(id: BrainProvider, model: string, effort: string) {
    if (fail) throw new Error('Demo failure');
    rows = rows.map(row => row.id === id ? { ...row, model, effort, active: true } : { ...row, active: false });
    notice = 'Demo brain configuration saved.';
  }
</script>
<p class="preview-note">Preview · Demo provider connections and model activation</p>
<BotBrainPanel {rows} {notice} onconnect={connect} onsave={save} onrefresh={async () => {}} />
<style>.preview-note { font-size:11px; color:var(--v4-text-3); margin:0 0 12px; }</style>
