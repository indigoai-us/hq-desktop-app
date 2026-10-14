<script lang="ts">
  // Compact emoji popover (US-025, ported from hq-sync desktop source). Renders
  // the CURATED ~24-emoji set as a grid of tap targets. Opened by an explicit
  // tap on the add-reaction trigger; closes on pick, Escape, or outside click.
  import { untrack } from "svelte";
  import { CURATED_EMOJI } from "./reactions";

  interface Props {
    onpick: (emoji: string) => void;
    onclose: () => void;
  }

  let { onpick, onclose }: Props = $props();

  let rootEl = $state<HTMLDivElement | null>(null);
  // Collision-aware placement: default opens above/left-aligned; flip when the
  // measured rect would be clipped (pane top, pane/window right edge). When
  // neither side has room for the whole grid (a short thread pane), open on the
  // roomier side and cap the height so the grid scrolls inside the picker.
  let placeBelow = $state(false);
  let alignRight = $state(false);
  let maxHeight = $state<number | null>(null);

  const CLIPPING_OVERFLOW = /(hidden|auto|scroll|clip)/;
  /** Matches the `calc(100% + 0.25rem)` offset from the trigger. */
  const GAP = 4;
  /** Breathing room kept between the picker and the clipping edge. */
  const EDGE = 8;
  /** Never collapse below one row of cells (32px + padding + border). */
  const MIN_HEIGHT = 46;

  type ClipBox = { top: number; right: number; bottom: number };

  /**
   * The message pane clips long before the window does: the add-reaction
   * trigger sits at a message's right edge inside a much wider window, so a
   * check against `window.innerWidth` never flipped and half the grid vanished
   * into the pane's `overflow: hidden`. Measure against the nearest ancestor
   * that clips its overflow (intersected with the viewport), falling back to
   * the viewport when nothing clips.
   */
  function clipBox(el: HTMLElement): ClipBox {
    const viewport = { top: 0, right: window.innerWidth, bottom: window.innerHeight };
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      if (CLIPPING_OVERFLOW.test(overflow)) {
        const r = node.getBoundingClientRect();
        return {
          top: Math.max(r.top, viewport.top),
          right: Math.min(r.right, viewport.right),
          bottom: Math.min(r.bottom, viewport.bottom),
        };
      }
      node = node.parentElement;
    }
    return viewport;
  }

  /**
   * Measured once, in the default above-left position: the picker's bottom
   * edge then sits GAP above the trigger it hangs off, and the trigger's own
   * box (the picker's containing block) gives the start of the space below.
   */
  function place(el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const box = clipBox(el);
    const natural = Math.max(rect.height, el.scrollHeight);
    const anchorTop = rect.bottom + GAP;
    const container =
      (el.offsetParent as HTMLElement | null) ?? el.parentElement;
    const anchorBottom = Math.max(
      anchorTop,
      container?.getBoundingClientRect().bottom ?? anchorTop,
    );
    const roomAbove = anchorTop - GAP - (box.top + EDGE);
    const roomBelow = box.bottom - EDGE - (anchorBottom + GAP);

    let below: boolean;
    if (roomAbove >= natural) below = false;
    else if (roomBelow >= natural) below = true;
    else below = roomBelow > roomAbove;
    placeBelow = below;

    const room = below ? roomBelow : roomAbove;
    maxHeight = room < natural ? Math.max(Math.floor(room), MIN_HEIGHT) : null;

    alignRight = rect.right > box.right - EDGE;
  }

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    untrack(() => place(el));
  });

  function onDocPointerDown(e: PointerEvent): void {
    if (rootEl && e.target instanceof Node && !rootEl.contains(e.target)) {
      onclose();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      // Consume it: the picker is the innermost layer, so an outer Escape
      // handler (reply panel, modal) must not also close on the same key.
      e.stopPropagation();
      onclose();
    }
  }

  $effect(() => {
    // Defer adding the pointer listener so the same tap that opened the picker
    // (still bubbling) doesn't immediately close it.
    const id = setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);
    document.addEventListener("keydown", onKeydown, true);
    // Focus for keyboard use without scrolling: a plain focus() scrolls the
    // nearest scroller (the message list) to reveal the picker, which jumped
    // the thread and raised the "Jump to latest" pill over message text.
    rootEl?.focus({ preventScroll: true });
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
    };
  });
</script>

<div
  class="emoji-picker"
  class:place-below={placeBelow}
  class:align-right={alignRight}
  class:capped={maxHeight !== null}
  style:max-height={maxHeight !== null ? `${maxHeight}px` : undefined}
  bind:this={rootEl}
  role="menu"
  tabindex="-1"
  aria-label="Add a reaction"
>
  {#each CURATED_EMOJI as emoji (emoji)}
    <button
      class="emoji-cell"
      type="button"
      role="menuitem"
      onclick={() => onpick(emoji)}
      aria-label={`React with ${emoji}`}
    >
      {emoji}
    </button>
  {/each}
</div>

<style>
  .emoji-picker {
    position: absolute;
    z-index: 30;
    bottom: calc(100% + 0.25rem);
    left: 0;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0.125rem;
    padding: 0.375rem;
    width: max-content;
    max-width: 13.5rem;
    border-radius: 12px;
    background: var(--overlay-bg);
    border: 1px solid var(--pop-border);
    box-shadow:
      var(--pop-shadow),
      inset 0 1px 0 var(--pop-highlight);
  }

  .emoji-picker.place-below {
    bottom: auto;
    top: calc(100% + 0.25rem);
  }

  /* Not enough room on either side: the height is capped to the space that
     exists and the grid scrolls inside the picker, never inside the pane. */
  .emoji-picker.capped {
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .emoji-picker.align-right {
    left: auto;
    right: 0;
  }

  .emoji-picker:focus {
    outline: none;
  }

  .emoji-cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem; /* 32px tap target */
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
    transition:
      background-color 0.1s ease,
      transform 0.06s ease;
  }

  .emoji-cell:focus-visible {
    background: var(--pop-hover);
    outline: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .emoji-cell:hover {
      background: var(--pop-hover);
    }
  }

  .emoji-cell:active {
    transform: scale(0.9);
  }

  @media (prefers-reduced-motion: reduce) {
    .emoji-cell {
      transition: none;
    }

    .emoji-cell:active {
      transform: none;
    }
  }
</style>
