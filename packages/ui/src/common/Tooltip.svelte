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
    /** Which side of the trigger the bubble opens on. The app rail uses right. */
    side?: "bottom" | "right";
    /** The control this tooltip describes. Receives the tooltip element id. */
    trigger: Snippet<[string]>;
  }

  let {
    label = null,
    delay = 400,
    align = "center",
    side = "bottom",
    trigger,
  }: Props = $props();

  const id = `tooltip-${Math.random().toString(36).slice(2, 10)}`;
  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wrap: HTMLSpanElement | null = $state(null);
  let bubbleEl = $state<HTMLElement | null>(null);
  /** px to move a centred bubble so it stays inside the window. */
  let edgeShift = $state(0);

  /**
   * A centred bubble that would run off a window edge does NOT just slide as
   * far as it has to: it aligns with the TRIGGER's edge (right to right near
   * the right of the window, left to left near the left). A bubble nudged
   * just enough to fit reads as accidentally off-centre; one flush with its
   * button reads as deliberate. The 8px window margin is a backstop for a
   * bubble wider than the room beside its trigger. Only the default centred,
   * below-the-trigger bubble moves; `align` and `side` are explicit choices.
   */
  function keepInsideWindow(): void {
    const el = bubbleEl;
    edgeShift = 0;
    if (!el || !wrap || typeof window === "undefined") return;
    if (align !== "center" || side !== "bottom") return;
    const margin = 8;
    const width = el.getBoundingClientRect().width;
    const trigger = wrap.getBoundingClientRect();
    const viewport = window.innerWidth;
    const centredLeft = trigger.left + trigger.width / 2 - width / 2;

    let left = centredLeft;
    if (centredLeft + width > viewport - margin) left = trigger.right - width;
    else if (centredLeft < margin) left = trigger.left;

    const maxLeft = viewport - margin - width;
    if (left > maxLeft) left = maxLeft;
    if (left < margin) left = margin;
    edgeShift = left - centredLeft;
  }

  $effect(() => {
    if (!open) {
      edgeShift = 0;
      return;
    }
    void bubbleEl;
    keepInsideWindow();
  });

  /** A control whose menu or popover is open must not keep its tooltip on
   *  top of that menu (the Launch tooltip sat over the open Launch menu). */
  function controlExpanded(): boolean {
    return wrap?.querySelector('[aria-expanded="true"]') != null;
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function showAfterDelay(): void {
    if (!label || controlExpanded()) return;
    clearTimer();
    timer = setTimeout(() => {
      open = !controlExpanded();
      timer = null;
    }, delay);
  }

  /** Focus is intentional — no dwell delay. */
  function showNow(): void {
    if (!label || controlExpanded()) return;
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
  {@render trigger(label ? id : "")}
  {#if open && label}
    <span
      bind:this={bubbleEl}
      class="tooltip-bubble"
      class:align-start={align === "start"}
      class:align-end={align === "end"}
      class:side-right={side === "right"}
      style={edgeShift === 0 ? undefined : `--tooltip-x: ${edgeShift}px`}
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
    /* `--tooltip-x` is set only when a window edge would clip the bubble. */
    transform: translateX(calc(-50% + var(--tooltip-x, 0px)));
    z-index: 10001;
    /* Short labels stay on one line; a long one wraps inside the bubble instead of running past it. */
    width: max-content;
    max-width: 260px;
    padding: 4px 8px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 6px;
    background: var(--overlay-bg);
    box-shadow: var(--panel-shadow, 0 4px 12px rgba(0, 0, 0, 0.22));
    color: var(--t1);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.35;
    white-space: normal;
    overflow-wrap: break-word;
    text-wrap: pretty;
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
      transform: translateX(calc(var(--tooltip-shift, -50%) + var(--tooltip-x, 0px)))
        translateY(-2px);
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
