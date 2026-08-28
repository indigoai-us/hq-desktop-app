<script lang="ts">
  /**
   * Standard small degraded/unavailable state for platform-gated affordances.
   * Rendered wherever a desktop-only control (sync daemon, autostart,
   * self-update, tray) would otherwise appear on a host without that
   * capability — never a dead button, never a thrown error.
   */
  interface Props {
    /** Short noun for what is missing, e.g. "Automatic updates". */
    label?: string | null;
    /** Override the default explanation line. */
    message?: string | null;
    testid?: string;
  }

  let {
    label = null,
    message = null,
    testid = "unavailable-note",
  }: Props = $props();

  const copy = $derived(
    message ?? "Not available in this app. Use the HQ desktop app for this.",
  );
</script>

<p class="unavailable-note" role="status" data-testid={testid}>
  {#if label}<strong>{label}</strong>{/if}
  <span>{copy}</span>
</p>

<style>
  .unavailable-note {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    padding: 8px 0;
    color: var(--v4-text-3, var(--t3, #8a8a8a));
    font-size: var(--type-secondary, var(--text-sm, 11px));
    line-height: 1.35;
  }

  .unavailable-note strong {
    color: var(--v4-text-2, var(--t2, inherit));
    font-weight: 600;
  }
</style>
