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
     * Preferred horizontal alignment of the bubble relative to the trigger.
     * If the preferred placement would run off a window edge, the bubble
     * flips to edge alignment with the trigger on that side instead.
     */
    align?: "center" | "start" | "end";
    /** Which side of the trigger the bubble opens on. The app rail uses right. */
    side?: "bottom" | "right";
    /**
     * Silence the tooltip while the trigger owns something else on screen.
     * A pill that opens a menu must not also describe itself: the bubble
     * would cover the first row of the menu it just opened.
     */
    suppressed?: boolean;
    /** The control this tooltip describes. Receives the tooltip element id. */
    trigger: Snippet<[string]>;
  }

  let {
    label = null,
    delay = 400,
    align = "center",
    side = "bottom",
    suppressed = false,
    trigger,
  }: Props = $props();

  const id = `tooltip-${Math.random().toString(36).slice(2, 10)}`;
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wrap: HTMLSpanElement | null = $state(null);

  /** A control whose menu or popover is open must not keep its tooltip on
   *  top of that menu (the Launch tooltip sat over the open Launch menu). */
  function controlExpanded(): boolean {
    return wrap?.querySelector('[aria-expanded="true"]') != null;
  }
  let bubbleEl = $state<HTMLElement | null>(null);
  /** px to move the bubble from its `align` position to stay in the window. */
  let shift = $state(0);

  /** Keep the bubble this far from either window edge. */
  const WINDOW_MARGIN = 8;

  /**
   * Keep the bubble inside the window. When the preferred placement (`align`)
   * would run off a window edge, the bubble does NOT merely slide as far as it
   * has to — it flips to edge alignment with the TRIGGER (right edge to right
   * edge near the right of the window, left to left near the left). A bubble
   * nudged just far enough to fit reads as accidentally off-centre; one
   * aligned to the button's own edge reads as deliberate. The window margin
   * is applied last, as a backstop for a bubble wider than the room beside
   * its trigger.
   */
  function keepInsideWindow(): void {
    const el = bubbleEl;
    const anchor = el?.parentElement;
    if (!el || !anchor || typeof window === "undefined") return;
    const width = el.getBoundingClientRect().width;
    const trigger = anchor.getBoundingClientRect();
    const viewport = window.innerWidth;

    const preferredLeft =
      align === "start"
        ? trigger.left
        : align === "end"
          ? trigger.right - width
          : trigger.left + trigger.width / 2 - width / 2;

    let left = preferredLeft;
    if (left + width > viewport - WINDOW_MARGIN) left = trigger.right - width;
    else if (left < WINDOW_MARGIN) left = trigger.left;

    const maxLeft = viewport - WINDOW_MARGIN - width;
    if (left > maxLeft) left = maxLeft;
    if (left < WINDOW_MARGIN) left = WINDOW_MARGIN;

    shift = Math.round(left - preferredLeft);
  }

  $effect(() => {
    // The rail's right-side bubble opens away from the window edge; only
    // the below-the-trigger placement can run off the left/right edge.
    if (!open || !bubbleEl || side !== "bottom") {
      shift = 0;
      return;
    }
    void label;
    void align;
    keepInsideWindow();
  });

  // Opening the menu hides the bubble; it comes back on the next hover/focus
  // rather than popping up again the instant the menu closes.
  $effect(() => {
    if (suppressed) hide();
  });

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function showAfterDelay(): void {
    if (!label || suppressed || controlExpanded()) return;
    clearTimer();
    timer = setTimeout(() => {
      open = !controlExpanded();
      timer = null;
    }, delay);
  }

  /** Focus is intentional — no dwell delay. */
  function showNow(): void {
    if (!label || suppressed || controlExpanded()) return;
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
  bind:this={wrap}
  onpointerenter={showAfterDelay}
  onpointerdown={hide}
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
      class:align-start={align === "start"}
      class:align-end={align === "end"}
      class:side-right={side === "right"}
      style={shift === 0 ? undefined : `--tooltip-nudge: ${shift}px`}
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
    /* `--tooltip-base` is the alignment offset; `--tooltip-nudge` is set only
       when a window edge forces the bubble off its preferred placement. */
    --tooltip-base: -50%;
    transform: translateX(
      calc(var(--tooltip-base) + var(--tooltip-nudge, 0px))
    );
    z-index: 10001;
    max-width: 220px;
    padding: 4px 8px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 6px;
    background: var(--overlay-bg);
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
    --tooltip-base: 0px;
  }

  .tooltip-bubble.align-end {
    left: auto;
    right: 0;
    --tooltip-base: 0px;
  }

  .tooltip-bubble.side-right {
    top: 50%;
    left: calc(100% + 8px);
    right: auto;
    transform: translateY(-50%);
    animation-name: tooltip-in-right;
  }

  @keyframes tooltip-in-right {
    from {
      opacity: 0;
      transform: translateY(-50%) translateX(-2px);
    }
  }

  @keyframes tooltip-in {
    from {
      opacity: 0;
      transform: translateX(
          calc(var(--tooltip-base) + var(--tooltip-nudge, 0px))
        )
        translateY(-2px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .tooltip-bubble {
      animation: none;
    }
  }
</style>
