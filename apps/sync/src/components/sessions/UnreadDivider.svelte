<script lang="ts">
  // US-025: the "New" read/unread boundary. Uses the PROPOSED --ws-accent
  // Messages-surface blue with an achromatic fallback, per the token policy.
</script>

<div class="ws-unread-divider" role="separator" aria-label="New messages" data-testid="ws-unread-divider">
  <span class="line"></span>
  <span class="label">New</span>
</div>

<style>
  .ws-unread-divider {
    display: flex;
    align-items: center;
    padding: var(--v4-space-1) var(--v4-space-4);
  }

  .line {
    flex: 1;
    height: 1px;
    background: var(--ws-accent, var(--v4-unread));
    opacity: 0.5;
  }

  .label {
    flex: none;
    padding-left: var(--v4-space-2);
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--ws-accent, var(--v4-unread));
    user-select: none;
  }
</style>
