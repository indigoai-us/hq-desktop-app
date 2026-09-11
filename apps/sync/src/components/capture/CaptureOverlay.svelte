<script lang="ts" module>
  /** Events emitted by src-tauri/src/commands/capture.rs. */
  export const EVENT_SHOWN = 'capture-overlay:shown';
  export const EVENT_HIDDEN = 'capture-overlay:hidden';

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

  /** Cursor position in the display's physical pixel space (for the readout). */
  const readout = $derived.by(() => {
    if (!pointer) return null;
    const scale = display?.scale ?? window.devicePixelRatio ?? 1;
    return { x: Math.round(pointer.x * scale), y: Math.round(pointer.y * scale) };
  });

  function hasTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  function onShown(payload: { display: OverlayDisplay | null }) {
    display = payload?.display ?? null;
    pointer = null;
    visible = true;
  }

  function onHidden() {
    visible = false;
    pointer = null;
  }

  function onPointerMove(e: MouseEvent) {
    pointer = { x: e.clientX, y: e.clientY };
  }

  function onPointerLeave() {
    pointer = null;
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

<svelte:window onkeydown={onKeyDown} />

<div
  class="overlay"
  class:visible
  data-testid="capture-overlay"
  data-visible={visible ? 'true' : 'false'}
  role="presentation"
  onmousemove={onPointerMove}
  onmouseleave={onPointerLeave}
>
  {#if pointer}
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
  <div class="hint" data-testid="capture-hint">
    Drag to capture <span class="sep">·</span> Esc to cancel
  </div>
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
