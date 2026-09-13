<script lang="ts" module>
  /** Events emitted by src-tauri/src/commands/capture.rs. */
  export const EVENT_SHOWN = 'capture-overlay:shown';
  export const EVENT_HIDDEN = 'capture-overlay:hidden';

  /** Normalized selection handed to `capture_region_release` (logical CSS px). */
  export interface SelectionRect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  export interface OverlayDisplay {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }
</script>

<script lang="ts">
  /**
   * Idea-board capture overlay (hq-idea-board US-003).
   *
   * Renders inside the pre-rendered, hidden `capture-overlay` Tauri window
   * (see src-tauri/src/commands/capture.rs). The Rust side owns show/hide,
   * display placement, the global chord and the transient Escape binding; this
   * component only paints the dim layer, a crosshair with a live pixel readout,
   * and the hint line. It resets its state on `capture-overlay:shown` /
   * `capture-overlay:hidden`.
   *
   * Design lock: the window is NON-ACTIVATING (`focusable: false`) so the
   * user's app keeps focus. Per repo policy
   * `hq-desktop-app-nonactivating-window-toggle-focusable-for-input` no text
   * input may live here — the capture toast (US-005) is a separate window.
   *
   * Mountable with zero Tauri APIs (happy-dom tests). Listeners and invokes
   * only run when `__TAURI_INTERNALS__` is present. Tauri listeners tear down
   * through `safeUnlisten` (HQ-DESKTOP-39 shared teardown boundary).
   */
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { safeUnlisten } from '../../lib/listener-registry';

  let visible = $state(false);
  let display = $state<OverlayDisplay | null>(null);
  let pointer = $state<{ x: number; y: number } | null>(null);
  /** Drag anchor (mousedown point) in overlay-logical px; null when idle. */
  let anchor = $state<{ x: number; y: number } | null>(null);
  /** Live drag end point; null until the first mousemove after mousedown. */
  let dragEnd = $state<{ x: number; y: number } | null>(null);

  /**
   * The normalized selection in the overlay window's own logical CSS px —
   * exactly the shape `capture_region_release` expects (negative drags are
   * normalized here so width/height are always >= 0).
   */
  const selection = $derived.by<SelectionRect | null>(() => {
    if (!anchor) return null;
    const end = dragEnd ?? anchor;
    return {
      x: Math.round(Math.min(anchor.x, end.x)),
      y: Math.round(Math.min(anchor.y, end.y)),
      width: Math.round(Math.abs(end.x - anchor.x)),
      height: Math.round(Math.abs(end.y - anchor.y)),
    };
  });

  /** Selection size in the display's physical px (same convention as readout). */
  const selectionPhysical = $derived.by(() => {
    if (!selection) return null;
    const scale = display?.scale ?? window.devicePixelRatio ?? 1;
    return {
      w: Math.round(selection.width * scale),
      h: Math.round(selection.height * scale),
    };
  });

  /** Cursor position in the display's physical pixel space (for the readout). */
  const readout = $derived.by(() => {
    if (!pointer) return null;
    const scale = display?.scale ?? window.devicePixelRatio ?? 1;
    return { x: Math.round(pointer.x * scale), y: Math.round(pointer.y * scale) };
  });

  function hasTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  function resetDrag() {
    anchor = null;
    dragEnd = null;
  }

  function onShown(payload: { display: OverlayDisplay | null }) {
    display = payload?.display ?? null;
    pointer = null;
    resetDrag();
    visible = true;
  }

  function onHidden() {
    visible = false;
    pointer = null;
    resetDrag();
  }

  function onPointerMove(e: MouseEvent) {
    pointer = { x: e.clientX, y: e.clientY };
    if (anchor) dragEnd = { x: e.clientX, y: e.clientY };
  }

  function onPointerLeave() {
    // Mid-drag the pointer legitimately leaves the element; clearing it there
    // would drop the readout and, historically, the drag with it.
    if (anchor) return;
    pointer = null;
  }

  /**
   * LIVE-CAPTURE FIX (BUG 1): capture the pointer on mousedown.
   *
   * The move/up handlers used to live ONLY on the overlay `<div>`. The moment
   * the drag was interrupted — on macOS the click was activating HQ and
   * raising its other windows over the overlay (BUG 2) — the subsequent
   * `mousemove`/`mouseup` no longer had the overlay as their target, `dragEnd`
   * never advanced past `anchor`, and the release shipped a 0x0 rect that Rust
   * logged as `release_rejected reason=empty`. Exactly what the owner saw.
   *
   * Once a drag starts, the gesture belongs to the overlay: pointer capture
   * (bound on `pointerdown`, which is the only event that carries a
   * `pointerId`) plus window-level move/up listeners mean the rect forms even
   * if the events stop landing on the element itself. Both `pointerdown` and
   * `mousedown` route here; setting the same anchor twice is a no-op.
   */
  function onPointerDown(e: MouseEvent) {
    // Right-click (and any non-primary button) is ignored entirely.
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target as (Element & { setPointerCapture?: (id: number) => void }) | null;
    const pointerId = (e as MouseEvent & { pointerId?: number }).pointerId;
    if (target?.setPointerCapture && typeof pointerId === 'number') {
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Capture is an optimization; the window listeners are the guarantee.
      }
    }
    anchor = { x: e.clientX, y: e.clientY };
    dragEnd = { x: e.clientX, y: e.clientY };
  }

  /** Window-level move: only meaningful while a drag is live. */
  function onWindowPointerMove(e: MouseEvent) {
    if (!anchor) return;
    pointer = { x: e.clientX, y: e.clientY };
    dragEnd = { x: e.clientX, y: e.clientY };
  }

  /** Window-level release: finishes a drag that wandered off the element. */
  function onWindowPointerUp(e: MouseEvent) {
    if (!anchor) return;
    onPointerUp(e);
  }

  /**
   * Release: freeze the rect, hide locally so the overlay feels instant, then
   * hand the selection to Rust. Rust owns the real window hide (reason=release,
   * or reason=click when it rejects a degenerate rect), so we deliberately do
   * NOT also call `dismiss_capture_overlay` here. A click with no movement is
   * still invoked — the backend contract is to let Rust reject width/height < 1.
   */
  function onPointerUp(e: MouseEvent) {
    if (e.button !== 0) return;
    if (!anchor) return; // mouseup with no active drag: nothing to do.
    const rect = selection;
    visible = false;
    pointer = null;
    resetDrag();
    if (rect && hasTauri()) {
      void invoke('capture_region_release', { selection: rect }).catch(() => {});
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    // The window is non-focusable so this rarely fires; Escape is normally
    // delivered by the Rust-side global binding. Kept as a belt-and-braces
    // path for the rare case key events do reach the webview.
    if (e.key === 'Escape') {
      e.preventDefault();
      dismiss();
    }
  }

  function dismiss() {
    onHidden();
    if (hasTauri()) {
      void invoke('dismiss_capture_overlay').catch(() => {});
    }
  }

  onMount(() => {
    if (!hasTauri()) return;
    let unlistenShown: UnlistenFn | undefined;
    let unlistenHidden: UnlistenFn | undefined;
    void listen<{ display: OverlayDisplay | null }>(EVENT_SHOWN, (ev) => onShown(ev.payload)).then(
      (fn) => {
        unlistenShown = safeUnlisten(fn);
      },
    );
    void listen(EVENT_HIDDEN, () => onHidden()).then((fn) => {
      unlistenHidden = safeUnlisten(fn);
    });
    void invoke('capture_overlay_ready').catch(() => {});
    return () => {
      safeUnlisten(unlistenShown)();
      safeUnlisten(unlistenHidden)();
    };
  });
</script>

<svelte:window
  onkeydown={onKeyDown}
  onmousemove={onWindowPointerMove}
  onmouseup={onWindowPointerUp}
/>

<div
  class="overlay"
  class:visible
  data-testid="capture-overlay"
  data-visible={visible ? 'true' : 'false'}
  role="presentation"
  class:dragging={selection !== null}
  onmousemove={onPointerMove}
  onmouseleave={onPointerLeave}
  onpointerdown={onPointerDown}
  onmousedown={onPointerDown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#if selection}
    <!-- Four dim panes keep the outside at the exact idle alpha while the
         selection itself stays perfectly clear. -->
    <div class="dim" style:left="0" style:top="0" style:right="0" style:height="{selection.y}px"></div>
    <div
      class="dim"
      style:left="0"
      style:top="{selection.y}px"
      style:width="{selection.x}px"
      style:height="{selection.height}px"
    ></div>
    <div
      class="dim"
      style:left="{selection.x + selection.width}px"
      style:top="{selection.y}px"
      style:right="0"
      style:height="{selection.height}px"
    ></div>
    <div
      class="dim"
      style:left="0"
      style:top="{selection.y + selection.height}px"
      style:right="0"
      style:bottom="0"
    ></div>
    <div
      class="selection"
      data-testid="capture-selection"
      data-w={selectionPhysical?.w ?? 0}
      data-h={selectionPhysical?.h ?? 0}
      style:left="{selection.x}px"
      style:top="{selection.y}px"
      style:width="{selection.width}px"
      style:height="{selection.height}px"
    ></div>
    {#if selectionPhysical}
      <div
        class="dimensions"
        data-testid="capture-dimensions"
        style:left="{selection.x + selection.width}px"
        style:top="{selection.y + selection.height}px"
      >
        {selectionPhysical.w} × {selectionPhysical.h}
      </div>
    {/if}
  {:else if pointer}
    <div class="crosshair-v" style:left="{pointer.x}px"></div>
    <div class="crosshair-h" style:top="{pointer.y}px"></div>
    {#if readout}
      <div
        class="readout"
        data-testid="capture-readout"
        style:left="{pointer.x + 14}px"
        style:top="{pointer.y + 14}px"
      >
        {readout.x}, {readout.y}
      </div>
    {/if}
  {/if}
  {#if !selection}
    <div class="hint" data-testid="capture-hint">
      Drag to capture <span class="sep">·</span> Esc to cancel
    </div>
  {/if}
</div>

<style>
  :global(html[data-window='capture-overlay']),
  :global(html[data-window='capture-overlay'] body) {
    margin: 0;
    background: transparent !important;
    overflow: hidden;
    cursor: crosshair;
    user-select: none;
    -webkit-user-select: none;
  }

  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    cursor: crosshair;
    /* Pre-rendered: the window is hidden until shown from Rust. No entrance
       transition — the 80ms budget leaves no room for one. */
    opacity: 1;
  }

  /* While dragging, the base dim is dropped and reproduced by four panes at
     the identical alpha, leaving the selection itself clear. */
  .overlay.dragging {
    background: transparent;
  }

  .dim {
    position: absolute;
    pointer-events: none;
    background: rgba(0, 0, 0, 0.35);
  }

  .selection {
    position: absolute;
    pointer-events: none;
    border: 1px solid rgba(255, 255, 255, 0.9);
    box-sizing: border-box;
  }

  .dimensions {
    position: absolute;
    pointer-events: none;
    /* Clamp inside the window: the label hangs off the bottom-right corner but
       is pulled back in when the selection reaches an edge. */
    transform: translate(-100%, -100%);
    margin: -6px 0 0 -6px;
    max-width: 100%;
    font:
      500 11px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    color: #fff;
    background: rgba(0, 0, 0, 0.6);
    padding: 4px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .crosshair-v,
  .crosshair-h {
    position: absolute;
    pointer-events: none;
    background: rgba(255, 255, 255, 0.75);
  }
  .crosshair-v {
    top: 0;
    bottom: 0;
    width: 1px;
  }
  .crosshair-h {
    left: 0;
    right: 0;
    height: 1px;
  }

  .readout {
    position: absolute;
    pointer-events: none;
    font:
      500 11px/1 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    color: #fff;
    background: rgba(0, 0, 0, 0.6);
    padding: 4px 6px;
    border-radius: 4px;
    white-space: nowrap;
  }

  .hint {
    position: absolute;
    left: 50%;
    top: 24px;
    transform: translateX(-50%);
    pointer-events: none;
    font:
      500 13px/1.2 -apple-system,
      BlinkMacSystemFont,
      'Segoe UI',
      sans-serif;
    color: rgba(255, 255, 255, 0.9);
    background: rgba(0, 0, 0, 0.55);
    padding: 8px 12px;
    border-radius: 8px;
  }
  .sep {
    opacity: 0.6;
    margin: 0 4px;
  }
</style>
