<!--
  First frame for the US-024 task view pane. The 360 px pane with a loader paints in the
  click frame; the pane body loads from its own chunk after.
-->
<script lang="ts">
  import { onMount, type Component } from "svelte";
  import { loadTaskView } from "./task-view-lazy";
  import ReadLoader from "../common/ReadLoader.svelte";

  let { ...rest }: Record<string, unknown> = $props();
  let Body = $state<Component<Record<string, unknown>> | null>(null);
  let failed = $state(false);

  onMount(() => {
    let alive = true;
    void loadTaskView()
      .then((mod) => {
        if (alive) Body = mod.default as unknown as Component<Record<string, unknown>>;
      })
      .catch((err) => {
        console.error("task view chunk failed to load:", err);
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if Body}
  <Body {...rest} />
{:else}
  <aside class="sk" aria-label="Task view" aria-busy={failed ? undefined : "true"} data-testid="task-view-loading-door">
    {#if failed}<p>Could not open the task view.</p>{:else}<ReadLoader testid="task-view-loading" />{/if}
  </aside>
{/if}

<style>
  .sk {
    width: 360px;
    flex: none;
    padding: 16px;
    border-left: 1px solid var(--v4-rowline);
    background: var(--v4-secondary-sidebar);
  }
  p {
    color: var(--v4-text-2);
    font-size: 13px;
  }
</style>
