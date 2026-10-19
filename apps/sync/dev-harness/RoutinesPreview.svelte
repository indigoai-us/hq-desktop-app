<script lang="ts">
  import BotRoutinesPanel from '../../../packages/ui/src/shell/profile-panes/BotRoutinesPanel.svelte';
  import { routinesFromBox, type RoutineActionId } from '../../../packages/ui/src/chat/agent-detail-model';
  let { fail = false } = $props<{ fail?: boolean }>();
  let rows = $state(routinesFromBox([
    { id: 'daily', name: 'Morning team brief', prompt: 'Summarize priorities, upcoming meetings, and blockers for the team.', schedule: { cadence: 'daily', expr: '0 9 * * *', display: 'Every day at 9:00 AM' }, enabled: true, lastStatus: 'succeeded', lastRunAt: new Date(Date.now() - 3600000).toISOString(), nextRunAt: new Date(Date.now() + 86400000).toISOString() },
    { id: 'weekly', name: 'Weekly project review', prompt: 'Review progress and share a concise weekly recap.', schedule: { cadence: 'weekly', expr: '0 16 * * 5', display: 'Fridays at 4:00 PM' }, enabled: true, lastStatus: 'failed' },
    { id: 'interval', name: 'Check support inbox', prompt: 'Review incoming support requests and flag urgent issues.', schedule: { cadence: 'interval', expr: 'every 60m', display: 'Every hour' }, enabled: false },
    { id: 'once', name: 'Launch reminder', prompt: 'Remind me to check the launch checklist.', schedule: { cadence: 'once', expr: '2030-01-01T09:00:00Z', display: 'Jan 1, 2030 at 9:00 AM UTC' }, enabled: true },
    { id: 'custom', name: 'Weekday wrap-up', prompt: 'Collect completed work and unresolved questions.', schedule: { cadence: 'custom', expr: '0 17 * * 1-5', display: 'Weekdays at 5:00 PM' }, enabled: true },
  ]));
  async function action(action: RoutineActionId, id?: string, body?: Record<string, unknown>) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (fail) return false;
    if (action === 'cron.delete') rows = rows.filter(row => row.id !== id);
    if (action === 'cron.pause' || action === 'cron.resume') rows = rows.map(row => row.id === id ? { ...row, enabled: action === 'cron.resume' } : row);
    if (body && (action === 'cron.create' || action === 'cron.update')) {
      const previous = rows.find(row => row.id === id);
      const expr = String(body.schedule);
      const cadence = expr.startsWith('every ') ? 'interval' : /^\d{4}-/.test(expr) ? 'once' : /^\d+ \d+ \* \* \*$/.test(expr) ? 'daily' : /^\d+ \d+ \* \* [0-6]$/.test(expr) ? 'weekly' : 'custom';
      const next = routinesFromBox([{ id: id ?? crypto.randomUUID(), name: body.name, prompt: body.prompt, schedule: { cadence, expr, display: expr }, enabled: previous?.enabled ?? true }])[0];
      rows = [...rows.filter(row => row.id !== id), next];
    }
    return true;
  }
</script>
<p class="preview-note">Preview · Demo routines</p>
<BotRoutinesPanel {rows} canManage={true} onaction={action} onrefresh={async () => {}} />
<style>.preview-note { color: var(--v4-text-3); font-size: 11px; margin: 0 0 12px; }</style>
