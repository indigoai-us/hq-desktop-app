<script lang="ts">
  // US-025: buzz-style day boundary — a centered pill over a hairline.
  interface Props {
    label: string;
  }

  let { label }: Props = $props();
</script>

<div class="ws-day-divider" role="separator" aria-label={label} data-testid="ws-day-divider">
  <span class="line"></span>
  <span class="pill">{label}</span>
  <span class="line"></span>
</div>

<style>
  .ws-day-divider {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    padding: var(--v4-space-2) var(--v4-space-4);
  }

  .line {
    flex: 1;
    height: 1px;
    background: var(--v4-rowline);
  }

  .pill {
    flex: none;
    padding: 1px 10px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill);
    background: var(--v4-raised);
    font-size: 11px;
    letter-spacing: 0.02em;
    color: var(--v4-text-3);
    user-select: none;
  }
</style>
