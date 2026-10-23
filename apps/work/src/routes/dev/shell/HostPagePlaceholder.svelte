<script lang="ts">
  /**
   * Stand-in for a host-owned extra page.
   *
   * The desktop injects real pages into the shell at runtime — Sessions lives
   * in `apps/sync`, not in `@hq/ui`, so this harness cannot mount it. What it
   * can do is register the page so the *chrome* around it is real: the command
   * palette entry, the sidebar destination, and the header's create action all
   * come from the shell, and all three were invisible while no extra page was
   * registered at all.
   *
   * The body is deliberately plain. It is not a design surface — mistaking it
   * for one is the failure mode this note exists to prevent.
   */
  let { param = null }: { param?: string | null } = $props();
</script>

<div class="host-page">
  <p>This page is supplied by the desktop host and is not part of the shell.</p>
  {#if param}<p class="param">Route parameter: <code>{param}</code></p>{/if}
</div>

<style>
  .host-page {
    display: grid;
    gap: 8px;
    place-content: center;
    height: 100%;
    padding: 48px 24px;
    color: var(--t3);
    font-size: 13px;
    text-align: center;
  }

  .param code {
    font-family: var(--font-mono);
    font-size: 12px;
  }
</style>
