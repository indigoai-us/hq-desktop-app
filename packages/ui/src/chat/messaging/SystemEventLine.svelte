<script lang="ts">
  // Muted one-line system event for the channel timeline (US-004).
  // Icons are inline SVG only — no emoji in chrome. Emoji remain reserved for
  // user reaction content elsewhere.
  import type { SystemEventLineModel } from "./channelMessageModels";

  interface Props {
    model: SystemEventLineModel;
    who?: string | null;
    time?: string | null;
  }

  let { model, who = null, time = null }: Props = $props();
</script>

<div
  class="sys-line"
  data-testid="system-event-line"
  data-system-type={model.type}
  role="status"
>
  <span class="sys-icon" aria-hidden="true">
    {#if model.type === "run_started" || model.type === "run_progress"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="8"
          cy="8"
          r="5.5"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <path
          d="M8 5v3.2L10 10"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {:else if model.type === "pr_opened"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="4.5"
          cy="4"
          r="1.75"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <circle
          cx="4.5"
          cy="12"
          r="1.75"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <circle
          cx="11.5"
          cy="12"
          r="1.75"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <path
          d="M4.5 5.75v4.5M11.5 10.25V7.5A3 3 0 0 0 8.5 4.5H6.25"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      </svg>
    {:else if model.type === "deploy"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M3 11.5 8 3l5 8.5H3Z"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
        <path
          d="M8 7v6"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      </svg>
    {:else if model.type === "work_session_blocked"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M8 2.75 14.2 13.4H1.8L8 2.75Z"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linejoin="round"
        />
        <path
          d="M8 6.7v3.1"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        />
        <path
          d="M8 11.65h.01"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        />
      </svg>
    {:else if model.type === "work_session_finished"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M3 8.5 6.5 12 13 4.5"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    {:else if model.type === "work_session_task_status"}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="8"
          cy="8"
          r="5.5"
          stroke="currentColor"
          stroke-width="1.3"
        />
        <path
          d="M8 4.75v3.5l2.25 1.35"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      </svg>
    {:else}
      <!-- file_added / member_added -->
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5Z"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
        <path
          d="M9 1.5V5.5H13"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linejoin="round"
        />
        <path
          d="M8 8v3.5M6.25 9.75H9.75"
          stroke="currentColor"
          stroke-width="1.3"
          stroke-linecap="round"
        />
      </svg>
    {/if}
  </span>
  {#if who}
    <span class="sys-who">{who}</span>
  {/if}
  <span class="sys-title">{model.title}</span>
  {#if model.summary}
    <span class="sys-summary">· {model.summary}</span>
  {/if}
  {#if time}
    <span class="sys-time">· {time}</span>
  {/if}
</div>

<style>
  .sys-line {
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: 12px;
    width: 100%;
    max-width: 100%;
    box-sizing: border-box;
    min-height: 16px;
    margin: 6px 0;
    padding: 0;
    color: var(--t3, var(--muted, var(--pop-muted)));
    font-size: 11px;
    line-height: 1.45;
    text-align: left;
  }

  .sys-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 32px;
    width: 32px;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
    opacity: 0.7;
  }

  .sys-who {
    font-weight: 500;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .sys-title {
    font-weight: 400;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .sys-summary,
  .sys-time {
    color: var(--t3, var(--muted, var(--pop-muted)));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
</style>
