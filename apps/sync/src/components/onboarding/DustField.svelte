<script lang="ts">
  /**
   * Slow-drifting dust motes over the colour field: a cheap 2D canvas layer
   * that gives the frame depth and makes the god rays read as light in air.
   */
  import { onDestroy, onMount } from 'svelte';

  interface Props { still?: boolean; count?: number; }
  let { still = false, count = 90 }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;

  interface Mote { x: number; y: number; r: number; vx: number; vy: number; ph: number; sp: number; a: number; }
  let motes: Mote[] = [];

  function seed(w: number, h: number) {
    motes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.6 + Math.random() * 1.8,
      vx: (Math.random() - 0.5) * 0.12,
      vy: -(0.04 + Math.random() * 0.16),
      ph: Math.random() * Math.PI * 2,
      sp: 0.4 + Math.random() * 0.9,
      a: 0.25 + Math.random() * 0.55,
    }));
  }

  let last = 0;
  function frame(now: number) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (motes.length === 0) seed(w, h);
    }
    const dt = last ? Math.min(50, now - last) / 16.67 : 1;
    last = now;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const m of motes) {
      if (!still) {
        m.x += m.vx * dt + Math.sin(m.ph + now * 0.0004 * m.sp) * 0.08;
        m.y += m.vy * dt;
        if (m.y < -4) { m.y = h + 4; m.x = Math.random() * w; }
        if (m.x < -4) m.x = w + 4; else if (m.x > w + 4) m.x = -4;
      }
      const tw = 0.6 + 0.4 * Math.sin(m.ph + now * 0.0012 * m.sp);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${(m.a * tw).toFixed(3)})`;
      ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }

  onMount(() => { raf = requestAnimationFrame(frame); });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });
</script>

<canvas bind:this={canvas} class="dust" aria-hidden="true"></canvas>

<style>
  .dust { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; mix-blend-mode: screen; opacity: 0.85; }
</style>
