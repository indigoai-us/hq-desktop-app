<script lang="ts">
  // Live strip of an agent's background tasks, rendered under the last message
  // through Conversation's `belowMessages` slot — the same "status, not a
  // message" slot the agent-thinking row uses. Each task is a TaskChip.
  //
  // Renders NOTHING when there are no tasks: a status affordance must not
  // occupy space just to say it has nothing to say. Errors are likewise
  // silent here — a regular member polling an owner/admin-only route would
  // otherwise see a permanent error under every agent channel.
  import TaskChip from '../../desktop-alt/components/TaskChip.svelte';
  import type { AgentTask } from '../../desktop-alt/lib/agent-tasks';

  interface Props {
    tasks: AgentTask[];
  }

  let { tasks }: Props = $props();
</script>

{#if tasks.length > 0}
  <div class="agent-tasks" role="status" aria-live="polite" data-testid="agent-task-strip">
    {#each tasks as task (task.id)}
      <TaskChip {task} />
    {/each}
  </div>
{/if}

<style>
  .agent-tasks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 0.75rem;
    margin-top: 0.5rem;
  }
</style>
