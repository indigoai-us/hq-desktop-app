<script lang="ts">
  import "./rail-type.css";
  import { BRAND_ICONS, LINE_ICONS, isBrandIcon, type RailIconName } from "./rail-icons.js";

  interface Props {
    name: RailIconName;
    /** Rendered edge in px. Buttons use 14. */
    size?: number;
  }

  let { name, size = 14 }: Props = $props();
  const brand = $derived(isBrandIcon(name) ? BRAND_ICONS[name as keyof typeof BRAND_ICONS] : null);

  /**
   * Marks an icon that is the only visible content of its parent (an icon-only
   * button), so the leading-icon gap in rail-type.css does not push it off
   * centre, and an icon whose parent already spaces its children with `gap`
   * (data-gapped), so the gap is not applied twice. Labels are text or in-flow elements; tooltips that are absolutely
   * positioned or hidden do not count.
   */
  function solo(node: SVGSVGElement) {
    const check = () => {
      const parent = node.parentElement;
      if (!parent) return;
      const labelled = Array.from(parent.childNodes).some((child) => {
        if (child === node) return false;
        if (child.nodeType === Node.TEXT_NODE) return Boolean(child.textContent?.trim());
        if (!(child instanceof Element)) return false;
        const style = getComputedStyle(child);
        return style.display !== "none" && style.position !== "absolute" && style.position !== "fixed";
      });
      node.toggleAttribute("data-solo", !labelled);
      // A flex/grid button that spaces its own children already separates the
      // icon from the label; the shared leading-icon margin would double it.
      const style = getComputedStyle(parent);
      const gapped =
        /flex|grid/.test(style.display) && !["normal", "0px", ""].includes(style.columnGap);
      node.toggleAttribute("data-gapped", gapped);
    };
    check();
    const parent = node.parentElement;
    if (!parent || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(check);
    observer.observe(parent, { childList: true, characterData: true, subtree: true });
    return { destroy: () => observer.disconnect() };
  }
</script>

<svg
  class="rail-icon"
  data-rail-icon={name}
  width={size}
  height={size}
  viewBox={brand ? brand.viewBox : "0 0 256 256"}
  aria-hidden="true"
  focusable="false"
  use:solo
>
  {#if brand}
    <path
      class="brand-{brand.fill}"
      d={brand.d}
      fill={brand.fill === "current" ? "currentColor" : undefined}
      fill-rule="evenodd"
    />
  {:else}
    <!-- Phosphor Regular: filled outline paths. -->
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
