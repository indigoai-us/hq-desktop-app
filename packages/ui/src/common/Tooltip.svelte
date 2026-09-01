<script lang="ts">
  /**
   * Small shared tooltip for icon-only controls.
   *
   * WHY this exists: the app had no tooltip component — icon buttons relied on
   * the native `title=` attribute, which is unstyled, slow (~1-2s OS delay),
   * invisible to keyboard users, and impossible to theme. The title-bar
   * actions cluster (Launch / folder / Console / meetings / bell / Core) is
   * six adjacent icons where that ambiguity is worst, so this is the first
   * consumer. Reuse it for any other icon-only control.
   *
   * Behavior: appears on hover after `delay` ms (default 400) and IMMEDIATELY
   * on keyboard focus (a focused control should not make you wait), hides on
   * blur / pointer-leave / Escape. Positioned below the trigger. Wired to the
   * trigger via `aria-describedby`, so screen readers announce the label
   * without the tooltip having to be focusable.
   *
   * The trigger is supplied as a snippet and receives the generated id; the
   * consumer spreads it onto the real control as `aria-describedby`. The
   * wrapper never intercepts clicks (`display: contents` would break
   * positioning, so it is an inline-flex span with no padding).
   */
  import type { Snippet } from "svelte";

  interface Props {
    /** Tooltip text. Empty/omitted renders the trigger with no tooltip. */
    label?: string | null;
    /** Hover dwell before showing, in ms. Focus always shows immediately. */
    delay?: number;
    /** Horizontal alignment of the bubble relative to the trigger. */
    align?: "center" | "start" | "end";
    /** The control this tooltip describes. Receives the tooltip element id. */
    trigger: Snippet<[string]>;
  }

  let { label = null, delay = 400, align = "center", trigger }: Props =
    $props();

  const id = `tooltip-${Math.random().toString(36).slice(2, 10)}`;
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function showAfterDelay(): void {
    if (!label) return;
    clearTimer();
    timer = setTimeout(() => {
      open = true;
      timer = null;
    }, delay);
  }

  /** Focus is intentional — no dwell delay. */
  function showNow(): void {
    if (!label) return;
    clearTimer();
    open = true;
  }

  function hide(): void {
    clearTimer();
    open = false;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") hide();
  }

  $effect(() => () => clearTimer());
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="tooltip-wrap"
  onpointerenter={showAfterDelay}
  onpointerleave={hide}
  onfocusin={showNow}
  onfocusout={hide}
  onkeydown={onKeyDown}
>
  {@render trigger(label ? id : "")}
  {#if open && label}
    <span
      class="tooltip-bubble"
      class:align-start={align === "start"}
      class:align-end={align === "end"}
      role="tooltip"
      {id}
      data-testid="tooltip-bubble"
    >
      {label}
    </span>
  {/if}
</span>

<style>
  .tooltip-wrap {
    position: relative;
    display: inline-flex;
    align-items: center;
  }

  /* Dark, near-opaque bubble below the trigger. Uses the popover-strong
     convention for the same reason the Launch menu does: a nested
     backdrop-filter is neutered outside its parent's backdrop root, so a
     glass surface would let chrome read through. `pointer-events: none`
     keeps the bubble from ever stealing a hover or click from the button. */
  .tooltip-bubble {
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 10001;
    max-width: 220px;
    padding: 4px 8px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 6px;
    background: var(--v4-popover-strong, var(--panel-bg));
    box-shadow: var(--panel-shadow, 0 4px 12px rgba(0, 0, 0, 0.22));
    color: var(--t1);
    font-size: 11px;
    font-weight: 500;
    line-height: 1.35;
    white-space: nowrap;
    pointer-events: none;
    animation: tooltip-in 100ms ease-out;
  }

  .tooltip-bubble.align-start {
    left: 0;
    transform: none;
  }

  .tooltip-bubble.align-end {
    left: auto;
    right: 0;
    transform: none;
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateX(var(--tooltip-shift, -50%)) translateY(-2px);
    }
  }

  .tooltip-bubble.align-start,
  .tooltip-bubble.align-end {
    --tooltip-shift: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .tooltip-bubble {
      animation: none;
    }
  }
</style>
