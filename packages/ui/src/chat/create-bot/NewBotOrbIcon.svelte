<script lang="ts">
  /**
   * A glass orb with a white glyph inside: a cloud for Cloud bots, a laptop
   * for Local ones. Used on the "Where should <Name> live?" tiles.
   *
   * Decorative only (aria-hidden): the tile's title says the same thing.
   * Gradient ids come from $props.id(), so two orbs on one page never share
   * (and override) each other's gradients.
   */
  export type NewBotOrbKind = "cloud" | "local";

  interface Props {
    kind: NewBotOrbKind;
    /** Rendered size in px. */
    size?: number;
  }

  let { kind, size = 54 }: Props = $props();

  const uid = $props.id();
  const fillId = `new-bot-orb-fill-${uid}`;
  const shineId = `new-bot-orb-shine-${uid}`;

  /** Center and edge of the orb's fill: warm for Cloud, cool for Local. */
  const tint = $derived(
    kind === "cloud"
      ? { center: "rgba(255, 204, 186, 0.92)", edge: "rgba(255, 138, 168, 0.2)" }
      : { center: "rgba(170, 190, 255, 0.55)", edge: "rgba(120, 150, 255, 0.08)" },
  );
</script>

<svg
  class="new-bot-orb"
  data-testid={`new-bot-orb-${kind}`}
  data-kind={kind}
  width={size}
  height={size}
  viewBox="0 0 56 56"
  fill="none"
  aria-hidden="true"
  focusable="false"
>
  <defs>
    <radialGradient id={fillId} cx="0.35" cy="0.3" r="0.8">
      <stop offset="0" stop-color={tint.center} />
      <stop offset="1" stop-color={tint.edge} />
    </radialGradient>
    <radialGradient id={shineId} cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="#fff" stop-opacity="0.18" />
      <stop offset="1" stop-color="#fff" stop-opacity="0" />
    </radialGradient>
  </defs>
  <circle cx="28" cy="28" r="27.5" fill={`url(#${fillId})`} />
  <ellipse cx="19.5" cy="15.5" rx="12" ry="7" transform="rotate(-32 19.5 15.5)" fill={`url(#${shineId})`} />
  <circle cx="28" cy="28" r="27.5" stroke="rgba(255, 255, 255, 0.25)" stroke-width="1" />
  {#if kind === "cloud"}
    <!-- Three lobes on a flat base. Solid white, so the overlaps never show. -->
    <g class="new-bot-orb-glyph" fill="#fff" transform="translate(28 28) scale(1.2) translate(-28 -28)">
      <circle cx="20.5" cy="31.5" r="5.5" />
      <circle cx="28" cy="26.5" r="7.5" />
      <circle cx="35" cy="31" r="6" />
      <rect x="20.5" y="31" width="14.5" height="6" />
    </g>
  {:else}
    <!-- A screen with a lit face, and the base wider than it. -->
    <g class="new-bot-orb-glyph" transform="translate(28 28) scale(1.1) translate(-28 -28)">
      <rect x="18" y="18.5" width="20" height="13.5" rx="2.2" fill="rgba(255, 255, 255, 0.16)" stroke="#fff" stroke-width="2" />
      <path d="M13.5 35.2h29a2.6 2.6 0 0 1-2.6 2.6h-23.8a2.6 2.6 0 0 1-2.6-2.6z" fill="#fff" />
    </g>
  {/if}
</svg>
