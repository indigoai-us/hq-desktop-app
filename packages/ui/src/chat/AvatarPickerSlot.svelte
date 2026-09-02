<script lang="ts">
  /**
   * AvatarPickerSlot — hook for `feat/agent-avatar-picker-packs`.
   * This branch does not implement a picker; the slot is a marked empty
   * surface so the other branch can drop the control in without restyling.
   */
  interface Props {
    agentUid: string;
    displayName: string;
    avatarUrl?: string | null;
    disabled?: boolean;
  }

  let {
    agentUid,
    displayName,
    avatarUrl = null,
    disabled = true,
  }: Props = $props();
</script>

<div
  class="avatar-picker-slot"
  data-testid="agent-detail-avatar-picker-slot"
  data-agent-uid={agentUid}
  data-disabled={disabled ? "true" : "false"}
  aria-label="Agent avatar picker (coming soon)"
>
  <span class="avatar-picker-slot-label">Avatar</span>
  <p class="avatar-picker-slot-copy">
    Photo picker for {displayName} lands on a separate branch.
    {#if avatarUrl}
      Current photo is already shown above.
    {/if}
  </p>
</div>

<style>
  .avatar-picker-slot {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  .avatar-picker-slot-label {
    color: var(--t3);
    font: 500 10px/1.2 var(--font-mono, ui-monospace, Menlo, monospace);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .avatar-picker-slot-copy {
    margin: 0;
    color: var(--t3);
    font-size: 12px;
    line-height: 1.4;
  }
</style>
