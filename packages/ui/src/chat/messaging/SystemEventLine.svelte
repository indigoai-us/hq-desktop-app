<script lang="ts">
  import Check from "phosphor-svelte/lib/Check";
  import Circle from "phosphor-svelte/lib/Circle";
  import Clock from "phosphor-svelte/lib/Clock";
  import FileText from "phosphor-svelte/lib/FileText";
  import GitPullRequest from "phosphor-svelte/lib/GitPullRequest";
  import RocketLaunch from "phosphor-svelte/lib/RocketLaunch";
  import Warning from "phosphor-svelte/lib/Warning";
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
      <Clock size={14} aria-hidden="true" />
    {:else if model.type === "pr_opened"}
      <GitPullRequest size={14} aria-hidden="true" />
    {:else if model.type === "deploy"}
      <RocketLaunch size={14} aria-hidden="true" />
    {:else if model.type === "work_session_blocked"}
      <Warning size={14} aria-hidden="true" />
    {:else if model.type === "work_session_finished"}
      <Check size={14} aria-hidden="true" />
    {:else if model.type === "work_session_task_status"}
      <Circle size={14} aria-hidden="true" />
    {:else}
      <!-- file_added / member_added -->
      <FileText size={14} aria-hidden="true" />
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
