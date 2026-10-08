<script lang="ts">
  /**
   * A 14px provider mark tinted with a series color. It replaces the plain
   * color dot before a model or family name.
   */
  import { providerMark } from "./provider-marks.js";

  let { provider, color, opacity = 1 }: { provider: string; color: string; opacity?: number } = $props();
  const mark = $derived(providerMark(provider));
</script>

<svg
  class="pmark"
  data-provider-mark={provider}
  role="img"
  aria-label={mark.label}
  viewBox={mark.viewBox}
  width="14"
  height="14"
  style:color={color}
  style:opacity={opacity}
><path fill="currentColor" fill-rule="evenodd" d={mark.d} /></svg>

<style>
  .pmark { display: inline-block; flex: none; width: 14px; height: 14px; vertical-align: middle; }
</style>
