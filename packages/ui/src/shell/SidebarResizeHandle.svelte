<script lang="ts">
  import { onDestroy } from 'svelte';
  let { width = $bindable(260) }: { width?: number } = $props();
  let dragging = $state(false);
  let stop = () => {};
  const clamp = (value: number) => Math.max(220, Math.min(440, value));
  function save() { try { localStorage.setItem('hq.sidebar.width', String(width)); } catch {} }
  function begin(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    stop();
    const start = event.clientX;
    const initial = width;
    const scale = event.currentTarget instanceof HTMLElement
      ? event.currentTarget.getBoundingClientRect().width / event.currentTarget.offsetWidth : 1;
    dragging = true;
    const move = (next: PointerEvent) => {
      if (next.pointerId === event.pointerId) width = clamp(initial + (next.clientX - start) / (scale || 1));
    };
    const finish = (next: PointerEvent) => { if (next.pointerId === event.pointerId) { stop(); save(); } };
    stop = () => {
      dragging = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }
  function key(event: KeyboardEvent) {
    const next = event.key === 'ArrowLeft' ? width - 10 : event.key === 'ArrowRight' ? width + 10 : event.key === 'Home' ? 220 : event.key === 'End' ? 440 : null;
    if (next === null) return;
    event.preventDefault(); width = clamp(next); save();
  }
  onDestroy(() => stop());
</script>

<div class="resize-handle" class:dragging role="separator" aria-label="Resize sidebar"
  aria-orientation="vertical" aria-valuemin={220} aria-valuemax={440} aria-valuenow={width}
  tabindex="0" onpointerdown={begin} onkeydown={key}
  ondblclick={() => { width = 260; save(); }}></div>

<style>
  .resize-handle { flex: 0 0 6px; width: 6px; margin-left: -3px; margin-right: -3px; z-index: 10; cursor: col-resize; touch-action: none; }
  .resize-handle:hover, .resize-handle:focus-visible, .dragging { background: var(--line); outline: none; }
</style>
