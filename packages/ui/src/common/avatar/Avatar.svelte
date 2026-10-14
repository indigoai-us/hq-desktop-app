<script lang="ts">
  /**
   * Shared avatar for people and bots (Team, Projects, Activity, Atlas).
   * Photo first; bots then show their bundled mascot art, never initials;
   * people then show initials on a color picked from their id. A presence
   * badge sits outside the circle, ringed in the surface color, so it never
   * covers the face or the name next to it.
   */
  import { avatarFace, avatarInitials, avatarHue, type AvatarKind } from "./avatar.js";

  interface Props {
    kind?: AvatarKind;
    name: string;
    /** Stable id (person or agent uid): drives color and mascot choice. */
    id?: string | null;
    /** Photo URL from the identity cache, if any. */
    photo?: string | null;
    /** Edge in px. */
    size?: number;
    /** Presence badge; omit for none. */
    presence?: "online" | "offline" | null;
    testid?: string;
  }

  let {
    kind = "person",
    name,
    id = null,
    photo = null,
    size = 24,
    presence = null,
    testid = "avatar",
  }: Props = $props();

  // A URL that failed to load is not retried; a new URL gets its own chance.
  let failed = $state<string | null>(null);
  const face = $derived.by(() => {
    const first = avatarFace({ kind, name, id, photo });
    if ((first.type === "photo" || first.type === "mascot") && first.src === failed) {
      const next = avatarFace({ kind, name, id, photo: null });
      if (next.type === "mascot" && next.src === failed) {
        return { type: "initials" as const, text: avatarInitials(name), hue: avatarHue(id ?? name) };
      }
      return next;
    }
    return first;
  });
  const fontSize = $derived(Math.max(8, Math.round(size * 0.4)));
  const badge = $derived(Math.max(6, Math.round(size * 0.3)));
</script>

<span
  class="av"
  class:bot={kind === "bot"}
  data-testid={testid}
  data-face={face.type}
  data-presence={presence ?? undefined}
  style={`--av-size:${size}px;--av-font:${fontSize}px;--av-badge:${badge}px;${face.type === "initials" ? `--av-hue:${face.hue};` : ""}`}
  aria-hidden="true"
>
  {#if face.type === "photo" || face.type === "mascot"}
    <img
      class="av-img"
      src={face.src}
      alt=""
      width={size}
      height={size}
      decoding="async"
      loading="lazy"
      onerror={() => (failed = face.type === "photo" || face.type === "mascot" ? face.src : null)}
    />
  {:else}
    <span class="av-text">{face.text}</span>
  {/if}
  {#if presence}
    <span class="av-presence" class:online={presence === "online"} data-testid="avatar-presence"></span>
  {/if}
</span>

<style>
  .av {
    position: relative;
    display: inline-grid;
    flex: 0 0 var(--av-size);
    place-items: center;
    width: var(--av-size);
    height: var(--av-size);
    border-radius: 999px;
    background: var(--v4-control-faint, var(--line2));
    color: var(--v4-text-2, var(--t2));
    font-size: var(--av-font);
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0;
  }
  .av.bot { border-radius: calc(var(--av-size) * 0.28); }

  /* Initials: a light tint of the person's hue, text in the darkest stop of
     the same hue, so every pair stays readable. */
  .av[data-face="initials"] {
    background: hsl(var(--av-hue) 62% 84%);
    color: hsl(var(--av-hue) 58% 22%);
  }
  @media (prefers-color-scheme: dark) {
    .av[data-face="initials"] {
      background: hsl(var(--av-hue) 34% 30%);
      color: hsl(var(--av-hue) 60% 86%);
    }
  }
  :global(:root[data-force-theme="light"]) .av[data-face="initials"] {
    background: hsl(var(--av-hue) 62% 84%);
    color: hsl(var(--av-hue) 58% 22%);
  }
  :global(:root[data-force-theme="dark"]) .av[data-face="initials"] {
    background: hsl(var(--av-hue) 34% 30%);
    color: hsl(var(--av-hue) 60% 86%);
  }

  .av-img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: inherit;
  }
  .av-text { white-space: nowrap; }

  /* Outside the circle at the lower right, with a 1px gap in the surface
     color, so it never overlaps the face or the text beside it. */
  .av-presence {
    position: absolute;
    right: calc(var(--av-badge) * -0.5);
    bottom: calc(var(--av-badge) * -0.25);
    width: var(--av-badge);
    height: var(--av-badge);
    border-radius: 999px;
    background: var(--v4-text-3, var(--t3));
    box-shadow: 0 0 0 1.5px var(--avatar-ring, var(--v4-ground, var(--bg, #fff)));
  }
  /* A rounded-square tile reaches further into its corner. */
  .av.bot .av-presence {
    right: calc(var(--av-badge) * -0.85);
    bottom: calc(var(--av-badge) * -0.6);
  }
  .av-presence.online { background: var(--v4-ok, var(--ok)); }
</style>
