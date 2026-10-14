<script lang="ts">
  import { agentAvatarFor, paintableAvatarSrc } from '@hq/ui';
  import RailIcon from '@hq/ui/rail-icon';

  interface Props {
    kind?: 'person' | 'group' | 'agent' | 'channel' | 'file';
    label?: string;
    members?: string[];
    privateChannel?: boolean;
    size?: 'small' | 'regular';
    online?: boolean;
    /** Real avatar photo — falls back to the monogram when absent or on error. */
    avatarUrl?: string | null;
    /** Agent uid — drives the deterministic generated avatar for photo-less agents. */
    agentUid?: string | null;
  }

  let {
    kind = 'person', label = '', members = [], privateChannel = false,
    size = 'regular', online = false, avatarUrl = null, agentUid = null,
  }: Props = $props();

  // Photo > deterministic generated avatar (agents only) > monogram/glyph.
  const effectiveAvatarUrl = $derived(
    paintableAvatarSrc(avatarUrl) ??
      (kind === 'agent' ? agentAvatarFor(agentUid) : null),
  );

  let imageBroken = $state(false);
  const showImage = $derived(
    Boolean(effectiveAvatarUrl) && !imageBroken && (kind === 'person' || kind === 'agent'),
  );

  function initials(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1) return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
    return value.trim().slice(0, 2).toUpperCase() || 'DM';
  }

  const groupLabels = $derived(
    (members.length > 0 ? members : label.split(',')).map(initials).filter(Boolean).slice(0, 2),
  );
</script>

<span class="identity" class:small={size === 'small'} data-kind={kind} aria-hidden="true">
  {#if showImage}
    <img class="avatar-img" src={effectiveAvatarUrl} alt="" onerror={() => (imageBroken = true)} />
  {:else if kind === 'group'}
    <span class="stack">
      {#each groupLabels as member}<span>{member}</span>{/each}
    </span>
  {:else if kind === 'channel'}
    {#if privateChannel}
      <span class="channel-lock"><RailIcon name="lock" size={size === 'small' ? 13 : 14} /></span>
    {:else}
      <span class="channel-glyph"><RailIcon name="hash" size={size === 'small' ? 14 : 16} /></span>
    {/if}
  {:else if kind === 'agent'}
    <span class="agent-glyph"><RailIcon name="sparkle" size={size === 'small' ? 13 : 15} /></span>
  {:else if kind === 'file'}
    <span class="file-glyph"><RailIcon name="file" size={15} /></span>
  {:else}
    <span class="monogram">{initials(label)}</span>
  {/if}
  {#if online}<span class="presence"></span>{/if}
</span>

<style>
  .avatar-img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block}
  .identity{position:relative;display:inline-grid;place-items:center;width:28px;height:28px;flex:0 0 28px;color:var(--muted-2,var(--pop-muted));font-family:var(--font-sans);font-size:9px;font-weight:650;line-height:1}.identity.small{width:22px;height:22px;flex-basis:22px;font-size:8px}.monogram{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:color-mix(in srgb,currentColor 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 8%,transparent);letter-spacing:.015em}.stack{position:relative;display:block;width:100%;height:100%}.stack>span{position:absolute;top:3px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:color-mix(in srgb,var(--fg,var(--pop-text)) 13%,var(--v4-ground,#151515));box-shadow:0 0 0 1.5px var(--v4-ground,var(--pop-bg));font-size:7px}.stack>span:first-child{left:0;z-index:1}.stack>span:last-child{right:0}.small .stack>span{top:3px;width:16px;height:16px;font-size:6px}.channel-glyph,.agent-glyph,.file-glyph,.channel-lock{display:flex;color:currentColor}.presence{position:absolute;right:-1px;bottom:0;width:6px;height:6px;border:1.5px solid var(--v4-ground,var(--pop-bg));border-radius:50%;background:var(--v4-ok,#42d77d)}
</style>
