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

  /** "3m ago" / "2h ago" — coarse on purpose; the card is a glance, not a log. */
  export function relativeAge(iso: string | undefined, now: number = Date.now()): string | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  const updated = $derived(relativeAge(task.lastEventAt));
  const cardId = $derived(`task-chip-card-${task.id}`);
</script>

<span class="task-chip-row">
  <svelte:element
    this={interactive ? 'button' : 'span'}
    class="task-chip"
    class:is-interactive={interactive}
    type={interactive ? 'button' : undefined}
    data-testid="task-chip"
    aria-label={`${task.title}, ${statusLabel}`}
    aria-describedby={cardId}
    onclick={interactive ? () => onselect?.(task) : undefined}
  >
    <!-- Decorative, and safe to inline: the markup is generated wholly by
         taskMarkSvg from a hashed catalogue address. No task field — title,
         id, or status — is ever interpolated into it, so there is no path
         for task content to reach the DOM as markup. -->
    <span class="mark" style={`--mark-size: ${size}px;`}>{@html mark.svg}</span>
    <span class="title">{task.title}</span>
    <span class="dot" data-tone={tone} data-testid="task-chip-dot"></span>
  </svelte:element>

  <!-- Hover / focus card: the detail a glance at the chip does not carry.
       Plain text only — every field is either our own label or a
       control-stripped, bounded title. -->
  <span class="card" role="tooltip" id={cardId} data-testid="task-chip-card">
    <span class="card-title">{task.title}</span>
    <span class="card-row"><span class="dot" data-tone={tone}></span>{statusLabel}</span>
    {#if updated}
      <span class="card-row card-muted">Updated {updated}</span>
    {/if}
    {#if task.originMessageId}
      <span class="card-row card-muted">From a message in this thread</span>
    {/if}
    <span class="card-row card-muted card-id">{task.id}</span>
  </span>
</span>

<style>
  .task-chip-row {
    position: relative;
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
    padding: 2px 9px 2px 3px;
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

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-idle, var(--t3));
  }

  .dot[data-tone="ok"] {
    background: var(--v4-ok, var(--ok));
  }
  .dot[data-tone="warn"] {
    background: var(--v4-warn, var(--warn));
  }
  .dot[data-tone="error"] {
    background: var(--v4-error, var(--warn-ink));
  }
  .dot[data-tone="unread"] {
    background: var(--v4-unread, var(--v4-brand-accent));
  }

  .card {
    position: absolute;
    left: 0;
    bottom: calc(100% + 6px);
    z-index: 20;
    display: none;
    flex-direction: column;
    gap: 4px;
    min-width: 200px;
    max-width: 320px;
    padding: 8px 10px;
    border: 1px solid var(--pop-border, var(--line));
    border-radius: var(--v4-radius-popover, 10px);
    background: var(--pop-bg, var(--elevated));
    color: var(--pop-text, var(--t1));
    box-shadow: var(--pop-shadow, var(--v4-shadow-popover));
    font-size: var(--type-metadata, 13px);
    line-height: 16px;
    white-space: normal;
    pointer-events: none;
  }
  .task-chip-row:hover .card,
  .task-chip-row:focus-within .card {
    display: flex;
  }
  .card-title {
    font-weight: 600;
  }
  .card-row {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .card-row .dot[data-tone="ok"] {
    background: var(--v4-ok, var(--ok));
  }
  .card-row .dot[data-tone="warn"] {
    background: var(--v4-warn, var(--warn));
  }
  .card-row .dot[data-tone="error"] {
    background: var(--v4-error, var(--warn-ink));
  }
  .card-row .dot[data-tone="unread"] {
    background: var(--v4-unread, var(--v4-brand-accent));
  }
  .card-muted {
    color: var(--pop-muted, var(--t2));
  }
  .card-id {
    font-family: var(--font-mono);
    font-size: 11px;
  }
</style>
