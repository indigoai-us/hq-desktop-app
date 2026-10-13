<script lang="ts">
  import type { AgentControlApi, AgentControlRoutine, AgentControlRoutineInput } from "@hq/platform";
  import RailIcon from "../../../common/button/RailIcon.svelte";
  import ConfirmDialog from "../../../common/ConfirmDialog.svelte";
  import ControlDialog from "./ControlDialog.svelte";
  import { SCHEDULE_PRESETS, controlError, routinesFromPayload, scheduleInWords } from "./agent-control-model.js";

  interface Props {
    uid: string;
    control: AgentControlApi;
    routine: AgentControlRoutine | null;
    botName: string;
    offline: boolean;
    onroutines: (routines: AgentControlRoutine[]) => void;
    onoffline: () => void;
    onclose: () => void;
  }

  let { uid, control, routine, botName, offline, onroutines, onoffline, onclose }: Props = $props();

  function localZone(): string {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }

  // svelte-ignore state_referenced_locally
  const initial = {
    name: routine?.name ?? "",
    schedule: routine?.schedule ?? "0 9 * * 1-5",
    timezone: routine?.timezone ?? localZone(),
    prompt: routine?.prompt ?? "",
  };
  let name = $state(initial.name);
  let schedule = $state(initial.schedule);
  let timezone = $state(initial.timezone);
  let prompt = $state(initial.prompt);
  let busy = $state<"save" | "run" | "delete" | null>(null);
  let error = $state<string | null>(null);
  let note = $state<string | null>(null);
  let confirmDelete = $state(false);

  const dirty = $derived(
    name !== initial.name || schedule !== initial.schedule || timezone !== initial.timezone || prompt !== initial.prompt,
  );
  const words = $derived(scheduleInWords(schedule));
  const valid = $derived(name.trim() !== "" && prompt.trim() !== "" && schedule.trim().split(/\s+/).length === 5);

  function fail(res: Parameters<typeof controlError>[0]): void {
    const e = controlError(res);
    if (e.offline) onoffline();
    error = e.message;
  }

  async function relist(): Promise<boolean> {
    const listed = await control.listRoutines(uid);
    if (!listed.ok) return false;
    onroutines(routinesFromPayload(listed.value));
    return true;
  }

  async function save(): Promise<void> {
    if (!valid || busy) return;
    busy = "save";
    error = null;
    note = null;
    const input: AgentControlRoutineInput = {
      name: name.trim(),
      schedule: schedule.trim(),
      timezone: timezone.trim() || undefined,
      prompt: prompt.trim(),
    };
    const res = routine ? await control.updateRoutine(uid, routine.id, input) : await control.createRoutine(uid, { ...input, enabled: true });
    if (!res.ok) {
      busy = null;
      fail(res);
      return;
    }
    await relist();
    busy = null;
    onclose();
  }

  async function runNow(): Promise<void> {
    if (!routine || busy) return;
    busy = "run";
    error = null;
    note = null;
    const res = await control.runRoutine(uid, routine.id);
    if (!res.ok) {
      busy = null;
      fail(res);
      return;
    }
    await relist();
    busy = null;
    note = "Started. The result shows here when the run finishes.";
  }

  async function remove(): Promise<void> {
    confirmDelete = false;
    if (!routine || busy) return;
    busy = "delete";
    error = null;
    const res = await control.deleteRoutine(uid, routine.id);
    if (!res.ok) {
      busy = null;
      fail(res);
      return;
    }
    await relist();
    busy = null;
    onclose();
  }
</script>

<ControlDialog
  title={routine ? "Edit routine" : "New routine"}
  subtitle={botName}
  {dirty}
  busy={busy !== null}
  testid="cloud-routine-dialog"
  {onclose}
>
  <label class="cp-field">
    <span>Name</span>
    <input class="cp-input" data-autofocus data-testid="cloud-routine-name" bind:value={name} placeholder="Morning brief" />
  </label>
  <div class="cp-field">
    <span>Schedule</span>
    <div class="cp-seg" role="group" aria-label="Schedule presets">
      {#each SCHEDULE_PRESETS as preset (preset.id)}
        <button type="button" aria-pressed={schedule.trim() === preset.cron} data-testid="cloud-routine-preset-{preset.id}" onclick={() => (schedule = preset.cron)}>{preset.label}</button>
      {/each}
    </div>
    <input class="cp-input cp-mono" aria-label="Cron schedule" data-testid="cloud-routine-cron" bind:value={schedule} />
    <p class="cp-hint" data-testid="cloud-routine-words">{words}</p>
  </div>
  <label class="cp-field">
    <span>Time zone</span>
    <input class="cp-input" data-testid="cloud-routine-tz" bind:value={timezone} />
  </label>
  <label class="cp-field">
    <span>What the bot should do</span>
    <textarea class="cp-textarea" data-testid="cloud-routine-prompt" bind:value={prompt} placeholder="Summarize yesterday's messages and post the brief."></textarea>
  </label>
  {#if error}<p class="cp-error" role="alert" data-testid="cloud-routine-error">{error}</p>{/if}
  {#if note}<p class="cp-muted" role="status" data-testid="cloud-routine-note">{note}</p>{/if}
  {#snippet footer()}
    {#if routine}
      <button type="button" class="cp-btn danger" data-testid="cloud-routine-delete" disabled={busy !== null || offline} onclick={() => (confirmDelete = true)}>
        {#if busy === "delete"}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="trash" />{/if}Delete
      </button>
      <button type="button" class="cp-btn" data-testid="cloud-routine-run" disabled={busy !== null || offline} onclick={() => void runNow()}>
        {#if busy === "run"}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="play" />{/if}Run now
      </button>
    {/if}
    <span class="cp-grow"></span>
    <button type="button" class="cp-btn primary" data-testid="cloud-routine-save" disabled={!valid || busy !== null || offline || (routine !== null && !dirty)} onclick={() => void save()}>
      {#if busy === "save"}<span class="cp-spin" aria-hidden="true"></span>{:else}<RailIcon name="save" />{/if}{routine ? "Save" : "Create"}
    </button>
  {/snippet}
</ControlDialog>

<ConfirmDialog
  open={confirmDelete}
  title="Delete this routine?"
  message="It stops running and is removed from the bot."
  confirmLabel="Delete"
  danger
  onconfirm={() => void remove()}
  oncancel={() => (confirmDelete = false)}
/>
