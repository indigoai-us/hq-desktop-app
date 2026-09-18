<script lang="ts">
  /**
   * "Your folder is local. Your team is not." drawn on a canvas.
   *
   * One 1100x460 design space, scaled to whatever box the canvas gets, so the
   * geometry is exact at every size. The scene assembles on a timeline that
   * starts the moment `active` flips true, then keeps breathing: light pulses
   * run along the wires, the hub ring turns, the dots twinkle.
   */
  import { onDestroy, onMount } from 'svelte';
  import type { SurfaceRow } from '../../lib/intro-sequence';

  interface Props { active?: boolean; still?: boolean; caps?: readonly SurfaceRow[]; }
  let { active = false, still = false, caps = [] }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let raf = 0;
  let startedAt = 0;

  // ---- geometry (design units) -------------------------------------------
  const W = 1100, H = 530;
  const YOU = { x: 110, y: 190, r: 44 };
  const HUB = { x: 550, y: 190, r: 70 };
  const TEAM_X = 880, BUS_X = 760, TEAM_Y0 = 70, TEAM_DY = 60, TEAM_N = 5, TEAM_R = 15;
  const BOT_Y = 346, BOT_X0 = 470, BOT_DX = 80, BOT_N = 3, BOT_S = 44;
  const RAIL_Y = 446, RAIL_X0 = 60, RAIL_X1 = 1040, CAP_X0 = 160, CAP_DX = 195;

  const PINK = '#e56ab3', VIOLET = '#8b6df0', CYAN = '#7de3f4', ORANGE = '#f28a4b';

  type Pt = [number, number];
  interface Wire { pts: Pt[]; at: number; dur: number; hot: boolean; }
  const wires: Wire[] = [
    { pts: [[YOU.x + YOU.r, YOU.y], [HUB.x - HUB.r - 2, HUB.y]], at: 1.15, dur: 0.7, hot: true },
    { pts: [[HUB.x + HUB.r + 2, HUB.y], [BUS_X, HUB.y]], at: 1.85, dur: 0.5, hot: false },
    { pts: [[BUS_X, TEAM_Y0], [BUS_X, TEAM_Y0 + TEAM_DY * (TEAM_N - 1)]], at: 1.95, dur: 0.6, hot: false },
    ...Array.from({ length: TEAM_N }, (_, i): Wire => ({
      pts: [[BUS_X, TEAM_Y0 + i * TEAM_DY], [TEAM_X - TEAM_R - 1, TEAM_Y0 + i * TEAM_DY]], at: 2.05 + i * 0.07, dur: 0.45, hot: false,
    })),
    { pts: [[HUB.x, HUB.y + HUB.r + 2], [HUB.x, 316]], at: 2.4, dur: 0.4, hot: true },
    { pts: [[BOT_X0, 316], [BOT_X0 + BOT_DX * (BOT_N - 1), 316]], at: 2.55, dur: 0.4, hot: true },
    ...Array.from({ length: BOT_N }, (_, i): Wire => ({
      pts: [[BOT_X0 + i * BOT_DX, 316], [BOT_X0 + i * BOT_DX, BOT_Y - BOT_S / 2]], at: 2.62 + i * 0.07, dur: 0.3, hot: true,
    })),
    { pts: [[RAIL_X0, RAIL_Y], [RAIL_X1, RAIL_Y]], at: 3.05, dur: 0.9, hot: false },
    ...Array.from({ length: 5 }, (_, i): Wire => ({
      pts: [[CAP_X0 + i * CAP_DX, RAIL_Y], [CAP_X0 + i * CAP_DX, RAIL_Y - 16]], at: 3.22 + i * 0.07, dur: 0.3, hot: false,
    })),
  ];

  // Light pulses that keep running along the main routes once assembled.
  const routes: { pts: Pt[]; color: string; period: number; offset: number }[] = [
    { pts: [[YOU.x + YOU.r, YOU.y], [HUB.x - HUB.r, HUB.y]], color: PINK, period: 2.6, offset: 0 },
    { pts: [[HUB.x + HUB.r, HUB.y], [BUS_X, HUB.y], [BUS_X, TEAM_Y0], [TEAM_X - TEAM_R, TEAM_Y0]], color: '#fff', period: 3.1, offset: 0.4 },
    { pts: [[HUB.x + HUB.r, HUB.y], [BUS_X, HUB.y], [BUS_X, TEAM_Y0 + 4 * TEAM_DY], [TEAM_X - TEAM_R, TEAM_Y0 + 4 * TEAM_DY]], color: '#fff', period: 3.1, offset: 1.6 },
    { pts: [[HUB.x, HUB.y + HUB.r], [HUB.x, 316], [BOT_X0 + BOT_DX, 316], [BOT_X0 + BOT_DX, BOT_Y - BOT_S / 2]], color: PINK, period: 2.2, offset: 0.9 },
  ];

  const easeOut = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - Math.pow(1 - t, 3));
  const prog = (t: number, at: number, dur: number) => easeOut((t - at) / dur);

  function polyLen(pts: Pt[]) {
    let l = 0;
    for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return l;
  }
  function pointAt(pts: Pt[], f: number): Pt {
    const total = polyLen(pts);
    let d = f * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d <= seg) {
        const k = seg === 0 ? 0 : d / seg;
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
      }
      d -= seg;
    }
    return pts[pts.length - 1];
  }
  function strokePartial(ctx: CanvasRenderingContext2D, pts: Pt[], f: number) {
    if (f <= 0) return;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    const total = polyLen(pts);
    let d = f * total;
    for (let i = 1; i < pts.length; i++) {
      const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (d >= seg) { ctx.lineTo(pts[i][0], pts[i][1]); d -= seg; }
      else { const k = d / seg; ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k); break; }
    }
    ctx.stroke();
  }

  function glow(ctx: CanvasRenderingContext2D, color: string, blur: number) {
    ctx.shadowColor = color; ctx.shadowBlur = blur;
  }
  function noGlow(ctx: CanvasRenderingContext2D) { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; }

  function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, alpha: number, opts: { mono?: boolean; caps?: boolean; align?: CanvasTextAlign } = {}) {
    if (alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.fillStyle = '#fff';
    ctx.textAlign = opts.align ?? 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${opts.mono ? '500' : '400'} ${size}px ${opts.mono ? "ui-monospace, 'SF Mono', Menlo, monospace" : 'Geist, -apple-system, system-ui, sans-serif'}`;
    if (opts.caps) {
      // Letter-spaced small caps, drawn char by char.
      const t = text.toUpperCase(); const sp = size * 0.18;
      const widths = [...t].map((c) => ctx.measureText(c).width);
      const total = widths.reduce((a, b) => a + b, 0) + sp * (t.length - 1);
      let cx = x - total / 2;
      ctx.textAlign = 'left';
      [...t].forEach((c, i) => { ctx.fillText(c, cx, y); cx += widths[i] + sp; });
    } else {
      ctx.fillText(text, x, y);
    }
    ctx.restore();
  }

  function draw(now: number) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    }
    const s = cw / W;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const t = still ? 99 : (now - startedAt) / 1000; // seconds since active
    const live = still ? 99 : t;

    // ---- field: a warm pool of light and a dot grid, masked to the centre --
    {
      const a = prog(t, 0.45, 0.8);
      if (a > 0) {
        ctx.save(); ctx.globalAlpha = a;
        const fg = ctx.createRadialGradient(HUB.x, 230, 0, HUB.x, 230, 620);
        fg.addColorStop(0, 'rgba(139,109,240,0.16)');
        fg.addColorStop(0.5, 'rgba(229,106,179,0.06)');
        fg.addColorStop(1, 'rgba(229,106,179,0)');
        ctx.fillStyle = fg; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        for (let gx = 30; gx < W; gx += 22) {
          for (let gy = 20; gy < RAIL_Y - 20; gy += 22) {
            const d = Math.hypot(gx - HUB.x, gy - 230) / 560;
            if (d > 1) continue;
            ctx.globalAlpha = a * (1 - d) * (1 - d);
            ctx.beginPath(); ctx.arc(gx, gy, 1.2, 0, Math.PI * 2); ctx.fill();
          }
        }
        ctx.restore();
      }
    }

    // ---- wires ----------------------------------------------------------
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const w of wires) {
      const f = prog(t, w.at, w.dur);
      if (f <= 0) continue;
      ctx.strokeStyle = w.hot ? PINK : 'rgba(255,255,255,0.55)';
      ctx.lineWidth = w.hot ? 2.4 : 2;
      if (w.hot) glow(ctx, PINK, 12); else noGlow(ctx);
      strokePartial(ctx, w.pts, f);
    }
    noGlow(ctx);

    // ---- pulses along the routes (after assembly) ------------------------
    if (t > 3.6) {
      for (const r of routes) {
        const f = ((live + r.offset) % r.period) / r.period;
        const [px, py] = pointAt(r.pts, f);
        const fade = Math.sin(f * Math.PI); // soft in/out
        ctx.save();
        ctx.globalAlpha = 0.9 * fade;
        glow(ctx, r.color, 18);
        ctx.fillStyle = r.color;
        ctx.beginPath(); ctx.arc(px, py, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // ---- you ------------------------------------------------------------
    {
      const a = prog(t, 0.95, 0.6);
      if (a > 0) {
        ctx.save(); ctx.globalAlpha = a;
        glow(ctx, PINK, 26);
        ctx.strokeStyle = PINK; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(YOU.x, YOU.y, YOU.r, 0, Math.PI * 2); ctx.stroke();
        noGlow(ctx);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath(); ctx.arc(YOU.x, YOU.y, YOU.r - 2, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(YOU.x, YOU.y, YOU.r - 6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        label(ctx, 'you', YOU.x, YOU.y + 1, 15, a);
      }
    }

    // ---- hub ------------------------------------------------------------
    {
      const a = prog(t, 0.8, 0.9);
      if (a > 0) {
        ctx.save(); ctx.globalAlpha = a;
        // Inner bloom that breathes.
        const br = HUB.r * (0.92 + 0.05 * Math.sin(live * 1.9));
        const g = ctx.createRadialGradient(HUB.x, HUB.y, 0, HUB.x, HUB.y, br);
        g.addColorStop(0, 'rgba(255,255,255,0.35)');
        g.addColorStop(0.45, 'rgba(139,109,240,0.38)');
        g.addColorStop(0.8, 'rgba(229,106,179,0.12)');
        g.addColorStop(1, 'rgba(229,106,179,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(HUB.x, HUB.y, br, 0, Math.PI * 2); ctx.fill();
        // Turning spectrum ring.
        const ang = live * 0.45;
        const cg = ctx.createConicGradient(ang, HUB.x, HUB.y);
        cg.addColorStop(0, CYAN); cg.addColorStop(0.3, VIOLET); cg.addColorStop(0.62, PINK); cg.addColorStop(0.9, ORANGE); cg.addColorStop(1, CYAN);
        ctx.strokeStyle = cg; ctx.lineWidth = 2.6;
        glow(ctx, VIOLET, 22);
        ctx.beginPath(); ctx.arc(HUB.x, HUB.y, HUB.r, 0, Math.PI * 2); ctx.stroke();
        // A brighter comet on the ring.
        const cx = HUB.x + Math.cos(ang) * HUB.r, cy = HUB.y + Math.sin(ang) * HUB.r;
        ctx.fillStyle = '#fff'; glow(ctx, '#fff', 18);
        ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        label(ctx, 'company cloud', HUB.x, HUB.y - HUB.r - 22, 12, a * 0.8, { caps: true });
      }
    }

    // ---- team -----------------------------------------------------------
    label(ctx, 'team', TEAM_X, 34, 12, prog(t, 1.3, 0.6) * 0.65, { caps: true });
    for (let i = 0; i < TEAM_N; i++) {
      const a = prog(t, 2.1 + i * 0.07, 0.5);
      if (a <= 0) continue;
      const y = TEAM_Y0 + i * TEAM_DY;
      const tw = 0.85 + 0.15 * Math.sin(live * 1.3 + i * 1.7);
      ctx.save(); ctx.globalAlpha = a * tw;
      glow(ctx, '#fff', 20);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(TEAM_X, y, TEAM_R, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // ---- agents ---------------------------------------------------------
    label(ctx, 'agents', BOT_X0 - 76, BOT_Y, 12, prog(t, 2.6, 0.6) * 0.65, { caps: true });
    for (let i = 0; i < BOT_N; i++) {
      const a = prog(t, 2.72 + i * 0.07, 0.5);
      if (a <= 0) continue;
      const x = BOT_X0 + i * BOT_DX, y = BOT_Y, h = BOT_S / 2, r = 11;
      ctx.save(); ctx.globalAlpha = a;
      glow(ctx, PINK, 18);
      ctx.strokeStyle = 'rgba(229,106,179,0.9)'; ctx.lineWidth = 1.6;
      ctx.fillStyle = 'rgba(229,106,179,0.16)';
      ctx.beginPath(); ctx.roundRect(x - h, y - h, BOT_S, BOT_S, r); ctx.fill(); ctx.stroke();
      noGlow(ctx);
      ctx.fillStyle = PINK;
      const pulse = 0.85 + 0.15 * Math.sin(live * 2.4 + i);
      ctx.beginPath(); ctx.roundRect(x - 7 * pulse, y - 7 * pulse, 14 * pulse, 14 * pulse, 3); ctx.fill();
      ctx.restore();
    }

    // ---- capability rail ------------------------------------------------
    caps.forEach((cap, i) => {
      const a = prog(t, 3.35 + i * 0.07, 0.6);
      const x = CAP_X0 + i * CAP_DX;
      label(ctx, cap.name, x, RAIL_Y + 26, 15, a, { mono: true });
      label(ctx, cap.meaning, x, RAIL_Y + 48, 12.5, a * 0.75);
    });

    raf = requestAnimationFrame(draw);
  }

  $effect(() => {
    if (active) {
      startedAt = performance.now();
      if (!raf) raf = requestAnimationFrame(draw);
    } else if (raf) {
      cancelAnimationFrame(raf); raf = 0;
    }
  });

  onMount(() => { if (active) { startedAt = performance.now(); raf = requestAnimationFrame(draw); } });
  onDestroy(() => { if (raf) cancelAnimationFrame(raf); });
</script>

<canvas bind:this={canvas} class="net" aria-hidden="true"></canvas>

<style>
  .net {
    display: block;
    flex: 0 0 auto;
    width: min(1000px, calc(100vw - 160px));
    aspect-ratio: 1100 / 530;
    margin-top: 4px;
  }
</style>
