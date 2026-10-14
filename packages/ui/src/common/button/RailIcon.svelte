<script lang="ts">
  import "./rail-type.css";
  import { BRAND_ICONS, LINE_ICONS, LINE_ICON_VIEWBOX, isBrandIcon, type RailIconName } from "./rail-icons.js";

  interface Props {
    name: RailIconName;
    /** Rendered edge in px. Buttons use 14. */
    size?: number;
  }

  let { name, size = 14 }: Props = $props();
  const brand = $derived(isBrandIcon(name) ? BRAND_ICONS[name as keyof typeof BRAND_ICONS] : null);
</script>

<svg
  class="rail-icon"
  data-rail-icon={name}
  width={size}
  height={size}
  viewBox={brand ? brand.viewBox : LINE_ICON_VIEWBOX}
  aria-hidden="true"
  focusable="false"
>
  {#if brand}
    <path
      class="brand-{brand.fill}"
      d={brand.d}
      fill={brand.fill === "current" ? "currentColor" : undefined}
      fill-rule="evenodd"
    />
  {:else}
    <!-- Phosphor regular: a filled outline glyph, no stroke. -->
    <path d={LINE_ICONS[name as keyof typeof LINE_ICONS]} fill="currentColor" />
  {/if}
</svg>

<style>
  .rail-icon { flex: none; display: block; }
  /* Official colours: Claude Spark Clay; OpenAI Blossom in its Black or White
     variant only (no added colours). */
  .brand-clay { fill: #d97757; }
  .brand-mono { fill: #000; }
  @media (prefers-color-scheme: dark) {
    .brand-mono { fill: #fff; }
  }
</style>
