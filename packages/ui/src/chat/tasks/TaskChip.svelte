<script lang="ts">
  import {
    AGENT_TASK_STATUS_LABEL,
    agentTaskTone,
    taskMark,
    type AgentTask,
  } from "./agent-tasks";

  interface Props {
    /** The background task to represent. */
    task: AgentTask;
    /** Rendered mark size in px; the art itself is resolution independent. */
    size?: number;
    /** Selection callback — omit to render a non-interactive chip. */
    onselect?: (task: AgentTask) => void;
  }

  let { task, size = 16, onselect }: Props = $props();

  // Family comes from the task's category so the shape carries meaning; the
  // variant comes from the task id so a task keeps the same mark for life.
  const mark = $derived(taskMark(task, size));
  const tone = $derived(agentTaskTone(task.status));
  const statusLabel = $derived(AGENT_TASK_STATUS_LABEL[task.status]);
  const interactive = $derived(onselect !== undefined);
</script>

<span class="task-chip-row">
  <svelte:element
    this={interactive ? 'button' : 'span'}
    class="task-chip"
    class:is-interactive={interactive}
    type={interactive ? 'button' : undefined}
    data-testid="task-chip"
    title={`${task.title} — ${statusLabel}`}
    aria-label={`${task.title}, ${statusLabel}`}
    onclick={interactive ? () => onselect?.(task) : undefined}
  >
    <!-- Decorative, and safe to inline: the markup is generated wholly by
         taskMarkSvg from a hashed catalogue address. No task field — title,
         id, or status — is ever interpolated into it, so there is no path
         for task content to reach the DOM as markup. -->
    <span class="mark" style={`--mark-size: ${size}px;`}>{@html mark.svg}</span>
    <span class="title">{task.title}</span>
  </svelte:element>

  <span class="status" data-tone={tone}>
    <span class="dot"></span>{statusLabel}
  </span>
</span>

<style>
  .task-chip-row {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    max-width: 100%;
    min-width: 0;
  }

  .task-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    padding: 2px 8px 2px 3px;
    border: 1px solid var(--line);
    border-radius: var(--v4-radius-pill, 980px);
    background: var(--hover);
    color: var(--t1);
    font-family: inherit;
    font-size: var(--type-metadata, 13px);
    font-weight: 500;
    line-height: 16px;
    text-align: left;
  }

  .task-chip.is-interactive {
    cursor: pointer;
  }

  .task-chip.is-interactive:hover {
    border-color: var(--line2);
  }

  .task-chip:focus-visible {
    outline: 2px solid var(--v4-focus-ring);
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .mark {
    display: block;
    flex: none;
    width: var(--mark-size);
    height: var(--mark-size);
  }

  .title {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    flex: none;
    color: var(--t2);
    font-size: var(--type-metadata, 13px);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-idle, var(--t3));
  }

  .status[data-tone="ok"] .dot {
    background: var(--v4-ok, var(--ok));
  }
  .status[data-tone="warn"] .dot {
    background: var(--v4-warn, var(--warn));
  }
  .status[data-tone="error"] .dot {
    background: var(--v4-error, var(--warn-ink));
  }
  .status[data-tone="unread"] .dot {
    background: var(--v4-unread, var(--v4-brand-accent));
  }
</style>
