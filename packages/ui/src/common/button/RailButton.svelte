<script lang="ts">
  /**
   * Shared labelled console-rail button (design standard §4, "Labelled
   * button"). Size comes from the one button standard (button-standard.css),
   * measured from the top-bar Launch / Core pills: 30.85px tall, 0 10px
   * padding, 13px/500 label, 14px icon at 1.5 stroke, 6px gap, 8px radius.
   * The icon is required: a labelled button without one fails the guard
   * test (button-icons.guard.test.ts). Icon-only buttons do not use this.
   */
  import type { HTMLButtonAttributes } from "svelte/elements";
  import RailIcon from "./RailIcon.svelte";
  import "./rail-type.css";
  import "./button-standard.css";
  import type { RailIconName } from "./rail-icons.js";

  interface Props extends Omit<HTMLButtonAttributes, "children"> {
    icon: RailIconName;
    variant?: "secondary" | "primary" | "ghost" | "danger";
    /** Kept for call-site compatibility; every size renders at the standard. */
    size?: "default" | "compact";
    extraClass?: string;
    children: import("svelte").Snippet;
  }

  let {
    icon,
    variant = "secondary",
    size = "default",
    extraClass = "",
    type = "button",
    children,
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  class="rail-btn {variant} {size} {extraClass}"
  data-rail-btn
>
  <RailIcon name={icon} size={14} />
  <span class="rail-btn-label">{@render children()}</span>
</button>

<style>
  .rail-btn {
    appearance: none;
    -webkit-appearance: none;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--hq-btn-gap);
    height: var(--hq-btn-h);
    padding: 0 var(--hq-btn-pad-inline);
    margin: 0;
    border: var(--hq-btn-border) solid var(--line2, var(--v4-control-border));
    border-radius: var(--hq-btn-radius);
    background: var(--btn-bg, var(--v4-control-faint));
    color: var(--t1, var(--v4-text-1));
    font-family: inherit;
    font-size: var(--hq-btn-font-size);
    font-weight: 500;
    line-height: var(--hq-btn-line-height);
    white-space: nowrap;
    cursor: pointer;
    flex: none;
  }
  .rail-btn:hover:not(:disabled) { background: var(--hover); }
  .rail-btn.primary { background: var(--t1, var(--v4-primary-bg)); color: var(--panel-bg, var(--v4-primary-fg)); border-color: transparent; }
  .rail-btn.primary:hover:not(:disabled) { background: var(--t1, var(--v4-primary-bg)); opacity: 0.85; }
  .rail-btn.ghost { background: transparent; border-color: transparent; color: var(--t2, var(--v4-text-2)); }
  .rail-btn.ghost:hover:not(:disabled) { color: var(--t1); }
  .rail-btn.danger { color: var(--red, var(--v4-error)); }
  .rail-btn:disabled { opacity: 0.5; cursor: default; }
  .rail-btn:focus-visible { outline: 2px solid var(--v4-focus-ring, var(--v4-control-border)); outline-offset: 2px; }
  .rail-btn-label { display: inline-block; }
</style>
