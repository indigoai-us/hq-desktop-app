<script lang="ts">
  import { untrack } from 'svelte';
  import type { AgentsApi } from '@hq/platform';
  import { profileFromPayload, routineActionRequest, type AgentProfileView, type RoutineActionId } from '../../chat/agent-detail-model.js';
  import BotTabSkeleton from './BotTabSkeleton.svelte';
  import BotRoutinesPanel from './BotRoutinesPanel.svelte';
  import BotJobsPane from './BotJobsPane.svelte';
  import type { BotJob } from './bot-jobs.js';
  let { uid, name, agents, jobs, unavailable, onpause, oncount }: { uid: string; name: string; agents: AgentsApi; jobs: BotJob[] | null; unavailable: string | null; onpause: (id: string) => Promise<boolean>; oncount?: (count: number) => void } = $props();
  let view = $state<AgentProfileView | null>(null);
  let loading = $state(true);
  let error = $state('');
  const stableUid = $derived(uid);
  const stableAgents = $derived(agents);
  let generation = 0;
  let requestNumber = 0;
  let retry: { signature: string; key: string } | null = null;
  const legacy = $derived(jobs?.filter(job => !view?.routines.some(row => row.id === job.id)) ?? null);
  const canManage = $derived(!!view?.hasBox && view.freshness.source !== 'cache' && view.freshness.source !== 'unavailable' && !error && !!agents.runtimeAction);
  $effect(() => { if (!loading && view?.hasBox) oncount?.(view.routines.length + (legacy?.length ?? 0)); });
  async function refresh() {
    const version = generation;
    const request = ++requestNumber;
    const api = agents, id = uid;
    loading = true; error = '';
    try {
      const result = await api.getProfile?.(id);
      if (generation !== version || request !== requestNumber) return;
      if (result?.ok) {
        view = profileFromPayload(result.value, { uid: id, displayName: name });
        error = view?.hasBox ? (view.freshness.source === 'cache' ? 'Showing cached routines. Refresh before making changes.' : view.freshness.source === 'unavailable' ? 'The bot is unavailable. Routine changes are disabled.' : '') : 'Bot routines are unavailable. Existing scheduled jobs are shown below.';
      } else { view = null; error = 'Could not load bot routines. Refresh to try again. Existing scheduled jobs are shown below.'; }
    } catch { if (generation === version && request === requestNumber) { view = null; error = 'Could not load bot routines. Refresh to try again.'; } }
    finally { if (generation === version && request === requestNumber) loading = false; }
  }
  $effect(() => { void stableUid; void stableAgents; untrack(() => { generation++; view = null; void refresh(); }); return () => { generation++; }; });
  async function action(action: RoutineActionId, id?: string, body?: Record<string, unknown>): Promise<boolean> {
    if (!canManage || !agents.runtimeAction) return false;
    const version = generation;
    const signature = JSON.stringify([uid, action, id, body]);
    if (!retry || retry.signature !== signature) retry = { signature, key: crypto.randomUUID() };
    const result = await agents.runtimeAction(uid, routineActionRequest(action, retry.key, id, body));
    if (version !== generation || !result.ok) return false;
    retry = null;
    if (view && id) {
      if (action === 'cron.delete') view = { ...view, routines: view.routines.filter(row => row.id !== id) };
      if (action === 'cron.pause' || action === 'cron.resume') view = { ...view, routines: view.routines.map(row => row.id === id ? { ...row, enabled: action === 'cron.resume' } : row) };
    }
    await refresh();
    return true;
  }
</script>
<BotRoutinesPanel rows={view?.routines ?? []} {loading} {error} {canManage} deliverOptions={view?.deliverOptions ?? []} onaction={action} onrefresh={refresh} />
{#if !loading && legacy === null && !unavailable}
  <BotTabSkeleton kind="routines" />
{:else if !loading && (legacy && legacy.length > 0 || unavailable)}
  <section class="legacy"><h3>Scheduled jobs</h3><p>Schedules managed by HQ. Available controls depend on your access.</p><BotJobsPane jobs={legacy} {unavailable} {onpause} /></section>
{/if}
<style>.legacy { margin-top: 24px; padding-top: 20px; border-top: 1px solid var(--v4-rowline,var(--line)); } h3 { margin: 0; font-size: 14px; font-weight: 500; } p { color: var(--v4-text-3); font-size: 12px; margin: 8px 0 16px; }</style>
