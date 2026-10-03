<script lang="ts">
  import { BRAND_ICONS, LINE_ICONS, isBrandIcon, type RailIconName } from "./rail-icons.js";

  interface Props {
    name: RailIconName;
    /** Rendered edge in px. Buttons use 14. */
    size?: number;
  }

  let { name, size = 14 }: Props = $props();
  const brand = $derived(isBrandIcon(name));
</script>

<svg
  class="rail-icon"
  data-rail-icon={name}
  width={size}
  height={size}
  viewBox="0 0 16 16"
  aria-hidden="true"
  focusable="false"
>
  {#if brand}
    <path d={BRAND_ICONS[name as keyof typeof BRAND_ICONS]} fill="currentColor" fill-rule="evenodd" />
  {:else}
    <path
      d={LINE_ICONS[name as keyof typeof LINE_ICONS]}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  {/if}
</svg>

<style>
  .rail-icon { flex: none; display: block; }
</style>
