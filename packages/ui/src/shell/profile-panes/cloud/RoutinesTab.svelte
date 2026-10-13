<script lang="ts">
  import type { AgentControlRoutine } from "@hq/platform";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import RoutineDialog from "./RoutineDialog.svelte";
  import type { CloudTabProps } from "./cloud-bot-tabs.js";
  import { controlError, relativeTime, routinesFromPayload, scheduleInWords } from "./agent-control-model.js";

  let { uid, control, view, offline, onview, onoffline }: CloudTabProps = $props();

  let editing = $state<{ routine: AgentControlRoutine | null } | null>(null);
  let pending = $state<string | null>(null);
  let error = $state<string | null>(null);

  function lastLine(r: AgentControlRoutine): string | null {
    if (!r.lastStatus && !r.lastRunAt) return null;
    const when = relativeTime(r.lastRunAt);
    const raw = (r.lastStatus ?? "").trim();
    const status = !raw ? "Ran" : /^(ok|success|succeeded|done)$/i.test(raw) ? "Succeeded" : raw.charAt(0).toUpperCase() + raw.slice(1);
    return when ? `${status} ${when}` : status;
  }

  function failed(r: AgentControlRoutine): boolean {
    return /fail|error/i.test(r.lastStatus ?? "");
  }

  async function toggle(r: AgentControlRoutine): Promise<void> {
    if (pending) return;
    const want = !r.enabled;
    pending = r.id;
    error = null;
    const res = await control.updateRoutine(uid, r.id, { enabled: want });
    if (!res.ok) {
      pending = null;
      const e = controlError(res);
      if (e.offline) onoffline();
      error = e.message;
      return;
    }
    const listed = await control.listRoutines(uid);
    pending = null;
    if (!listed.ok) {
      error = "The bot did not confirm the change. Check again in a moment.";
      return;
    }
    const routines = routinesFromPayload(listed.value);
    onview({ routines });
    if (routines.find((x) => x.id === r.id)?.enabled !== want) error = "The bot did not keep the change.";
  }
</script>

<section class="cp-section" data-testid="cloud-routines">
  <div class="cp-head">
    <span class="cp-label">Routines</span>
    {#if view.routines.length}<span class="cp-count">{view.routines.length}</span>{/if}
    {#if view.routines.length}
      <button type="button" class="cp-btn cp-act" data-testid="cloud-routine-new" disabled={offline} onclick={() => (editing = { routine: null })}><RailIcon name="plus" />New routine</button>
    {/if}
  </div>
  {#if view.routines.length === 0}
    <div class="cp-empty" data-testid="cloud-routines-empty">
      <p>No routines yet. A routine runs a prompt for this bot on a schedule.</p>
      <button type="button" class="cp-btn" data-testid="cloud-routine-new" disabled={offline} onclick={() => (editing = { routine: null })}><RailIcon name="plus" />New routine</button>
    </div>
  {:else}
    <ul class="cp-rows">
      {#each view.routines as r (r.id)}
        {@const last = lastLine(r)}
        {@const next = r.enabled ? relativeTime(r.nextRunAt) : null}
        <li class="cp-row" data-testid="cloud-routine-row" data-id={r.id}>
          <button type="button" class="cp-row-main" data-testid="cloud-routine-open" onclick={() => (editing = { routine: r })}>
            <span class="cp-row-title">{r.name}</span>
            <span class="cp-row-meta">
              <span data-testid="cloud-routine-schedule">{scheduleInWords(r.schedule)}</span>
              {#if next}<span>Next {next}</span>{/if}
              {#if !r.enabled}<span>Paused</span>{/if}
            </span>
            {#if last}<span class="cp-state" data-tone={failed(r) ? "error" : "ok"}>{last}</span>{/if}
          </button>
          <div class="cp-row-side">
            {#if pending === r.id}<span class="cp-spin" aria-label="Saving"></span>{/if}
            <button
              type="button"
              class="cp-switch"
              role="switch"
              aria-checked={r.enabled}
              aria-label="{r.name} {r.enabled ? 'on' : 'off'}"
              data-testid="cloud-routine-toggle"
              disabled={pending !== null || offline}
              onclick={() => void toggle(r)}
            ></button>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
  {#if error}<p class="cp-error" role="alert" data-testid="cloud-routines-error">{error}</p>{/if}
</section>

{#if editing}
  <RoutineDialog
    {uid}
    {control}
    routine={editing.routine}
    botName={view.agent.displayName}
    {offline}
    onroutines={(routines) => onview({ routines })}
    {onoffline}
    onclose={() => (editing = null)}
  />
{/if}
