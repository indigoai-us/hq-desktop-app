<script lang="ts">
  /**
   * The brief's create control, on the page title row (right of "Daily
   * Brief", centred on that block). The app's standard buttons: a primary
   * Create brief when there is no brief yet or the newest one is from an
   * earlier day, a secondary Refresh once today's brief exists. Same action
   * either way; while a run is in flight the button says so and is disabled.
   * A blocked check shows its plain message and the fix beside it, with
   * the create button kept beside them so a fix made elsewhere is checked again.
   */
  import RailButton from "../common/button/RailButton.svelte";
  import type { BriefCreateRun } from "./brief-create.svelte.js";
  import { BRIEF_FIX_LABEL, createControl, type BriefIndexEntry } from "./brief-runs.js";

  interface Props {
    entries: readonly BriefIndexEntry[];
    now: Date;
    create: BriefCreateRun;
    oncreate?: () => void;
  }
  let { entries, now, create, oncreate }: Props = $props();

  const phase = $derived(create.phase);
  const control = $derived(createControl(entries, now));
  let fixError = $state<string | null>(null);
  let fixing = $state(false);

  async function runFix(): Promise<void> {
    if (fixing) return;
    fixing = true;
    fixError = await create.fix();
    fixing = false;
  }
  const label = $derived(
    control === "refresh" ? (create.busy ? "Refreshing…" : "Refresh") : create.busy ? "Creating…" : "Create brief",
  );
</script>

<div class="create" aria-live="polite" data-testid="brief-create-control">
  {#if phase.kind === "blocked"}
    <span class="msg" data-testid="brief-blocked">{phase.message}</span>
    {#if fixError}<span class="msg">{fixError}</span>{/if}
    <RailButton icon="play" variant="primary" onclick={() => void runFix()} disabled={fixing} data-testid="brief-fix">
      {fixing ? "Working…" : BRIEF_FIX_LABEL[phase.fix]}
    </RailButton>
    <!-- Stays available while blocked: after a fix made elsewhere, pressing it checks the bot again. -->
    <RailButton
      icon={control === "refresh" ? "refresh" : "plus"}
      variant="secondary"
      onclick={() => (oncreate ? oncreate() : void create.start())}
      data-testid="brief-create"
      data-control={control}
    >{label}</RailButton>
  {:else}
    <RailButton
      icon={control === "refresh" ? "refresh" : "plus"}
      variant={control === "refresh" ? "secondary" : "primary"}
      disabled={create.busy}
      aria-busy={create.busy}
      onclick={() => (oncreate ? oncreate() : void create.start())}
      data-testid="brief-create"
      data-control={control}
    >{label}</RailButton>
  {/if}
</div>

<style>
  .create {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .msg {
    font-size: 13px;
    color: var(--b-t2);
  }
</style>
