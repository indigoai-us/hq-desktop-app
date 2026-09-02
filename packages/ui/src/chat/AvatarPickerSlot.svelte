<script lang="ts">
  /**
   * AvatarPickerSlot — agent-detail hook for the pack picker from
   * `feat/agent-avatar-picker-packs`. Same save contract as MemberProfilePanel.
   */
  import AvatarPackPicker from "../avatars/AvatarPackPicker.svelte";
  import type { AvatarPack, AvatarSelection } from "../avatars/types.js";

  interface Props {
    agentUid: string;
    displayName: string;
    avatarUrl?: string | null;
    disabled?: boolean;
    packs?: AvatarPack[] | null;
    saving?: boolean;
    error?: string | null;
    onsave?: (selection: AvatarSelection) => void | Promise<void>;
  }

  let {
    agentUid,
    displayName,
    avatarUrl = null,
    disabled = false,
    packs = null,
    saving = false,
    error = null,
    onsave,
  }: Props = $props();
</script>

<div
  class="avatar-picker-slot"
  data-testid="agent-detail-avatar-picker-slot"
  data-agent-uid={agentUid}
  data-disabled={disabled ? "true" : "false"}
  aria-label={disabled
    ? `Avatar picker for ${displayName} (read-only)`
    : `Avatar picker for ${displayName}`}
>
  <span class="avatar-picker-slot-label">Avatar</span>
  {#if disabled}
    <p class="avatar-picker-slot-copy">
      You don't have permission to change this photo.
      {#if avatarUrl}
        Current photo is already shown above.
      {/if}
    </p>
  {:else}
    <AvatarPackPicker
      {agentUid}
      currentSrc={avatarUrl}
      {packs}
      {saving}
      {error}
      {onsave}
    />
  {/if}
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
