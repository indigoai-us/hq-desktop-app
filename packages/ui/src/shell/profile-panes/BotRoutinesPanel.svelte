<script lang="ts">
  import BotTabSkeleton from './BotTabSkeleton.svelte';
  import { portal, focusOnMount } from '../../chat/portal.js';
  import Dropdown from '../../common/Dropdown.svelte';
  import RailIcon from '../../common/button/RailIcon.svelte';
  import { dismissable } from '../../common/dismissable.js';
  import { emptyRoutineDraft, draftFromRoutine, routineBodyFromDraft, ROUTINE_CADENCE_ORDER, ROUTINE_CADENCE_LABEL, type AgentRoutineRow, type AgentDeliverOption, type RoutineDraft, type RoutineActionId } from '../../chat/agent-detail-model.js';
  let { rows, loading = false, error = '', canManage = false, deliverOptions = [], onaction, onrefresh }: {
    rows: AgentRoutineRow[]; loading?: boolean; error?: string; canManage?: boolean; deliverOptions?: AgentDeliverOption[];
    onaction?: (action: RoutineActionId, id?: string, body?: Record<string, unknown>) => Promise<boolean>;
    onrefresh?: () => Promise<void>;
  } = $props();
  let query = $state('');
  let selected = $state<string | null>(null);
  let draft = $state<RoutineDraft | null>(null);
  let editId = $state<string | undefined>();
  let busy = $state(false);
  let actionError = $state('');
  let feedback = $state('');
  let confirmation = $state<'cron.delete' | 'cron.trigger' | null>(null);
  const current = $derived(rows.find(row => row.id === selected));
  const failed = (row: AgentRoutineRow) => /fail|error/i.test(row.lastStatus ?? '');
  const scheduleLabel = (row: AgentRoutineRow) => row.schedule && row.schedule !== row.expr ? row.schedule : 'Saved schedule';
  const outcomeLabel = (value: string | null) => /^(ok|success|succeeded|completed)$/i.test(value ?? '') ? 'Completed' : /fail|error/i.test(value ?? '') ? 'Needs attention' : /running|started/i.test(value ?? '') ? 'Running' : '';
  function deliveryLabel(value: string | null) {
    if (!value) return '';
    const [platform, ...rest] = value.split(' · ');
    const labels: Record<string, string> = { origin: 'Original conversation', local: 'Saved on the bot', hqdm: 'HQ chat', dm: 'HQ chat', slack: 'Slack', telegram: 'Telegram', email: 'Email', teams: 'Microsoft Teams' };
    return [labels[platform.toLowerCase()] ?? platform, ...rest].join(' · ');
  }
  const shown = $derived(rows.filter(row => `${row.name} ${row.prompt}`.toLowerCase().includes(query.toLowerCase().trim())));
  const valid = $derived(draft ? routineBodyFromDraft(draft) : null);
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  function close() { if (busy) return; selected = null; draft = null; confirmation = null; actionError = ''; }
  function edit(row?: AgentRoutineRow) {
    editId = row?.id;
    const next = row ? draftFromRoutine(row) : { ...emptyRoutineDraft(), deliver: 'local' };
    const interval = row?.expr.match(/^every (\d+)m$/);
    if (row?.cadence === 'interval' && interval) { next.cadence = 'interval'; next.intervalMinutes = Number(interval[1]); }
    if (row?.cadence === 'once' && /^\d{4}-.*(?:Z|[+-]\d{2}:\d{2})$/.test(row.expr)) {
      const date = new Date(row.expr);
      if (Number.isFinite(date.getTime())) {
        next.cadence = 'once';
        const pad = (n: number) => String(n).padStart(2, '0');
        next.onceAt = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
      }
    }
    draft = next; selected = null; actionError = ''; confirmation = null;
  }
  async function act(action: RoutineActionId, id?: string, body?: Record<string, unknown>) {
    if (!onaction || busy) return;
    busy = true; actionError = ''; feedback = '';
    try {
      if (!await onaction(action, id, body)) { actionError = 'Could not complete this change. Your changes are kept here; try again.'; return; }
      feedback = action === 'cron.trigger' ? 'Run requested. Check the latest run after refreshing.' : action === 'cron.delete' ? 'Routine deleted.' : action === 'cron.pause' ? 'Routine paused.' : action === 'cron.resume' ? 'Routine resumed.' : 'Routine saved.';
      confirmation = null;
      if (action === 'cron.create' || action === 'cron.update') draft = null;
      if (action === 'cron.delete') selected = null;
    } catch { actionError = 'Could not reach the bot. Your changes are kept here; try again.'; }
    finally { busy = false; }
  }
</script>

{#if loading}<BotTabSkeleton kind="routines" onretry={onrefresh} />{:else}
<section class="routines" aria-label="Manage routines">
  <div class="toolbar"><button class="primary" disabled={!canManage || loading || busy} onclick={() => edit()}><RailIcon name="plus" />New routine</button><button disabled={loading || busy || !onrefresh} onclick={() => onrefresh?.()} aria-label="Refresh routines"><RailIcon name="refresh" />Refresh</button></div>
  {#if error}<p class="notice" role="alert">{error}</p>{/if}
  {#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
  {#if !canManage && !loading}<p class="muted">Routine changes are unavailable for this bot or your current access.</p>{/if}
  <div class="summary" aria-label="Routine summary"><span><b>{loading || error && rows.length === 0 ? '—' : rows.filter(r => r.enabled).length}</b> Active</span><span><b>{loading || error && rows.length === 0 ? '—' : rows.filter(r => !r.enabled).length}</b> Paused</span><span><b>{loading || error && rows.length === 0 ? '—' : rows.filter(failed).length}</b> Need attention</span></div>
  <label class="search"><RailIcon name="search" /><input aria-label="Search routines" placeholder="Search routines or instructions…" bind:value={query} /></label>
  {#if loading}<p role="status">Loading routines…</p>
  {:else if !error && rows.length === 0}<div class="empty"><RailIcon name="arrows-clockwise" /><h4>Your next good habit starts here</h4><p>Create a daily brief, a weekly review, a repeating check, or a one-time reminder.</p></div>
  {:else if shown.length === 0 && !error}<p class="notice">No routines match your search. <button onclick={() => { query = ''; }}>Clear search</button></p>
  {/if}
  <div class="list">{#each shown as row (row.id)}<button class="routine-card" data-testid="routine-card" onclick={() => { selected = row.id; confirmation = null; actionError = ''; }}><span class="card-top"><span class="kind">{ROUTINE_CADENCE_LABEL[row.cadence]}</span><span class="status"><i class:paused={!row.enabled} class:failed={failed(row)}></i>{!row.enabled ? 'Paused' : failed(row) ? 'Needs attention' : 'Active'}</span></span><strong>{row.name}</strong><span class="description">{row.prompt || 'No instructions provided.'}</span><span class="schedule"><RailIcon name="arrows-clockwise" />{scheduleLabel(row)}</span><span class="meta">{row.enabled && row.nextRun ? `Next ${row.nextRun}` : row.enabled ? 'Scheduled' : 'Schedule paused'} · {row.lastRan ? `Last ${row.lastRan}${outcomeLabel(row.lastStatus) ? ` · ${outcomeLabel(row.lastStatus)}` : ''}` : 'Not run yet'}</span><span class="card-bottom">{deliveryLabel(row.deliverTo)}<span>View routine →</span></span></button>{/each}</div>
</section>
{/if}

{#if current || draft}
  <div class="overlay" use:portal><div class="dialog" role="dialog" aria-modal="true" tabindex="-1" aria-label={draft ? (editId ? 'Edit routine' : 'New routine') : 'Routine details'} use:focusOnMount use:dismissable={{ onclose: close }}>
    <header><div><span class="kind">{draft ? 'Make time for what matters' : current ? ROUTINE_CADENCE_LABEL[current.cadence] : ''}</span><h3>{draft ? (editId ? 'Edit routine' : 'New routine') : current?.name}</h3></div><button aria-label="Close routine" disabled={busy} onclick={close}><RailIcon name="x" /></button></header>
    {#if draft}
      <form onsubmit={event => { event.preventDefault(); if (valid) void act(editId ? 'cron.update' : 'cron.create', editId, valid); }}>
      <fieldset disabled={busy}>
        <label>Name<input bind:value={draft.name} required placeholder="Morning team brief" /></label>
        <label>Instructions<textarea bind:value={draft.prompt} required rows="4" placeholder="What should your bot do each time?"></textarea></label>
        <div class="field"><span>Schedule type</span><Dropdown constrainToDialog label="Schedule type" block disabled={busy} bind:value={draft.cadence} options={ROUTINE_CADENCE_ORDER.filter(value => value !== 'custom' || !!editId && !!draft?.custom).map(value => ({ value, label: value === 'custom' ? 'Keep existing schedule' : ROUTINE_CADENCE_LABEL[value] }))} /></div>
        {#if draft.cadence === 'daily' || draft.cadence === 'weekly'}<label>Time<input type="time" bind:value={draft.time} required /></label><p class="muted">Uses your bot’s time zone.</p>{/if}
        {#if draft.cadence === 'weekly'}<div class="field"><span>Day</span><Dropdown constrainToDialog label="Day" block disabled={busy} value={String(draft.weekday)} onchange={value => { if (draft) draft.weekday = Number(value); }} options={['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map((label, i) => ({ value: String(i), label }))} /></div>{/if}
        {#if draft.cadence === 'interval'}<label>Repeat every (minutes)<input type="number" min="1" step="1" bind:value={draft.intervalMinutes} required /></label>{/if}
        {#if draft.cadence === 'once'}<label>Run at<input type="datetime-local" bind:value={draft.onceAt} required /></label><p class="muted">Time zone: {localZone}.</p>{/if}
        {#if draft.cadence === 'custom'}<p class="muted">Your existing schedule will stay the same. Choose another schedule above to change when this routine runs.</p>{/if}
        <div class="field"><span>Send results to</span><Dropdown constrainToDialog label="Send results to" block disabled={busy} bind:value={draft.deliver} options={[...(editId ? [{ value: '', label: 'Keep current destination' }] : []), { value: 'origin', label: 'Original conversation' }, { value: 'local', label: 'Save on the bot' }, ...deliverOptions.map(option => ({ ...option, label: deliveryLabel(option.label) }))]} /></div>
      </fieldset>
      {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
      <footer><button type="button" disabled={busy} onclick={close}>Cancel</button><button class="primary" disabled={busy || !valid || !canManage}>{busy ? 'Saving…' : editId ? 'Save routine' : 'Create routine'}</button></footer>
      </form>
    {:else if current}
      {#if feedback}<p class="notice" role="status">{feedback}</p>{/if}
      <div class="detail-section"><h4>Instructions</h4><p class="prompt">{current.prompt || 'No instructions.'}</p></div>
      <div class="detail-section"><h4>Schedule & delivery</h4><dl><dt>Status</dt><dd>{current.enabled ? 'Active' : 'Paused'}</dd><dt>Schedule</dt><dd>{scheduleLabel(current)}</dd><dt>Next run</dt><dd>{current.enabled ? current.nextRun ?? 'Not available yet' : 'Paused'}</dd>{#if current.deliverTo}<dt>Results</dt><dd>{deliveryLabel(current.deliverTo)}</dd>{/if}</dl></div>
      <div class="detail-section"><h4>Latest run</h4><p>{current.lastRan ? `${current.lastRan}${outcomeLabel(current.lastStatus) ? ` · ${outcomeLabel(current.lastStatus)}` : ''}` : 'No recent runs to show.'}</p></div>
      {#if actionError}<p class="notice" role="alert">{actionError}</p>{/if}
      {#if confirmation}<p class="notice">{confirmation === 'cron.delete' ? 'Delete this routine? Its future scheduled runs will be removed.' : 'Run this routine now? The bot will execute its instructions immediately.'}</p><footer><button disabled={busy} onclick={() => confirmation = null}>Cancel</button><button disabled={busy} onclick={() => act(confirmation!, current.id)}>{busy ? 'Working…' : confirmation === 'cron.delete' ? 'Confirm delete' : 'Confirm run'}</button></footer>
      {:else if canManage && current.editable}<footer><button disabled={busy} onclick={() => edit(current)}>Edit</button><button disabled={busy} onclick={() => act(current.enabled ? 'cron.pause' : 'cron.resume', current.id)}>{busy ? 'Working…' : current.enabled ? 'Pause' : 'Resume'}</button><button disabled={busy} onclick={() => confirmation = 'cron.trigger'}>Run now</button><button disabled={busy} onclick={() => confirmation = 'cron.delete'}>Delete</button></footer>
      {:else}<p class="muted">This routine is read-only.</p>{/if}
    {/if}
  </div></div>
{/if}

<style>
  .routines { display: grid; gap: 12px; } h3,h4,p { margin: 0; } h3 { font: italic 400 24px/1.3 Georgia,serif; } h4 { font-size: 13px; font-weight: 500; } p { line-height: 1.6; }  .toolbar,footer { display: flex; flex-wrap: wrap; gap: 8px; } button,input,textarea { font: inherit; color: var(--v4-text-1); } button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer; padding: 8px 12px; border: 1px solid var(--v4-control-border, var(--line)); border-radius: 999px; background: transparent; } button:hover:not(:disabled) { background: var(--v4-hover); } button:disabled { opacity: .45; cursor: default; } .primary { background: var(--v4-primary-bg); color: var(--v4-primary-fg); } button:focus-visible,input:focus-visible,textarea:focus-visible { outline: 2px solid var(--v4-text-2); outline-offset: 3px; }
  .summary { display: flex; flex-wrap: wrap; gap: 16px; }.summary span { font-size: 12px; color: var(--v4-text-3); }.summary b { font-size: 12px; font-weight: 400; color: var(--v4-text-1); } .search { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--v4-control-border,var(--line)); border-radius: 12px; }.search input { border: 0; background: none; padding: 0; } input,textarea { box-sizing: border-box; width: 100%; min-width: 0; background: var(--v4-secondary-sidebar, var(--side-bg, #191919)); padding: 10px; border: 1px solid var(--v4-control-border,var(--line)); border-radius: 8px; } textarea { resize: vertical; } label,.field { display: grid; gap: 7px; font-size: 12px; color: var(--v4-text-3); } .list { display: grid; gap: 12px; } .routine-card { width: 100%; border-radius: 12px; padding: 14px; display: flex; flex-direction: column; align-items: stretch; text-align: left; gap: 6px; background: color-mix(in srgb,var(--v4-text-1) 2%,transparent); } .card-top,.card-bottom { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; } .kind,.status,.meta,.card-bottom { font-size: 12px; color: var(--v4-text-3); } strong { font-size: 16px; font-weight: 500; overflow-wrap: anywhere; } .description { color: var(--v4-text-3); display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 1.5; }.schedule { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }.card-bottom { padding-top: 8px; border-top: 1px solid var(--v4-rowline,var(--line)); }.status { display: flex; align-items: center; gap: 5px; }.status i { width: 5px; height: 5px; border-radius: 50%; background: var(--v4-ok); }.status i.paused { background: var(--v4-text-3); }.status i.failed { background: var(--v4-error); }.notice,.empty { padding: 16px; border: 1px solid var(--v4-rowline,var(--line)); border-radius: 12px; }.empty { display: grid; gap: 12px; }.muted { font-size: 12px; color: var(--v4-text-3); }.overlay { position: fixed; inset: 0; z-index: 10030; display: grid; place-items: center; background: rgb(0 0 0/.55); padding: 16px; }.dialog { box-sizing: border-box; width: min(540px,100%); max-height: calc(100dvh - 32px); overflow: auto; border: 1px solid var(--v4-control-border,var(--line)); border-radius: 20px; background: var(--v4-secondary-sidebar, var(--side-bg, #191919)); padding: 24px; } header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 20px; } header h3 { margin-top: 6px; overflow-wrap: anywhere; } fieldset { border: 0; padding: 0; margin: 0; display: grid; gap: 12px; min-width: 0; } footer { justify-content: flex-end; margin-top: 20px; } .detail-section { border-top: 1px solid var(--v4-rowline,var(--line)); padding: 16px 0; display: grid; gap: 10px; } .prompt { white-space: pre-wrap; overflow-wrap: anywhere; } dl { display: grid; grid-template-columns: 85px minmax(0,1fr); gap: 10px; margin: 0; } dt { color: var(--v4-text-3); } dd { margin: 0; overflow-wrap: anywhere; } @media(max-width:480px) { .dialog { padding: 14px; }.summary span { font-size: 12px; color: var(--v4-text-3); } }
  button.primary:hover:not(:disabled) { background: var(--v4-primary-bg); color: var(--v4-primary-fg); opacity: .9; }
  .search:focus-within { border-color: var(--v4-text-3); }
  .search input:focus,.search input:focus-visible { outline: none; box-shadow: none; }
</style>
