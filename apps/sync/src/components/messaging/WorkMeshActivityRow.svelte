<script lang="ts">
  // Compact one-line row for work-mesh session events that would otherwise
  // render as a raw JSON bubble in a project channel.
  import type { WorkSessionActivity } from '../../lib/workSessionEvent';

  interface Props {
    activity: WorkSessionActivity;
    time: string;
  }

  let { activity, time }: Props = $props();

  // Done inserts the story id between "marked" and "done"; other kinds put
  // the id after the verb. Omit the id token when it is null.
  function verbPhrase(row: WorkSessionActivity): string {
    const id = row.storyId;
    if (row.kind === 'done') return id ? `marked ${id} done` : 'marked done';
    return id ? `${row.verb} ${id}` : row.verb;
  }

  const fullLabel = $derived(
    `${activity.actor} ${verbPhrase(activity)}${activity.title ? ` — ${activity.title}` : ''}`,
  );
</script>

<div class="work-mesh-row">
  <span class="icon" aria-hidden="true">
    {#if activity.kind === 'blocked'}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M8 2.75 14.2 13.4H1.8L8 2.75Z"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
        <path d="M8 6.7v3.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <path d="M8 11.65h.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
    {:else if activity.kind === 'done'}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path
          d="M3 8.5 6.5 12 13 4.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {:else}
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4.5 2.5v8.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        <circle cx="4.5" cy="13" r="1.55" stroke="currentColor" stroke-width="1.4" />
        <circle cx="12" cy="4.5" r="1.55" stroke="currentColor" stroke-width="1.4" />
        <path
          d="M12 6.05a5.15 5.15 0 0 1-5.15 5.15"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
      </svg>
    {/if}
  </span>
  <p class="text" title={fullLabel}>
    <span class="actor">{activity.actor}</span><span class="verb"> {verbPhrase(activity)}</span>{#if activity.title}<span class="title"> — {activity.title}</span>{/if}
  </p>
  {#if time}
    <span class="time">{time}</span>
  {/if}
</div>

<style>
  .work-mesh-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    width: 100%;
    min-width: 0;
    font-size: var(--text-base);
    line-height: 1.3;
  }

  .icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--muted-2, var(--pop-muted));
  }

  .text {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .actor {
    font-weight: 600;
    color: var(--fg, var(--pop-text));
  }

  .verb {
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .title {
    color: var(--muted, var(--pop-muted));
  }

  .time {
    flex-shrink: 0;
    font-size: var(--text-micro, var(--text-base));
    font-family: var(--font-mono, inherit);
    color: var(--muted-3, var(--pop-muted));
  }
</style>
