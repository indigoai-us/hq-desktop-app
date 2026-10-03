<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    bootTimeoutMs?: number;
    onShellReady?: () => void;
    extraPages?: Record<string, { createAction?: { label: string; param: () => string } }>;
    hostNotifications?: Record<string, unknown>[];
    onackhostnotification?: (id: string) => void;
    onreadallhostnotifications?: () => void;
    onopenhostnotification?: (id: string, url: string) => void;
  }

  let {
    bootTimeoutMs,
    onShellReady,
    extraPages,
    hostNotifications = [],
    onackhostnotification,
    onreadallhostnotifications,
    onopenhostnotification,
  }: Props = $props();

  onMount(() => onShellReady?.());
</script>

<div data-testid="work-shell-ready-harness" data-boot-timeout={bootTimeoutMs ?? 'default'}></div>
{#if extraPages?.sessions?.createAction}
  <button data-testid="session-create-action">{extraPages.sessions.createAction.label}</button>
{/if}
<!-- Stand-in for the notifications feed: the host rows WorkShell would list. -->
<ul data-testid="harness-host-notifications">
  {#each hostNotifications as row (row.id)}
    <li
      data-testid="harness-host-notification"
      data-id={String(row.id)}
      data-type={String(row.type)}
      data-status={String(row.status)}
      data-target={row.targetRef ? String(row.targetRef) : ''}
    >
      <span class="title">{String(row.title)}</span>
      {#if row.targetRef}
        <button
          type="button"
          data-testid="harness-host-notification-open"
          onclick={() => onopenhostnotification?.(String(row.id), String(row.targetRef))}
        >Open</button>
      {/if}
      <button
        type="button"
        data-testid="harness-host-notification-ack"
        onclick={() => onackhostnotification?.(String(row.id))}
      >Read</button>
    </li>
  {/each}
</ul>
<button
  type="button"
  data-testid="harness-host-notifications-read-all"
  onclick={() => onreadallhostnotifications?.()}
>Read all</button>
