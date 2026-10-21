<script lang="ts">
  /**
   * Inline photo crop editor: the whole photo with everything outside the
   * round crop dimmed, drag to move, a zoom slider (scroll also zooms). It
   * lives inside the settings row that opened it — no dialog. The row's own
   * avatar shows the result live through `onchange`.
   */
  import {
    CENTER_CROP,
    MAX_ZOOM,
    clampCrop,
    cropView,
    panCrop,
    type PhotoCrop,
    type PhotoSource,
  } from "./profile-photo.js";

  interface Props {
    source: PhotoSource;
    crop?: PhotoCrop;
    busy?: boolean;
    ondone: (crop: PhotoCrop) => void;
    oncancel: () => void;
    /** Called with the crop as it changes, for a live preview elsewhere. */
    onchange?: (crop: PhotoCrop) => void;
  }

  let { source, crop = CENTER_CROP, busy = false, ondone, oncancel, onchange }: Props = $props();

  const STAGE = 184;
  const WINDOW = 144;

  // svelte-ignore state_referenced_locally
  let draft = $state<PhotoCrop>(clampCrop(source.width, source.height, crop));
  let stage = $state<HTMLDivElement | null>(null);

  const view = $derived(cropView(source, draft, WINDOW));

  function setZoom(zoom: number): void {
    draft = clampCrop(source.width, source.height, { ...draft, zoom });
  }

  // WKWebView drops pointer capture on fast drags, so track the drag with
  // window listeners that live only for its duration.
  function startDrag(event: PointerEvent): void {
    if (busy || event.button !== 0) return;
    event.preventDefault();
    let lastX = event.clientX;
    let lastY = event.clientY;
    const move = (e: PointerEvent) => {
      draft = panCrop(source, draft, e.clientX - lastX, e.clientY - lastY, WINDOW);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    setZoom(draft.zoom - event.deltaY * 0.002);
  }

  function onKeydown(event: KeyboardEvent): void {
    const step: Record<string, [number, number]> = {
      ArrowLeft: [-4, 0],
      ArrowRight: [4, 0],
      ArrowUp: [0, -4],
      ArrowDown: [0, 4],
    };
    const d = step[event.key];
    if (d) {
      event.preventDefault();
      draft = panCrop(source, draft, d[0], d[1], WINDOW);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (!busy) ondone(draft);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      oncancel();
    }
  }

  $effect(() => {
    stage?.focus({ preventScroll: true });
  });

  $effect(() => {
    onchange?.(draft);
  });

  function imgStyle(): string {
    const v = view;
    return `width:${v.width}px;height:${v.height}px;transform:translate(calc(-50% + ${v.dx}px), calc(-50% + ${v.dy}px));`;
  }
</script>

<div class="crop" data-testid="photo-crop-editor">
  <!-- The stage is a direct-manipulation surface: drag, wheel and arrow keys. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div
    class="stage"
    bind:this={stage}
    role="application"
    tabindex="0"
    aria-label="Photo crop. Drag or use arrow keys to move, scroll to zoom, Enter to save, Escape to cancel."
    data-testid="photo-crop-stage"
    style={`--stage:${STAGE}px;--window:${WINDOW}px`}
    onpointerdown={startDrag}
    onwheel={onWheel}
    onkeydown={onKeydown}
    ondblclick={() => (draft = clampCrop(source.width, source.height, { ...draft, x: 0, y: 0 }))}
  >
    <img src={source.url} alt="" draggable="false" style={imgStyle()} />
    <span class="ring" aria-hidden="true"></span>
  </div>

  <div class="controls">
    <label class="zoom">
      <span class="sr">Zoom</span>
      <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" /></svg>
      <input
        type="range"
        min="1"
        max={MAX_ZOOM}
        step="0.01"
        value={draft.zoom}
        disabled={busy}
        data-testid="photo-crop-zoom"
        oninput={(e) => setZoom(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="4" /></svg>
    </label>

    <p class="hint">Drag to move · scroll to zoom · double-click to re-center</p>

    <div class="buttons">
      <button
        type="button"
        class="chip primary"
        data-testid="photo-crop-done"
        disabled={busy}
        onclick={() => ondone(draft)}>{busy ? "Saving…" : "Done"}</button
      >
      <button type="button" class="chip" data-testid="photo-crop-cancel" disabled={busy} onclick={oncancel}
        >Cancel</button
      >
    </div>
  </div>
</div>

<style>
  .crop {
    display: flex;
    align-items: center;
    gap: 24px;
    animation: crop-in 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
  }

  @keyframes crop-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  .stage {
    position: relative;
    flex: none;
    width: var(--stage);
    height: var(--stage);
    border-radius: 10px;
    overflow: hidden;
    background: var(--v4-raised, #161618);
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .stage:active {
    cursor: grabbing;
  }

  .stage:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, #6366f1);
    outline-offset: 3px;
  }

  .stage img {
    position: absolute;
    left: 50%;
    top: 50%;
    max-width: none;
    pointer-events: none;
  }

  .ring {
    position: absolute;
    left: 50%;
    top: 50%;
    width: var(--window);
    height: var(--window);
    margin: calc(var(--window) / -2) 0 0 calc(var(--window) / -2);
    border-radius: 50%;
    /* The spread shadow dims the photo outside the crop; the stage clips it. */
    box-shadow:
      0 0 0 1px rgb(255 255 255 / 0.5),
      0 0 0 999px rgb(10 10 10 / 0.6);
    pointer-events: none;
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 220px;
  }

  .zoom {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--v4-text-3, rgb(250 250 250 / 0.4));
  }

  .zoom svg {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .zoom input[type="range"] {
    appearance: none;
    -webkit-appearance: none;
    width: 100%;
    height: 20px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  .zoom input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 1px;
    background: var(--v4-hairline, rgb(255 255 255 / 0.14));
  }

  .zoom input[type="range"]::-webkit-slider-thumb {
    appearance: none;
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    margin-top: -6px;
    border: 1px solid var(--v4-control-border, rgb(255 255 255 / 0.2));
    border-radius: 50%;
    background: var(--v4-text-1, #fafafa);
    box-shadow: var(--v4-shadow-card, 0 1px 3px rgb(0 0 0 / 0.5));
  }

  .zoom input[type="range"]:focus-visible {
    outline: none;
  }

  .zoom input[type="range"]:focus-visible::-webkit-slider-thumb {
    outline: 1.5px solid var(--v4-focus-ring, #6366f1);
    outline-offset: 3px;
  }

  .hint {
    margin: 0;
    color: var(--v4-text-3, rgb(250 250 250 / 0.4));
    font-size: 12px;
  }

  .buttons {
    display: flex;
    gap: 8px;
  }

  .chip {
    padding: 5px 10px;
    border: 1px solid var(--line2, rgb(255 255 255 / 0.14));
    border-radius: 6px;
    background: none;
    color: var(--t2, rgb(250 250 250 / 0.6));
    font: inherit;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
  }

  .chip.primary {
    border-color: var(--v4-text-1, #fafafa);
    background: var(--v4-text-1, #fafafa);
    color: var(--v4-ground, #0a0a0a);
  }

  .chip:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .chip:focus-visible {
    outline: 1.5px solid var(--v4-focus-ring, #6366f1);
    outline-offset: 2px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .crop {
      animation: none;
    }
  }
</style>
