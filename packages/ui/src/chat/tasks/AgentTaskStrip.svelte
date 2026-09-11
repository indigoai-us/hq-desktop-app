<script lang="ts">
  // Live strip of an agent's background tasks, rendered between the message
  // list and the composer — "status, not a message". Each task is a TaskChip.
  //
  // Renders NOTHING when there are no tasks: a status affordance must not
  // occupy space just to say it has nothing to say. Errors are likewise
  // silent here — a regular member polling an owner/admin-only route would
  // otherwise see a permanent error under every agent conversation.
  import TaskChip from "./TaskChip.svelte";
  import type { AgentTask } from "./agent-tasks";
  import { visibleTasks } from "./visible-tasks";

  interface Props {
    tasks: AgentTask[];
    /** Injectable clock for tests. */
    now?: () => number;
  }

  let { tasks, now = () => Date.now() }: Props = $props();
  const shown = $derived(visibleTasks(tasks, now()));
</script>

{#if shown.length > 0}
  <div class="agent-tasks" role="status" aria-live="polite" data-testid="agent-task-strip">
    {#each shown as task (task.id)}
      <TaskChip {task} />
    {/each}
  </div>
{/if}

<style>
  .agent-tasks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem 0.5rem;
    padding: 0 2px;
  }
</style>
