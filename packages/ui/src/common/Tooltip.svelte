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
    /**
     * Kept for callers that still pass it; ignored. The bubble is always
     * centred on its trigger and shifted only as far as the window edge
     * forces — an alignment chosen up front was wrong as soon as the window
     * was a different width.
     */
    align?: "center" | "start" | "end";
    /**
     * Let the label wrap. The default bubble is a one-line hint for an icon
     * button; a sentence of prose (a project description, say) needs to wrap
     * rather than run off the end of a 220px nowrap line.
     */
    multiline?: boolean;
    /**
     * Silence the tooltip while the trigger owns something else on screen.
     * A pill that opens a menu must not also describe itself: the bubble
     * covers the first row of the menu it just opened.
     */
    suppressed?: boolean;
    /** The control this tooltip describes. Receives the tooltip element id. */
    trigger: Snippet<[string]>;
  }

  let {
    label = null,
    delay = 400,
    align: _align = "center",
    multiline = false,
    suppressed = false,
    trigger,
  }: Props = $props();

  const id = `tooltip-${Math.random().toString(36).slice(2, 10)}`;
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let bubbleEl = $state<HTMLElement | null>(null);
  /** px to nudge the centred bubble so it stays inside the window. */
  let shift = $state(0);

  /** Keep the tooltip 8px clear of either window edge, centred otherwise. */
  function clampToViewport(): void {
    const el = bubbleEl;
    if (!el || typeof window === "undefined") return;
    shift = 0;
    // Measure with no shift applied, then correct in one step.
    const margin = 8;
    const rect = el.getBoundingClientRect();
    const overLeft = margin - rect.left;
    const overRight = rect.right - (window.innerWidth - margin);
    if (overLeft > 0) shift = overLeft;
    else if (overRight > 0) shift = -overRight;
  }

  $effect(() => {
    if (!open) {
      shift = 0;
      return;
    }
    void bubbleEl;
    clampToViewport();
  });

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
  {@render trigger(label && !suppressed ? id : "")}
  {#if open && label && !suppressed}
    <span
      bind:this={bubbleEl}
      class="tooltip-bubble"
      class:multiline
      style={shift === 0 ? undefined : `--tooltip-shift: ${shift}px`}
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
    /* Centred on the trigger; `--tooltip-shift` is set only when the window
       edge would clip the bubble. */
    transform: translateX(calc(-50% + var(--tooltip-shift, 0px)));
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

  /* `width: max-content` is doing the work, not `max-width`. An absolutely
     positioned box shrink-to-fits against its CONTAINING BLOCK, and that is
     the 24px icon it hangs off — so a wrapping label folded to icon width and
     the 280px cap never came into play. */
  .tooltip-bubble.multiline {
    width: max-content;
    max-width: 280px;
    white-space: normal;
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateX(calc(-50% + var(--tooltip-shift, 0px)))
        translateY(-2px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tooltip-bubble {
      animation: none;
    }
  }
</style>
