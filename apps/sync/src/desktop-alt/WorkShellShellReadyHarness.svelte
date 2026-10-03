<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    bootTimeoutMs?: number;
    onShellReady?: () => void;
    extraPages?: Record<string, { createAction?: { label: string; param: () => string } }>;
    onactivecompanychange?: (company: { uid: string | null; slug: string } | null) => void;
  }

  let { bootTimeoutMs, onShellReady, extraPages, onactivecompanychange }: Props = $props();

  // Tests drive the open company pane through this seam (QA-075).
  (globalThis as { __harnessSetActiveCompany?: Props['onactivecompanychange'] })
    .__harnessSetActiveCompany = (company) => onactivecompanychange?.(company);

  onMount(() => {
    const initial = (globalThis as {
      __harnessInitialActiveCompany?: { uid: string | null; slug: string } | null;
    }).__harnessInitialActiveCompany;
    if (initial !== undefined) onactivecompanychange?.(initial);
    onShellReady?.();
  });
</script>

<div data-testid="work-shell-ready-harness" data-boot-timeout={bootTimeoutMs ?? 'default'}></div>
{#if extraPages?.sessions?.createAction}
  <button data-testid="session-create-action">{extraPages.sessions.createAction.label}</button>
{/if}
