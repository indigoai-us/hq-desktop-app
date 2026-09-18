<script lang="ts">
  /**
   * Cinema dust over the colour field: a few large, very soft bokeh orbs and
   * a cloud of fine motes, all drawn as radial-gradient sprites so nothing has
   * a hard edge. They drift up slowly, twinkle, and lean toward the cursor.
   */
  import { onDestroy, onMount } from 'svelte';

  interface Props { still?: boolean; }
  let { still = false }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;

  interface Mote { x: number; y: number; r: number; vx: number; vy: number; ph: number; sp: number; a: number; big: boolean; }
  let motes: Mote[] = [];
  const mouse = { x: 0.5, y: 0.5 };
  const mouseEased = { x: 0.5, y: 0.5 };

  function seed(w: number, h: number) {
    const bokeh: Mote[] = Array.from({ length: 26 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 10 + Math.random() * 34,
      vx: (Math.random() - 0.5) * 0.06, vy: -(0.02 + Math.random() * 0.06),
      ph: Math.random() * Math.PI * 2, sp: 0.3 + Math.random() * 0.5,
      a: 0.035 + Math.random() * 0.07, big: true,
    }));
    const fine: Mote[] = Array.from({ length: 160 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 0.9 + Math.random() * 2.4,
      vx: (Math.random() - 0.5) * 0.14, vy: -(0.05 + Math.random() * 0.2),
      ph: Math.random() * Math.PI * 2, sp: 0.5 + Math.random() * 1.1,
      a: 0.12 + Math.random() * 0.4, big: false,
    }));
    motes = [...bokeh, ...fine];
  }

  // One soft sprite, cached, scaled per mote — a radial falloff to zero so
  // even the smallest mote is a glow, not a dot.
  let sprite: HTMLCanvasElement | null = null;
  function makeSprite() {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (!g) return c;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  function onPointer(event: PointerEvent) {
    mouse.x = event.clientX / (window.innerWidth || 1);
    mouse.y = event.clientY / (window.innerHeight || 1);
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
    if (!sprite) sprite = makeSprite();
    const dt = last ? Math.min(50, now - last) / 16.67 : 1;
    last = now;
    mouseEased.x += (mouse.x - mouseEased.x) * 0.03;
    mouseEased.y += (mouse.y - mouseEased.y) * 0.03;
    const gx = (mouseEased.x - 0.5) * w;
    const gy = (mouseEased.y - 0.5) * h;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    for (const m of motes) {
      if (!still) {
        // Base drift + sway, then a faint pull toward the cursor that is
        // stronger for the light, fine motes than the heavy bokeh.
        const pull = m.big ? 0.0006 : 0.0018;
        m.x += m.vx * dt + Math.sin(m.ph + now * 0.0004 * m.sp) * 0.09 + (gx + w / 2 - m.x) * pull * dt;
        m.y += m.vy * dt + Math.cos(m.ph + now * 0.0003 * m.sp) * 0.05 + (gy + h / 2 - m.y) * pull * 0.5 * dt;
        if (m.y < -m.r * 2) { m.y = h + m.r * 2; m.x = Math.random() * w; }
        if (m.x < -m.r * 2) m.x = w + m.r * 2; else if (m.x > w + m.r * 2) m.x = -m.r * 2;
      }
      const tw = 0.55 + 0.45 * Math.sin(m.ph + now * 0.0011 * m.sp);
      ctx.globalAlpha = m.a * tw;
      const d = m.r * 2 * (m.big ? 1.9 : 3.2);
      ctx.drawImage(sprite, m.x - d / 2, m.y - d / 2, d, d);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    raf = requestAnimationFrame(frame);
  }

  onMount(() => {
    raf = requestAnimationFrame(frame);
    window.addEventListener('pointermove', onPointer, { passive: true });
  });
  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onPointer);
  });
</script>

<canvas bind:this={canvas} class="dust" aria-hidden="true"></canvas>

<style>
  .dust { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
</style>
