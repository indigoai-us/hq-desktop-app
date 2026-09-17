<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    bootTimeoutMs?: number;
    onShellReady?: () => void;
    extraPages?: Record<string, { createAction?: { label: string; param: () => string } }>;
  }

  let { bootTimeoutMs, onShellReady, extraPages }: Props = $props();

  onMount(() => onShellReady?.());
</script>

<div data-testid="work-shell-ready-harness" data-boot-timeout={bootTimeoutMs ?? 'default'}></div>
{#if extraPages?.sessions?.createAction}
  <button data-testid="session-create-action">{extraPages.sessions.createAction.label}</button>
{/if}
