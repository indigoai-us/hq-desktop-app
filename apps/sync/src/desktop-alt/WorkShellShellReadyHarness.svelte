<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    bootTimeoutMs?: number;
    onShellReady?: () => void;
  }

  let { bootTimeoutMs, onShellReady }: Props = $props();

  onMount(() => onShellReady?.());
</script>

<div data-testid="work-shell-ready-harness" data-boot-timeout={bootTimeoutMs ?? 'default'}></div>
