<script lang="ts">
  import FileText from "phosphor-svelte/lib/FileText";
  import Lock from "phosphor-svelte/lib/Lock";
  import Sparkle from "phosphor-svelte/lib/Sparkle";
  import { agentAvatarFor } from "./agent-avatars";
  import { paintableAvatarSrc } from "../../avatars/csp-image-src.js";

  interface Props {
    kind?: "person" | "group" | "agent" | "channel" | "file";
    label?: string;
    members?: string[];
    privateChannel?: boolean;
    size?: "small" | "regular";
    online?: boolean;
    /** Real avatar photo — falls back to the monogram when absent or on error. */
    avatarUrl?: string | null;
    /** Agent uid — drives the deterministic generated avatar when the agent
     *  has no assigned photo. Ignored for non-agent kinds. */
    agentUid?: string | null;
  }

  let {
    kind = "person",
    label = "",
    members = [],
    privateChannel = false,
    size = "regular",
    online = false,
    avatarUrl = null,
    agentUid = null,
  }: Props = $props();

  // Photo > deterministic generated avatar (agents only) > monogram/glyph.
  // paintableAvatarSrc drops arbitrary http(s); the packaged CSP would
  // block those anyway, and we must not widen img-src to make them load.
  const effectiveAvatarUrl = $derived(
    paintableAvatarSrc(avatarUrl) ??
      (kind === "agent" ? agentAvatarFor(agentUid) : null),
  );

  // Drop back to the monogram if the image 404s / fails to decode.
  let imageBroken = $state(false);
  const showImage = $derived(
    Boolean(effectiveAvatarUrl) &&
      !imageBroken &&
      (kind === "person" || kind === "agent"),
  );

  function initials(value: string): string {
    const parts = value.trim().split(/\s+/).filter(Boolean);
    if (parts.length > 1)
      return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
    return value.trim().slice(0, 2).toUpperCase() || "DM";
  }

  const groupLabels = $derived(
    (members.length > 0 ? members : label.split(","))
      .map(initials)
      .filter(Boolean)
      .slice(0, 2),
  );
</script>

<span
  class="identity"
  class:small={size === "small"}
  data-kind={kind}
  aria-hidden="true"
>
  {#if showImage}
    <img
      class="avatar-img"
      src={effectiveAvatarUrl}
      alt=""
      onerror={() => (imageBroken = true)}
    />
  {:else if kind === "group"}
    <span class="stack">
      {#each groupLabels as member}<span>{member}</span>{/each}
    </span>
  {:else if kind === "channel"}
    {#if privateChannel}
      <Lock class="channel-lock" size={16} weight="fill" aria-hidden="true" />
    {:else}
      <span class="channel-glyph">#</span>
    {/if}
  {:else if kind === "agent"}
    <span class="agent-glyph"><Sparkle size={12} weight="fill" aria-hidden="true" /></span>
  {:else if kind === "file"}
    <FileText size={16} aria-hidden="true" />
  {:else}
    <span class="monogram">{initials(label)}</span>
  {/if}
  {#if online}<span class="presence"></span>{/if}
</span>

<style>
  .identity {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    color: var(--t2, var(--muted-2, var(--pop-muted)));
    font-family: var(--font-ui, var(--font-sans));
    font-size: 12px;
    font-weight: 600;
    line-height: 1;
  }
  .identity[data-kind="agent"] {
    background: var(--ice-tile, #2c3d52);
    color: var(--ice-ink, #c9d6e4);
    border-radius: 50%;
  }
  .identity.small {
    width: 22px;
    height: 22px;
    flex-basis: 22px;
    font-size: 8px;
  }
  .monogram {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: color-mix(in srgb, currentColor 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 8%, transparent);
    letter-spacing: 0.015em;
  }
  .avatar-img {
    width: 100%;
    height: 100%;
    border-radius: 50%;
    object-fit: cover;
    display: block;
  }
  .stack {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
  }
  .stack > span {
    position: absolute;
    top: 3px;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: color-mix(
      in srgb,
      var(--fg, var(--pop-text)) 13%,
      var(--v4-ground, #151515)
    );
    box-shadow: 0 0 0 1.5px var(--v4-ground, var(--pop-bg));
    font-size: 7px;
  }
  .stack > span:first-child {
    left: 0;
    z-index: 1;
  }
  .stack > span:last-child {
    right: 0;
  }
  .small .stack > span {
    top: 3px;
    width: 16px;
    height: 16px;
    font-size: 6px;
  }
  .channel-glyph {
    color: currentColor;
    font-size: 19px;
    font-weight: 450;
    line-height: 1;
  }
  .small .channel-glyph {
    font-size: 17px;
  }
  .agent-glyph {
    font-size: 16px;
    font-weight: 400;
  }
  .identity > svg:not(.channel-lock) {
    width: 15px;
    height: 15px;
  }
  .channel-lock {
    width: 14px;
    height: 14px;
  }
  .small .channel-lock {
    width: 13px;
    height: 13px;
  }
  .presence {
    position: absolute;
    right: -1px;
    bottom: 0;
    width: 6px;
    height: 6px;
    border: 1.5px solid var(--v4-ground, var(--pop-bg));
    border-radius: 50%;
    background: var(--v4-ok, #42d77d);
  }
</style>
