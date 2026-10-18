import type { ShortcutKeyboardLayout } from '../../../lib/onboarding-platform';

/**
 * The welcome flow's motion, ported from the designer prototype
 * (`workspace/prototypes/hq-welcome-flow/index.html`). Each screen is a small
 * engine the controller drives: `size` lays the screen out from the live
 * window size, `enter` starts its timeline, `frame` runs it, `skip`
 * fast-forwards to the settled frame.
 *
 * Timings, easing curves, particle counts and layout constants are the
 * prototype's, unchanged. What differs is plumbing only: the engines take
 * element refs from Svelte instead of querying the page, the forward button's
 * arrival is a callback (`reveal`) so Svelte owns its state, and every canvas
 * guards a missing 2D context (test environments, a GPU that refuses one).
 */

export interface SceneEngine {
  size(): void;
  enter(now: number): void;
  frame(now: number): void;
  skip(): void;
  exit?(): void;
  destroy?(): void;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function ease(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

function rnd(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function dpr(): number {
  return Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
}

function vw(): number {
  return typeof innerWidth === 'number' ? innerWidth : 800;
}

function vh(): number {
  return typeof innerHeight === 'number' ? innerHeight : 900;
}

function context2d(canvas: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!canvas) return null;
  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}

/**
 * Where a screen's title starts while its block is laid out. Each screen then
 * moves its whole block (title, content, button) down with `centreShift` so
 * it sits in the middle of the window, however tall the window is.
 */
function copyTop(height = vh()): number {
  return Math.max(56, Math.round(height * 0.13));
}

/**
 * How far to move a block laid out from `top` down to `bottom` so it sits
 * centred in the window, never pushing its bottom past `limit` (the room kept
 * for Back / the install card, or the skyline's band).
 */
function centreShift(top: number, bottom: number, limit: number, height = vh()): number {
  const want = Math.max(56, Math.round((height - (bottom - top)) / 2)) - top;
  return Math.max(0, Math.min(want, limit - bottom));
}

/**
 * Content under the title keeps a near-fixed gap: on a tall window it may
 * drift down by at most `extra`, and the rest of the spare room goes below.
 */
function placeUnder(top: number, bottom: number, blockH: number, extra: number): number {
  return Math.round(top + Math.min(extra, Math.max(0, (bottom - top - blockH) / 2)));
}

/** The forward button sits right under each screen's content. */
const NAVH = 44;
const NAVGAP = 44;
/** Room kept above the bottom edge (Back / the install card). */
const FLOOR = 64;
/** Scene cross-fade, matching `.scene` opacity .7s. */
export const FADE_MS = 700;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

const EMPTY_BOX: Box = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };

function rect(el: Element | null | undefined): Box {
  return el ? el.getBoundingClientRect() : EMPTY_BOX;
}

function placeNav(nav: HTMLElement | null | undefined, top: number): void {
  if (nav) nav.style.top = `${Math.round(top)}px`;
}

type Beat = [number, () => void];

function runBeats(beats: Beat[], t: number): void {
  while (beats.length && t >= beats[0]![0]) beats.shift()![1]();
}

function flushBeats(beats: Beat[]): void {
  while (beats.length) beats.shift()![1]();
}

// ---------------------------------------------------------------------------
// Pointer: the mark's particles and the skyline react to the cursor.
// ---------------------------------------------------------------------------

const pointer = { x: -9999, y: -9999, lastMove: -1e9 };

export function trackPointer(target: Window = window): () => void {
  const onMove = (event: MouseEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.lastMove = performance.now();
  };
  target.addEventListener('mousemove', onMove);
  return () => target.removeEventListener('mousemove', onMove);
}

// ---------------------------------------------------------------------------
// Scene 0 - welcome. The constellation resolves into the mark, the greeting
// lands, and sign-in arrives under it.
// ---------------------------------------------------------------------------

export const HQ_MARK_H =
  'M85.7251 3.66162H118.034V154.434H85.7251V89.8176H32.3085V154.434H0V3.66162H32.3085V57.5091H85.7251V3.66162Z';
export const HQ_MARK_Q =
  'M257.169 160.035L241.014 144.096C235.343 147.973 229.096 150.988 222.276 153.142C215.527 155.296 208.419 156.373 200.952 156.373C190.757 156.373 181.172 154.363 172.197 150.342C163.223 146.25 155.325 140.65 148.505 133.542C141.684 126.362 136.335 118.07 132.458 108.664C128.581 99.187 126.642 89.0278 126.642 78.1865C126.642 67.417 128.581 57.3296 132.458 47.9242C136.335 38.4471 141.684 30.1187 148.505 22.939C155.325 15.7593 163.223 10.1592 172.197 6.1386C181.172 2.0462 190.757 0 200.952 0C211.219 0 220.84 2.0462 229.814 6.1386C238.789 10.1592 246.686 15.7593 253.507 22.939C260.328 30.1187 265.641 38.4471 269.446 47.9242C273.323 57.3296 275.261 67.417 275.261 78.1865C275.261 86.0123 274.184 93.5151 272.031 100.695C269.948 107.803 267.077 114.444 263.415 120.618L280 137.203L257.169 160.035ZM200.952 124.065C203.896 124.065 206.732 123.741 209.46 123.095C212.26 122.449 214.952 121.552 217.537 120.403L208.491 111.357L231.322 88.5252L239.291 96.4946C240.512 93.6946 241.409 90.7509 241.984 87.6637C242.63 84.5764 242.953 81.4173 242.953 78.1865C242.953 71.8684 241.84 65.9452 239.614 60.4168C237.461 54.8885 234.445 50.0422 230.568 45.878C226.691 41.642 222.204 38.3394 217.106 35.9701C212.08 33.529 206.696 32.3085 200.952 32.3085C195.208 32.3085 189.788 33.529 184.69 35.9701C179.664 38.3394 175.213 41.642 171.336 45.878C167.459 50.0422 164.407 54.8885 162.182 60.4168C160.028 65.9452 158.951 71.8684 158.951 78.1865C158.951 84.5046 160.028 90.4637 162.182 96.0639C164.407 101.592 167.459 106.474 171.336 110.71C175.213 114.875 179.664 118.141 184.69 120.511C189.788 122.88 195.208 124.065 200.952 124.065Z';

export interface MarkRefs {
  canvas: HTMLCanvasElement;
  cap: HTMLElement;
  signin: HTMLElement;
  /** The replay's Next button; the first-run screen goes forward by signing in. */
  nav: HTMLElement | null;
}

export function createMarkEngine(
  refs: MarkRefs,
  options: { replay: boolean; onSettle: () => void },
): SceneEngine {
  const { canvas: cv, cap, signin } = refs;
  const ctx = context2d(cv);
  const N = 3400;
  const pts: { sx: number; sy: number; ox: number; oy: number; r: number; a: number; ph: number; dl: number }[] = [];
  let targets: { x: number; y: number }[] = [];
  let W = 0;
  let H = 0;
  let sampledW = -1;
  let sampledH = -1;
  let t0 = 0;
  let capOn = false;
  let settled = false;

  for (let i = 0; i < N; i += 1) {
    pts.push({
      sx: Math.random() * vw(),
      sy: Math.random() * vh(),
      ox: 0,
      oy: 0,
      r: Math.random() < 0.08 ? 1.6 : 1,
      a: 0.45 + Math.random() * 0.55,
      ph: Math.random() * 6.28,
      dl: Math.random() * 0.9,
    });
  }

  // mark + headline + sub + sign-in are one block, centred in the window
  function layout(resample: boolean): void {
    signin.style.width = `${Math.min(Math.round(rect(cap).width), Math.round(W * 0.92))}px`;
    const capH = rect(cap).height;
    const siH = rect(signin).height;
    const G1 = 36;
    const G2 = 16;
    const scale = Math.min(
      (W * 0.3) / 280,
      Math.max(84, Math.min(150, H - capH - siH - G1 - G2 - 160)) / 161,
    );
    const w = 280 * scale;
    const h = 161 * scale;
    const ox = (W - w) / 2;
    const oy = Math.max(
      56,
      Math.round((H - (h + G1 + capH + G2 + siH + (options.replay ? NAVGAP + NAVH : 0))) / 2),
    );
    if (resample || targets.length === 0) {
      targets = sampleMark(scale, w, h, ox, oy);
    }
    cap.style.top = `${Math.round(oy + h + G1)}px`;
    signin.style.top = `${Math.round(oy + h + G1 + capH + G2)}px`;
    if (options.replay) placeNav(refs.nav, oy + h + G1 + capH + G2 + siH + NAVGAP);
  }

  function sampleMark(scale: number, w: number, h: number, ox: number, oy: number) {
    const out: { x: number; y: number }[] = [];
    const cand: [number, number][] = [];
    try {
      const oc = document.createElement('canvas');
      oc.width = Math.max(1, Math.ceil(w));
      oc.height = Math.max(1, Math.ceil(h));
      const o = oc.getContext('2d');
      if (o && typeof Path2D === 'function') {
        o.scale(scale, scale);
        o.fillStyle = '#fff';
        o.fill(new Path2D(HQ_MARK_H));
        o.fill(new Path2D(HQ_MARK_Q), 'evenodd');
        const d = o.getImageData(0, 0, oc.width, oc.height).data;
        for (let y = 0; y < oc.height; y += 2)
          for (let x = 0; x < oc.width; x += 2)
            if (d[(y * oc.width + x) * 4 + 3]! > 128) cand.push([x + ox, y + oy]);
      }
    } catch {
      // No offscreen canvas: the particles simply stay a field.
    }
    for (let i = 0; i < N; i += 1) {
      const c = cand.length ? cand[(Math.random() * cand.length) | 0]! : [pts[i]!.sx, pts[i]!.sy];
      out.push({ x: c[0]! + (Math.random() - 0.5) * 1.5, y: c[1]! + (Math.random() - 0.5) * 1.5 });
    }
    return out;
  }

  return {
    size() {
      W = vw();
      H = vh();
      const k = dpr();
      cv.width = W * k;
      cv.height = H * k;
      ctx?.setTransform(k, 0, 0, k, 0, 0);
      const resample = W !== sampledW || H !== sampledH;
      sampledW = W;
      sampledH = H;
      layout(resample);
    },
    enter(now) {
      t0 = now;
      capOn = false;
      settled = false;
      cap.classList.remove('on');
      signin.classList.remove('on');
    },
    // Skip (or coming Back from the folder) lands the mark instantly
    skip() {
      t0 -= 30000;
    },
    frame(now) {
      const t = (now - t0) / 1000;
      if (ctx) {
        ctx.clearRect(0, 0, W, H);
        const appear = clamp01((t - 2.2) / 0.8); // holds the whole field off until the veil has landed
        const pull = clamp01((t - 3.0) / 2.2);
        ctx.fillStyle = '#fff';
        for (let i = 0; i < N; i += 1) {
          const p = pts[i]!;
          const g = targets[i] ?? { x: p.sx, y: p.sy };
          const u = ease(clamp01((t - 2.8 - p.dl) / 1.9));
          const dx0 = Math.sin(t * 0.35 + p.ph) * 40;
          const dy0 = Math.cos(t * 0.3 + p.ph * 1.3) * 30;
          let x = p.sx + dx0 + (g.x - p.sx - dx0) * u;
          let y = p.sy + dy0 + (g.y - p.sy - dy0) * u;
          const mx = x - pointer.x;
          const my = y - pointer.y;
          const d2 = mx * mx + my * my;
          if (d2 < 4600) {
            const f = (1 - d2 / 4600) * 7;
            const d = Math.sqrt(d2) + 0.001;
            p.ox += (mx / d) * f * 0.12;
            p.oy += (my / d) * f * 0.12;
          }
          p.ox *= 0.84;
          p.oy *= 0.84;
          x += p.ox;
          y += p.oy;
          const tw = 0.75 + 0.25 * Math.sin(t * 2 + p.ph);
          ctx.globalAlpha = appear * (0.25 + 0.75 * pull) * p.a * tw;
          ctx.beginPath();
          ctx.arc(x, y, p.r, 0, 6.283);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      if (!capOn && t > 5.4) {
        capOn = true;
        cap.classList.add('on');
      }
      if (!settled && t > 6.0) {
        settled = true;
        signin.classList.add('on');
        options.onSettle();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The ASCII skyline (files, rising), shared by the folder and ready screens.
// keepOut() returns the content block's box; towers under it are capped so
// they never reach the copy. The cursor stirs a few cells, mildly.
// ---------------------------------------------------------------------------

const SKY = 0.3;
/** Skyline cell (px): one character per cell. */
const SKY_CELL = 11;
/** The skyline's characters: white with a little blue. */
const SKYLINE_TINT = 'rgb(206, 222, 255)';
/** Clear space kept between the content block and the towers under it. */
const SKY_PAD = 28;

/**
 * The skyline's ground row: its bottom row of characters sits in the last
 * cell row. The prototype used ceil(H / cell), which in a window whose height
 * is just over a whole number of cells (686 = 62.4 cells) put that row's
 * centre below the window edge, so the base of every tower was cut off.
 * When the last row's centre would fall off-screen it moves up one row.
 */
export function skylineGround(H: number): number {
  const rows = Math.ceil(H / SKY_CELL);
  return (rows - 1) * SKY_CELL + SKY_CELL / 2 > H ? rows - 1 : rows;
}

/**
 * Height (px) kept free under a screen's content for the skyline: 60% of
 * its tallest tower (SKY of the window) plus the clear gap above it. A tall
 * window (820x910) leaves more than this under the folder tree, as in the
 * prototype; a short one (a 1024x686 work area) left two or three rows.
 */
export function skylineBand(H: number): number {
  return Math.ceil(Math.floor((H * SKY) / SKY_CELL) * 0.6) * SKY_CELL + SKY_PAD;
}

export interface KeepOut {
  l: number;
  r: number;
  b: number;
}

function createSkyline(cv: HTMLCanvasElement, keepOut: () => KeepOut, RISE0: number) {
  const ctx = context2d(cv);
  const SPARSE = '.,/';
  const DENSE = '#HQ*';
  const ALL = SPARSE + DENSE;
  const TIERS = [0.2, 0.3, 0.41, 0.53, 0.66, 0.8, 1.0];
  const CELL = SKY_CELL;
  const FONT = 10;
  let W = 0;
  let H = 0;
  let cols = 0;
  let rows = 0;
  let churn = 0;
  let city: { x: number; row: number; col: number; ch: string; h: number; rise: number; a: number; gy: number }[] = [];

  function size() {
    W = vw();
    H = vh();
    const k = dpr();
    cv.width = W * k;
    cv.height = H * k;
    ctx?.setTransform(k, 0, 0, k, 0, 0);
  }

  function build() {
    cols = Math.ceil(W / CELL);
    rows = Math.ceil(H / CELL);
    const groundRow = skylineGround(H);
    const maxH = Math.floor((H * SKY) / CELL);
    const ko = keepOut();
    const FADE = 190;
    const freeRows = Math.max(2, Math.floor((H - ko.b - SKY_PAD) / CELL));
    function capAt(px: number) {
      if (freeRows >= maxH) return maxH;
      const d = px < ko.l ? ko.l - px : px > ko.r ? px - ko.r : 0;
      let k = d >= FADE ? 1 : d / FADE;
      k = k * k * (3 - 2 * k);
      return Math.floor(freeRows + (maxH - freeRows) * k);
    }
    city = [];
    let c = 0;
    let seed = 0;
    let b = 0;
    let prevTier = -9;
    while (c < cols) {
      const w = 3 + Math.floor(rnd(seed++) * 7);
      let ti = Math.floor(rnd(seed++) * TIERS.length);
      let guard = 0;
      while (Math.abs(ti - prevTier) < 2 && guard++ < 8) ti = Math.floor(rnd(seed++) * TIERS.length);
      prevTier = ti;
      let hh = Math.max(2, Math.floor(maxH * TIERS[ti]!));
      if (hh > maxH) hh = maxH;
      let cap = maxH;
      for (let cx = c; cx < Math.min(c + w, cols); cx += 1) {
        const v = capAt(cx * CELL + CELL / 2);
        if (v < cap) cap = v;
      }
      if (hh > cap) hh = Math.max(2, cap);
      const delay = 0.25 + rnd(seed++) * 0.9;
      for (let x = c; x < Math.min(c + w, cols); x += 1)
        for (let y = 0; y < hh; y += 1) {
          const up = y / hh;
          const p = 0.98 - up * 0.8 - rnd(seed + x * 7 + y * 13) * 0.14;
          if (rnd(seed + x * 31 + y * 17) > p) continue;
          const deep = 1 - up;
          const set = rnd(seed + x * 11 + y * 23) < deep * 0.75 ? DENSE : SPARSE;
          city.push({
            x: x * CELL + CELL / 2,
            row: y,
            col: x,
            ch: set[Math.floor(rnd(seed + x * 3 + y * 5) * set.length)]!,
            h: hh,
            rise: RISE0 + delay + (b % 3) * 0.06,
            a: 0.1 + deep * 0.48,
            gy: groundRow,
          });
        }
      c += w + 1 + (rnd(seed++) > 0.55 ? 1 : 0);
      b += 1;
    }
  }

  function draw(t: number) {
    if (!ctx) return;
    const live = clamp01(1 - (performance.now() - pointer.lastMove) / 1000 / 0.9);
    churn += (live - churn) * 0.035;
    const tick = Math.floor(t * 7);
    ctx.clearRect(0, 0, W, H);
    ctx.font = `${FONT}px ui-monospace, Menlo, Monaco, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A cool blue tint, the night-city partner to the company step's warm blossoms.
    ctx.fillStyle = SKYLINE_TINT;
    for (let i = 0; i < city.length; i += 1) {
      const m = city[i]!;
      let g = clamp01((t - m.rise) / 1.5);
      g = g < 0.5 ? 4 * g * g * g : 1 - Math.pow(-2 * g + 2, 3) / 2;
      const reach = g * m.h;
      if (m.row > reach) continue;
      const edge = clamp01(reach - m.row);
      const flick = 0.9 + 0.1 * Math.sin(t * 1.6 + m.col * 0.7 + m.row * 0.4);
      const py = (m.gy - 1 - m.row) * CELL + CELL / 2;
      let ch = m.ch;
      let boost = 0;
      if (churn > 0.004) {
        if (rnd(m.col * 53 + m.row * 97 + tick * 7.3) < churn * 0.35)
          ch = ALL[Math.floor(rnd(m.col * 29 + m.row * 61 + tick * 3.7) * ALL.length)]!;
        boost = churn * 0.06;
      }
      ctx.globalAlpha = Math.min(1, (m.a + boost) * edge * flick);
      ctx.fillText(ch, m.x, py);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  return {
    size,
    build,
    draw,
    reset() {
      churn = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Scene 1 - it's a folder. The folder appears with the title, opens, and docks
// beside HQ/ as the tree writes in beneath it. The skyline rises with it.
// ---------------------------------------------------------------------------

export interface FolderRefs {
  canvas: HTMLCanvasElement;
  copy: HTMLElement;
  tree: HTMLElement;
  root: HTMLElement;
  rows: HTMLElement[];
  loc: HTMLElement | null;
  folder: HTMLElement;
  nav: HTMLElement | null;
}

export function createFolderEngine(refs: FolderRefs, options: { reveal: () => void }): SceneEngine {
  const { canvas, copy, tree, folder } = refs;
  let t0 = 0;
  let beats: Beat[] = [];

  function keepOut(): KeepOut {
    const a = rect(copy);
    const b = rect(tree);
    return { l: Math.min(a.left, b.left), r: Math.max(a.right, b.right), b: Math.max(a.bottom, b.bottom) };
  }

  // Vertical spacing of the folder screen, 0 = the prototype's, 1 = tightest.
  // In a short window the gaps in the copy, the tree and the location row
  // (welcome.css, var(--fold-k)) and the gaps around the tree close up so
  // the skyline keeps a readable band under Install here.
  let navGap = NAVGAP;
  function setFold(k: number) {
    const v = k.toFixed(3);
    copy.style.setProperty('--fold-k', v);
    tree.style.setProperty('--fold-k', v);
    navGap = Math.round(NAVGAP - (NAVGAP - 24) * k);
    return Math.round(34 - 16 * k); // copy -> tree gap
  }

  // centre the copy + tree block in the space between the titlebar and the
  // skyline; the folder sits at that block's centre before it hands over
  function place(gap: number) {
    const H = vh();
    const y = copyTop(H);
    const ceiling = Math.round(H * (1 - SKY));
    const ch = rect(copy).height;
    const th = rect(tree).height;
    const roomTop = y + ch + gap;
    const treeTop = placeUnder(roomTop, ceiling, th + navGap + NAVH, 30);
    return { y, th, treeTop, bottom: treeTop + th + navGap + NAVH };
  }

  function layoutTree() {
    const H = vh();
    const limit = H - skylineBand(H);
    let gap = setFold(0);
    let at = place(gap);
    if (at.bottom > limit) {
      const loose = at.bottom;
      gap = setFold(1);
      at = place(gap);
      const saved = loose - at.bottom;
      if (at.bottom < limit && saved > 0) {
        gap = setFold(Math.min(1, (loose - limit) / saved));
        at = place(gap);
      }
    }
    const shift = centreShift(at.y, at.bottom, limit, H);
    const y = at.y + shift;
    const th = at.th;
    const treeTop = at.treeTop + shift;
    copy.style.top = `${y}px`;
    tree.style.top = `${treeTop}px`;
    placeNav(refs.nav, treeTop + th + navGap);
    const fy = Math.round(treeTop + th / 2);
    folder.style.top = `${fy}px`; // dead centre of where the tree will be
    // dock target: beside the HQ/ root, on the tree's left edge
    const treeLeft = (vw() - rect(tree).width) / 2;
    folder.style.setProperty('--dx', `${Math.round(treeLeft + 26 - vw() / 2)}px`);
    folder.style.setProperty('--dy', `${Math.round(treeTop + 25 - fy)}px`);
  }

  // skyline waits for the folder to open (rise 1.6s); the button under the tree is part of the block
  const sky = createSkyline(
    canvas,
    () => {
      const k = keepOut();
      k.b += navGap + NAVH;
      return k;
    },
    1.6,
  );

  const all = () => [refs.root, ...refs.rows, ...(refs.loc ? [refs.loc] : [])];

  return {
    size() {
      sky.size();
      layoutTree();
      sky.build();
    },
    skip() {
      t0 -= 30000;
    },
    enter(now) {
      t0 = now;
      sky.reset();
      folder.classList.remove('in', 'open', 'dock');
      for (const el of all()) el.classList.remove('on');
      layoutTree();
      sky.build();
      // title and folder arrive together -> folder opens (skyline rises with
      // it) -> folder docks beside HQ/ as the tree writes in beneath it
      beats = [
        [0.15, () => folder.classList.add('in')],
        [1.1, () => folder.classList.add('open')],
        [2.3, () => folder.classList.add('dock')], // 1.05s travel -> lands ~3.35s
        [3.45, () => refs.root.classList.add('on')], // HQ/ only once it has landed
      ];
      refs.rows.forEach((row, i) => beats.push([3.75 + i * 0.32, () => row.classList.add('on')]));
      beats.push([3.75 + refs.rows.length * 0.32 + 0.25, () => refs.loc?.classList.add('on')]);
      beats.push([3.75 + refs.rows.length * 0.32 + 0.75, options.reveal]);
    },
    frame(now) {
      const t = (now - t0) / 1000;
      runBeats(beats, t);
      sky.draw(t);
    },
  };
}

// ---------------------------------------------------------------------------
// Scene 2 - local folder, cloud team. The orbit: company cloud at the core,
// you / team / agents on the inner ring, one outer chip per capability card.
// ---------------------------------------------------------------------------

export interface OrbitRefs {
  rings: SVGSVGElement;
  ellipses: [SVGEllipseElement, SVGEllipseElement];
  core: SVGSVGElement;
  corelabel: HTMLElement;
  copy: HTMLElement;
  rail: HTMLElement;
  railRows: HTMLElement[];
  /** Inner-ring chips first, then the outer ring's. */
  innerChips: HTMLElement[];
  outerChips: HTMLElement[];
  nav: HTMLElement | null;
}

/**
 * The cloud screen's vertical gaps: title -> orbit, orbit -> rail, rail ->
 * Next. `space` is the height left for the orbit plus these three gaps once
 * the title, rail and button are placed; `wantOrbit` is the orbit height
 * (chips included) the screen should get. The prototype's gaps (40/44/44)
 * hold whenever that fits; otherwise they shrink together toward 20/24/24.
 */
export function orbitGaps(space: number, wantOrbit: number): { gap1: number; gap2: number; navGap: number } {
  const full = { gap1: 40, gap2: 44, navGap: NAVGAP };
  const least = { gap1: 20, gap2: 24, navGap: 24 };
  const fullSum = full.gap1 + full.gap2 + full.navGap;
  const slack = fullSum - (least.gap1 + least.gap2 + least.navGap);
  const short = wantOrbit - (space - fullSum);
  const k = Math.max(0, Math.min(1, short / slack));
  return {
    gap1: Math.round(full.gap1 - (full.gap1 - least.gap1) * k),
    gap2: Math.round(full.gap2 - (full.gap2 - least.gap2) * k),
    navGap: Math.round(full.navGap - (full.navGap - least.navGap) * k),
  };
}

export function createOrbitEngine(refs: OrbitRefs, options: { reveal: () => void }): SceneEngine {
  const rings = [
    { r: 0.26, squash: 0.38, speed: 0.2, dir: 1, rx: 0, ry: 0, el: refs.ellipses[0] },
    { r: 0.4, squash: 0.38, speed: 0.11, dir: -1, rx: 0, ry: 0, el: refs.ellipses[1] },
  ];
  const chips = [
    ...refs.innerChips.map((el, i, list) => ({ el, ring: rings[0]!, a0: (i / list.length) * 6.283, on: false })),
    ...refs.outerChips.map((el, i, list) => ({ el, ring: rings[1]!, a0: (i / list.length) * 6.283, on: false })),
  ];
  let cx = 0;
  let cy = 0;
  let t0 = 0;
  let beats: Beat[] = [];
  const { rail, railRows, copy, core, corelabel } = refs;

  // The copy, the orbit and the rail are laid out as ONE block and centred in
  // the room above the controls, with fixed gaps between them.
  function size() {
    const W = vw();
    const H = vh();
    cx = W / 2;
    // Equal-width cards, sized so the longest one-line subtitle fits; in a
    // narrower window they shrink together and the subtitle ellipsizes (the
    // prototype's rule). The rail never runs wider than 96% of the window.
    rail.style.width = 'auto';
    for (const row of railRows) row.style.flex = '0 0 auto';
    let maxW = 0;
    for (const row of railRows) maxW = Math.max(maxW, rect(row).width);
    for (const row of railRows) row.style.flex = '1 1 0';
    rail.style.width = `${Math.min(Math.floor(W * 0.96), Math.ceil(maxW) * railRows.length + 10 * (railRows.length - 1))}px`;

    const y = copyTop(H);
    const chipHalf = 12;
    const capGap = 58;
    const sideGap = 64;
    const MAX_OUTER_RY = 150;
    const RATIO = rings[1]!.r / rings[0]!.r;
    const ch = rect(copy).height;
    const rh = rect(rail).height;
    copy.style.top = `${y}px`;
    const bottom = H - FLOOR; // room under the title
    // The prototype's gaps (title -> orbit 40, orbit -> rail 44, rail -> Next
    // 44) assume a tall window. In a short one (a 1024x686 work area) they
    // left the orbit ~70px tall: the inner ring ran through the mark's
    // caption and the chips piled onto each other. There the gaps give up
    // space first, down to a floor, until the orbit is tall enough for its
    // inner track to clear the mark (at the mark's 72px floor) and caption.
    const { gap1: GAP1, gap2: GAP2, navGap } = orbitGaps(
      bottom - (y + ch) - rh - NAVH,
      2 * (Math.min(MAX_OUTER_RY, ((72 * 161) / 280 / 2 + capGap) * RATIO) + chipHalf),
    );
    const top = y + ch + GAP1;
    const room = bottom - top - rh - GAP2 - navGap - NAVH; // vertical room for the orbit incl. chips
    const maxOuterRy = Math.max(24, Math.min(MAX_OUTER_RY, room / 2 - chipHalf));
    const maxInnerRy = maxOuterRy / RATIO;
    let coreW = 120;
    let coreH = (coreW * 161) / 280;
    if (coreH / 2 + capGap > maxInnerRy) {
      coreW = Math.max(72, Math.floor(((maxInnerRy - capGap) * 2 * 280) / 161));
      coreH = (coreW * 161) / 280;
    }
    core.style.width = `${coreW}px`;
    const base = Math.min(W, maxOuterRy / (rings[1]!.r * rings[1]!.squash));
    for (const R of rings) {
      R.rx = base * R.r;
      R.ry = R.rx * R.squash;
    }
    const need = Math.max(1, (coreW / 2 + sideGap) / rings[0]!.rx, (coreH / 2 + capGap) / rings[0]!.ry);
    const fit = Math.min(1, maxOuterRy / (rings[1]!.ry * need), (W / 2 - 48) / (rings[1]!.rx * need));
    for (const R of rings) {
      R.rx *= need * fit;
      R.ry *= need * fit;
    }
    const orbitH = 2 * (rings[1]!.ry + chipHalf);
    const block = orbitH + GAP2 + rh + navGap + NAVH;
    const start = placeUnder(top, bottom, block, 30);
    cy = Math.round(start + orbitH / 2);
    const laidRailTop = Math.round(cy + orbitH / 2 + GAP2);
    const shift = centreShift(y, laidRailTop + rh + navGap + NAVH, bottom, H);
    copy.style.top = `${y + shift}px`;
    cy += shift;
    const railTop = laidRailTop + shift;
    rail.style.bottom = 'auto';
    rail.style.top = `${railTop}px`;
    placeNav(refs.nav, railTop + rh + navGap);
    for (const R of rings) {
      R.el.setAttribute('cx', String(cx));
      R.el.setAttribute('cy', String(cy));
      R.el.setAttribute('rx', String(R.rx));
      R.el.setAttribute('ry', String(R.ry));
    }
    core.style.top = `${cy}px`;
    corelabel.style.top = `${cy}px`;
    corelabel.style.marginTop = `${Math.round(coreH / 2 + 12)}px`;
    // track the caption out to exactly the mark's width (font size stays 11px).
    corelabel.style.letterSpacing = '0px';
    corelabel.style.paddingLeft = '0px';
    const n = (corelabel.textContent ?? '').length;
    const w0 = rect(corelabel).width;
    const ls = Math.max(0.4, (coreW - w0) / Math.max(1, n - 1));
    corelabel.style.letterSpacing = `${ls.toFixed(2)}px`;
    corelabel.style.paddingLeft = `${ls.toFixed(2)}px`;
  }

  function reset() {
    refs.rings.classList.remove('on');
    core.classList.remove('on');
    corelabel.style.opacity = '0';
    for (const chip of chips) chip.on = false;
    for (const row of railRows) row.classList.remove('on');
  }

  return {
    size,
    skip() {
      flushBeats(beats);
    },
    enter(now) {
      t0 = now;
      reset();
      size();
      beats = [
        [0.2, () => refs.rings.classList.add('on')],
        [0.7, () => core.classList.add('on')],
        [1.1, () => (corelabel.style.opacity = '1')],
      ];
      chips.forEach((chip, i) => beats.push([1.3 + i * 0.12, () => (chip.on = true)]));
      railRows.forEach((row, i) => beats.push([2.6 + i * 0.15, () => row.classList.add('on')]));
      beats.push([2.6 + railRows.length * 0.15 + 0.4, options.reveal]);
    },
    frame(now) {
      const t = (now - t0) / 1000;
      runBeats(beats, t);
      for (const chip of chips) {
        const R = chip.ring;
        const a = chip.a0 + t * R.speed * R.dir;
        const x = cx + Math.cos(a) * R.rx;
        const y = cy + Math.sin(a) * R.ry;
        const depth = (Math.sin(a) + 1) / 2;
        const s = 0.8 + depth * 0.3;
        chip.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%) scale(${s})`;
        chip.el.style.zIndex = depth > 0.5 ? '5' : '1';
        chip.el.style.opacity = chip.on ? String(0.82 + depth * 0.18) : '0';
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Scene 3 - one shortcut. The whole board assembles key by key, then the chord
// presses itself: option, shift, O.
// ---------------------------------------------------------------------------

export interface KeyDef {
  id: string;
  label: string;
  w?: number;
  glyph?: string;
}

/**
 * A compact ANSI board, widths in key units. The bottom row follows the host:
 * fn, control, option, command on a Mac; fn, control, Windows, Alt on a PC.
 * The caller passes the layout from the onboarding UA read. This used to be a
 * module-level constant read from the shared platform probe, which is empty in
 * the onboarding window, so a Mac drew the PC board.
 */
export function keyboardRowsFor(layout: ShortcutKeyboardLayout): KeyDef[][] {
  const L = (str: string): KeyDef[] => str.split('').map((k) => ({ id: k.toLowerCase(), label: k }));
  const mac = layout === 'mac';
  return [
    [{ id: 'esc', label: 'esc', w: 1.5 }, ...['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map((f) => ({ id: f.toLowerCase(), label: f }))],
    [{ id: 'grave', label: '`' }, ...L('1234567890'), { id: 'minus', label: '-' }, { id: 'equal', label: '=' }, { id: 'backspace', label: 'delete', w: 1.5 }],
    [{ id: 'tab', label: 'tab', w: 1.5 }, ...L('QWERTYUIOP'), { id: 'lbracket', label: '[' }, { id: 'rbracket', label: ']' }, { id: 'backslash', label: '\\' }],
    [{ id: 'caps', label: 'caps lock', w: 1.85 }, ...L('ASDFGHJKL'), { id: 'semicolon', label: ';' }, { id: 'quote', label: "'" }, { id: 'return', label: 'return', w: 1.65 }],
    [{ id: 'shift', label: 'shift', w: 2.35, glyph: '⇧' }, ...L('ZXCVBNM'), { id: 'comma', label: ',' }, { id: 'period', label: '.' }, { id: 'slash', label: '/' }, { id: 'rshift', label: 'shift', w: 2.15, glyph: '⇧' }],
    mac
      ? [{ id: 'fn', label: 'fn' }, { id: 'ctrl', label: 'control', glyph: '⌃' }, { id: 'alt', label: 'option', glyph: '⌥' }, { id: 'cmd', label: 'command', w: 1.25, glyph: '⌘' }, { id: 'space', label: '', w: 5.5 }, { id: 'rcmd', label: 'command', w: 1.25, glyph: '⌘' }, { id: 'ralt', label: 'option', glyph: '⌥' }, { id: 'left', label: '◂' }, { id: 'updown', label: '▴▾' }, { id: 'right', label: '▸' }]
      : [{ id: 'fn', label: 'fn' }, { id: 'ctrl', label: 'control', glyph: '⌃' }, { id: 'cmd', label: 'Windows', w: 1.25, glyph: '⊞' }, { id: 'alt', label: 'Alt' }, { id: 'space', label: '', w: 5.5 }, { id: 'ralt', label: 'Alt' }, { id: 'rcmd', label: 'Windows', w: 1.25, glyph: '⊞' }, { id: 'left', label: '◂' }, { id: 'updown', label: '▴▾' }, { id: 'right', label: '▸' }],
  ];
}

const CHORD = ['alt', 'shift', 'o'] as const;

export interface KeyboardRefs {
  kb: HTMLElement;
  keys: Map<string, HTMLElement>;
  glow: HTMLElement;
  line: HTMLElement;
  copy: HTMLElement;
  nav: HTMLElement | null;
}

export function createKeyboardEngine(refs: KeyboardRefs, options: { reveal: () => void }): SceneEngine {
  const { kb, keys, glow, line, copy } = refs;
  let beats: Beat[] = [];
  let t0 = 0;

  // board scales to the window; the copy + board + chord line centre in the
  // room above the controls
  function size() {
    const W = vw();
    const H = vh();
    const units = 15;
    const gap = 6;
    const u = Math.max(28, Math.min(44, Math.floor((Math.min(W * 0.66, 760) - gap * (units - 1)) / units)));
    kb.style.setProperty('--u', `${u}px`);
    const y = copyTop(H);
    const GAP1 = 36;
    const GAP2 = 26;
    const ch = rect(copy).height;
    const kh = rect(kb).height;
    const lh = rect(line).height;
    copy.style.top = `${y}px`;
    const top = y + ch + GAP1;
    const bottom = H - FLOOR;
    const block = kh + GAP2 + lh + NAVGAP + NAVH;
    const shift = centreShift(y, placeUnder(top, bottom, block, 30) + block, bottom, H);
    copy.style.top = `${y + shift}px`;
    const start = placeUnder(top, bottom, block, 30) + shift;
    kb.style.top = `${start}px`;
    line.style.top = `${Math.round(start + kh + GAP2)}px`;
    placeNav(refs.nav, start + kh + GAP2 + lh + NAVGAP);
    for (const id of CHORD) {
      const key = keys.get(id);
      if (key?.classList.contains('lit')) knockout(key);
    }
  }

  // A luminance mask: white plate, black text -> the text becomes a hole, so
  // the letters show the glass through them.
  function knockout(key: HTMLElement) {
    key.querySelector('.ko')?.remove();
    const r = rect(key);
    const w = r.width;
    const h = r.height;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'ko');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    const id = `ko-${key.dataset.id ?? 'k'}`;
    const glyph = key.querySelector<HTMLElement>('.kglyph');
    const label = key.querySelector<HTMLElement>('.klabel');
    // the cut-out text sits exactly where the (hidden) DOM text is laid out,
    // measured from the live boxes, so lighting a key never shifts its content
    const textAt = (el: HTMLElement) => {
      const b = rect(el);
      const cs = getComputedStyle(el);
      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', '50%');
      text.setAttribute('y', (b.top - r.top + b.height / 2).toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      text.setAttribute('font-size', cs.fontSize);
      text.setAttribute('fill', '#000');
      text.textContent = el.textContent;
      return text;
    };
    const defs = document.createElementNS(ns, 'defs');
    const mask = document.createElementNS(ns, 'mask');
    mask.setAttribute('id', id);
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('x', '0');
    mask.setAttribute('y', '0');
    mask.setAttribute('width', String(w));
    mask.setAttribute('height', String(h));
    const white = document.createElementNS(ns, 'rect');
    white.setAttribute('width', '100%');
    white.setAttribute('height', '100%');
    white.setAttribute('fill', '#fff');
    mask.appendChild(white);
    if (glyph) mask.appendChild(textAt(glyph));
    if (label) mask.appendChild(textAt(label));
    defs.appendChild(mask);
    svg.appendChild(defs);
    const plate = document.createElementNS(ns, 'rect');
    plate.setAttribute('width', '100%');
    plate.setAttribute('height', '100%');
    plate.setAttribute('rx', '6');
    plate.setAttribute('fill', '#fff');
    plate.setAttribute('mask', `url(#${id})`);
    svg.appendChild(plate);
    key.appendChild(svg);
  }

  function light(id: string) {
    const key = keys.get(id);
    if (!key) return;
    knockout(key);
    key.classList.add('lit');
  }

  function reset() {
    kb.classList.remove('in', 'on');
    for (const id of CHORD) keys.get(id)?.classList.remove('lit');
    glow.classList.remove('on');
    line.classList.remove('on');
  }

  return {
    size,
    skip() {
      flushBeats(beats);
    },
    enter(now) {
      t0 = now;
      reset();
      size();
      // titles settle first (~1.2s), THEN the chassis floats up, the keys
      // populate it, and the chord presses
      beats = [
        [1.3, () => kb.classList.add('in')],
        [1.8, () => kb.classList.add('on')],
        [2.7, () => light('alt')],
        [2.95, () => light('shift')],
        [
          3.2,
          () => {
            light('o');
            glow.classList.add('on');
          },
        ],
        [3.6, () => line.classList.add('on')],
        [4.0, options.reveal],
      ];
    },
    frame(now) {
      runBeats(beats, (now - t0) / 1000);
    },
  };
}

// ---------------------------------------------------------------------------
// Scene 4 - help make HQ better. Two choices, then the fine print.
// ---------------------------------------------------------------------------

export interface ConsentRefs {
  copy: HTMLElement;
  form: HTMLElement;
  choices: HTMLElement[];
  fine: HTMLElement;
  nav: HTMLElement | null;
}

export function createConsentEngine(refs: ConsentRefs, options: { reveal: () => void }): SceneEngine {
  let t0 = 0;
  let beats: Beat[] = [];
  function size() {
    const H = vh();
    const y = copyTop(H);
    const GAP1 = 36;
    const ch = rect(refs.copy).height;
    const fh = rect(refs.form).height;
    refs.copy.style.top = `${y}px`;
    const laidFt = placeUnder(y + ch + GAP1, H - FLOOR, fh + NAVGAP + NAVH, 30);
    const shift = centreShift(y, laidFt + fh + NAVGAP + NAVH, H - FLOOR, H);
    refs.copy.style.top = `${y + shift}px`;
    const ft = laidFt + shift;
    refs.form.style.top = `${ft}px`;
    placeNav(refs.nav, ft + fh + NAVGAP);
  }
  return {
    size,
    skip() {
      t0 -= 30000;
    },
    enter(now) {
      t0 = now;
      for (const choice of refs.choices) choice.classList.remove('on');
      refs.fine.classList.remove('on');
      size();
      beats = [
        [0.9, () => refs.choices[0]?.classList.add('on')],
        [1.05, () => refs.choices[1]?.classList.add('on')],
        [1.5, () => refs.fine.classList.add('on')],
        [1.9, options.reveal],
      ];
    },
    frame(now) {
      runBeats(beats, (now - t0) / 1000);
    },
  };
}

// ---------------------------------------------------------------------------
// Scene 5 - ready. The folder screen's skyline returns under the title, the
// progress capsule finishes, and Open HQ Desktop arrives.
// ---------------------------------------------------------------------------

export interface ReadyRefs {
  canvas: HTMLCanvasElement;
  copy: HTMLElement;
  prog: HTMLElement;
  nav: HTMLElement | null;
  alt: HTMLElement;
}

export function createReadyEngine(refs: ReadyRefs, options: { reveal: () => void }): SceneEngine {
  const ALTGAP = 18;
  const PROGH = 34;
  let t0 = 0;
  let beats: Beat[] = [];
  function keepOut(): KeepOut {
    const a = rect(refs.copy);
    const b = rect(refs.alt);
    const p = rect(refs.prog);
    return { l: Math.min(a.left, p.left, b.left), r: Math.max(a.right, p.right, b.right), b: b.bottom };
  }
  const sky = createSkyline(refs.canvas, keepOut, 0.5);
  // The nav grows after the screen is shown (the "Checking for AI tools" row
  // comes and goes with each probe), so its height is watched, not read once.
  let observer: ResizeObserver | null = null;
  let active = false;
  function watch() {
    if (observer || !refs.nav || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      if (active) layout();
    });
    observer.observe(refs.nav);
  }
  // the whole stack (title, body, progress, button, alt line) is one block,
  // centred in the window; the skyline caps itself under it
  function layout() {
    const H = vh();
    const ch = rect(refs.copy).height;
    const altH = Math.max(18, rect(refs.alt).height);
    // The ready screen's nav is the row of option cards, taller than a button.
    const navH = Math.max(NAVH, refs.nav ? rect(refs.nav).height : 0);
    const G1 = 36;
    const G2 = 32;
    const block = ch + G1 + PROGH + G2 + navH + ALTGAP + altH;
    // centred, but never low enough to crowd the skyline's band
    const y = Math.max(56, Math.min(Math.round((H - block) / 2), H - skylineBand(H) - block));
    refs.copy.style.top = `${y}px`;
    const pt = y + ch + G1;
    refs.prog.style.top = `${pt}px`;
    const nt = pt + PROGH + G2;
    placeNav(refs.nav, nt);
    refs.alt.style.top = `${Math.round(nt + navH + ALTGAP)}px`;
  }
  return {
    size() {
      sky.size();
      layout();
      sky.build();
    },
    skip() {
      t0 -= 30000;
    },
    enter(now) {
      t0 = now;
      active = true;
      watch();
      refs.prog.classList.remove('on');
      sky.reset();
      layout();
      sky.build();
      // title + body arrive with the scene; then progress, then the button
      beats = [
        [1.0, () => refs.prog.classList.add('on')],
        [1.6, options.reveal],
      ];
    },
    frame(now) {
      const t = (now - t0) / 1000;
      runBeats(beats, t);
      sky.draw(t);
    },
    exit() {
      active = false;
    },
    destroy() {
      observer?.disconnect();
      observer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Panels that are not story screens (the connector import, the post-ready
// tutorial steps): centred, no timeline beyond the copy's own fade.
// ---------------------------------------------------------------------------

function reducedMotionPreferred(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function createPanelEngine(block: HTMLElement, options: { reveal: () => void }): SceneEngine {
  let t0 = 0;
  let revealed = false;
  let active = false;
  let placedHeight = -1;
  let observer: ResizeObserver | null = null;
  function size(glide = false) {
    const H = vh();
    const bh = rect(block).height;
    placedHeight = bh;
    // A re-centre after the content changed glides; entering or resizing
    // the window places it at once.
    block.style.transition = glide ? 'top 0.5s cubic-bezier(0.23, 1, 0.32, 1)' : 'none';
    block.style.top = `${Math.max(56, Math.round((H - bh) / 2))}px`;
  }
  // A panel's content can change height after it is shown (the company step
  // goes from "Getting things ready…" to its form, then to the plan cards).
  // Centre it again whenever that happens, not only on enter and window
  // resize; otherwise it keeps the short block's position and runs off the
  // bottom of the window.
  // A panel that swaps one screen for another (the company step) asks for
  // the next re-centre to land at once: its new screen is still rising in,
  // and gliding the block under it at the same time reads as a wobble.
  let snapUntil = 0;
  block.addEventListener('hq-panel-snap', () => {
    snapUntil = performance.now() + 700;
  });
  function watch() {
    if (observer || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      if (active && rect(block).height !== placedHeight)
        size(!reducedMotionPreferred() && performance.now() > snapUntil);
    });
    observer.observe(block);
  }
  return {
    size: () => size(),
    skip() {
      t0 -= 30000;
    },
    enter(now) {
      t0 = now;
      revealed = false;
      active = true;
      watch();
      size();
    },
    exit() {
      active = false;
    },
    frame(now) {
      if (!revealed && (now - t0) / 1000 > 0.6) {
        revealed = true;
        options.reveal();
      }
    },
    destroy() {
      observer?.disconnect();
      observer = null;
    },
  };
}

// ---------------------------------------------------------------------------
// The company step's ASCII art: two flowering trees in the skyline's
// characters. A pink cherry bough reaches in from the top-left corner and a
// coral tree's crown fills the bottom-right, their diagonal twin. Each crown
// is packed with shaded blossom clusters (dense #HQ* at a cluster's heart,
// sparse .,/ at its rim, ':' on the lit side), with a trunk and a few limbs
// showing in the gaps and leaves behind. Petals drift down. Nothing is drawn
// over the content (a padded box around it). Designer prototype:
// workspace/drafts/hq-company-art-concepts ("Flower trees").
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number];

export interface FlowerCell {
  x: number;
  y: number;
  kind: 'branch' | 'leaf' | 'bloom';
  ch: string;
  rgb: Rgb;
  /** Resting alpha. */
  a: number;
  /** When it grows in, on the tree's 0-1+ timeline. */
  t: number;
  /** Blossoms: distance from the cluster's centre (0-1), for the opening. */
  d: number;
  seed: number;
  /** Which tree: 'pink' (top-left) or 'coral' (bottom-right). */
  tree: 'pink' | 'coral';
}

export interface FlowerPetal {
  x0: number;
  speed: number;
  phase: number;
  spin: number;
  rgb: Rgb;
}

export interface FlowerTrees {
  cells: FlowerCell[];
  petals: FlowerPetal[];
}

export interface KeepOutBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const FLOWER_CORAL: Rgb = [255, 112, 92];
const FLOWER_CORAL_HI: Rgb = [255, 176, 150];
const FLOWER_PINK: Rgb = [246, 160, 196];
const FLOWER_PINK_HI: Rgb = [255, 222, 234];
const FLOWER_LEAF: Rgb = [70, 140, 138];
const FLOWER_LEAF_COOL: Rgb = [70, 110, 160];
const FLOWER_BARK: Rgb = [176, 146, 170];
const FLOWER_SHADE: Rgb = [40, 20, 50];
const FLOWER_SPARSE = '.,/';
const FLOWER_LIT_RIM = '.,:';
/** H and Q are the accent, not the fill: about one dense character in seven. */
const FLOWER_HEART = '#*#**#*#*#*#HQ';
const FLOWER_CHURN = '.,/#HQ*';
const FLOWER_PETALS = 12;
const FLOWER_PAD = 34;

function mixRgb(a: Rgb, b: Rgb, k: number): Rgb {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

interface Ellipse {
  x: number;
  y: number;
  rx: number;
  ry: number;
}

/**
 * The two trees as character cells for a W x H window, keeping clear of
 * `keep` (the content). Pure apart from the seeded noise, so tests can read it.
 */
export function flowerTreesLayout(W: number, H: number, keep: KeepOutBox | null): FlowerTrees {
  const CELL = SKY_CELL;
  const ground = skylineGround(H);
  const blocked = (x: number, y: number) =>
    keep !== null &&
    x > keep.left - FLOWER_PAD &&
    x < keep.right + FLOWER_PAD &&
    y > keep.top - FLOWER_PAD &&
    y < keep.bottom + FLOWER_PAD;
  interface Seg { x0: number; y0: number; x1: number; y1: number; w: number; t: number; a: number }
  interface Puff { x: number; y: number; r: number; tree: 'pink' | 'coral'; t: number }
  const segs: Seg[] = [];
  const puffs: Puff[] = [];
  const inEllipses = (list: Ellipse[], x: number, y: number) =>
    list.some((e) => ((x - e.x) / e.rx) ** 2 + ((y - e.y) / e.ry) ** 2 <= 1);

  // Canopy first: a crown (a few overlapping ellipses) packed with blossom
  // clusters, gaps left here and there; a trunk into the crown and limbs to
  // some of the clusters, so branches show in the gaps.
  function crown(
    ellipses: Ellipse[],
    trunk: { from: { x: number; y: number }; to: { x: number; y: number }; w: number; bend: number },
    tree: 'pink' | 'coral',
    seed: number,
    step: number,
    rmin: number,
    rmax: number,
    t0: number,
  ) {
    const pts: { x: number; y: number }[] = [];
    let i = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const e of ellipses) {
      minX = Math.min(minX, e.x - e.rx);
      maxX = Math.max(maxX, e.x + e.rx);
      minY = Math.min(minY, e.y - e.ry);
      maxY = Math.max(maxY, e.y + e.ry);
    }
    for (let y = minY; y <= maxY; y += step * 0.82)
      for (let x = minX; x <= maxX; x += step) {
        i += 1;
        const jx = x + (rnd(seed + i * 1.3) - 0.5) * step * 0.7 + (Math.round(y / step) % 2 ? step / 2 : 0);
        const jy = y + (rnd(seed + i * 2.7) - 0.5) * step * 0.6;
        if (!inEllipses(ellipses, jx, jy) || blocked(jx, jy)) continue;
        if (rnd(seed + i * 4.1) < 0.2) continue;
        pts.push({ x: jx, y: jy });
      }
    const heart = trunk.to;
    const angle = Math.atan2(heart.y - trunk.from.y, heart.x - trunk.from.x);
    const mid = { x: (trunk.from.x + heart.x) / 2 + trunk.bend, y: (trunk.from.y + heart.y) / 2 };
    segs.push({ x0: trunk.from.x, y0: trunk.from.y, x1: mid.x, y1: mid.y, w: trunk.w, t: t0, a: angle });
    segs.push({ x0: mid.x, y0: mid.y, x1: heart.x, y1: heart.y, w: trunk.w * 0.72, t: t0 + 0.15, a: angle });
    pts.forEach((pt, k) => {
      const d = Math.hypot(pt.x - heart.x, pt.y - heart.y);
      const tt = t0 + 0.3 + Math.min(0.5, d / 900);
      const r = rmin + rnd(seed + k * 5.9) * (rmax - rmin);
      puffs.push({ x: pt.x, y: pt.y, r, tree, t: tt + 0.25 });
      // Only some clusters show a limb, or the gaps fill with hatching.
      if (rnd(seed + k * 6.1) < 0.6) return;
      const mx = (heart.x + pt.x) / 2 + (rnd(seed + k * 3.3) - 0.5) * 30;
      const my = (heart.y + pt.y) / 2 - 10;
      const w = Math.max(2, trunk.w * 0.38 * (1 - Math.min(0.8, d / 500)));
      segs.push({ x0: heart.x, y0: heart.y, x1: mx, y1: my, w, t: tt, a: Math.atan2(my - heart.y, mx - heart.x) });
      segs.push({ x0: mx, y0: my, x1: pt.x, y1: pt.y, w: Math.max(1.5, w * 0.6), t: tt + 0.1, a: Math.atan2(pt.y - my, pt.x - mx) });
    });
  }

  const s = Math.min(1.2, Math.max(0.8, H / 860));
  // Bottom-right: a coral tree whose crown fills the corner.
  crown(
    [
      { x: W * 0.95, y: H * 0.6, rx: W * 0.17, ry: H * 0.24 },
      { x: W * 0.85, y: H * 0.8, rx: W * 0.15, ry: H * 0.17 },
      { x: W * 0.98, y: H * 0.88, rx: W * 0.1, ry: H * 0.14 },
    ],
    { from: { x: W * 0.93, y: H + 10 }, to: { x: W * 0.91, y: H * 0.68 }, w: 24 * s, bend: 14 },
    'coral',
    17,
    58 * s,
    22 * s,
    33 * s,
    0,
  );
  // Top-left: a cherry bough reaching in from the corner, a drooping spray.
  crown(
    [
      { x: W * 0.03, y: H * 0.08, rx: W * 0.13, ry: H * 0.14 },
      { x: W * 0.14, y: H * 0.05, rx: W * 0.11, ry: H * 0.08 },
      { x: W * 0.08, y: H * 0.22, rx: W * 0.08, ry: H * 0.1 },
      { x: W * 0.24, y: H * 0.1, rx: W * 0.06, ry: H * 0.06 },
      { x: W * 0.015, y: H * 0.36, rx: W * 0.045, ry: H * 0.09 },
    ],
    { from: { x: -12, y: -12 }, to: { x: W * 0.1, y: H * 0.12 }, w: 22 * s, bend: -10 },
    'pink',
    53,
    56 * s,
    20 * s,
    32 * s,
    0.05,
  );

  // Rasterise: branches, then leaves behind the blossoms, then blossoms.
  const grid = new Map<string, FlowerCell & { z: number }>();
  const put = (c: number, r: number, cell: FlowerCell & { z: number }) => {
    const key = `${c}:${r}`;
    const old = grid.get(key);
    if (!old || cell.z >= old.z) grid.set(key, cell);
  };
  const cellXY = (c: number, r: number) => ({ x: c * CELL + CELL / 2, y: (ground - 1 - r) * CELL + CELL / 2 });
  const cellOf = (x: number, y: number) => ({
    c: Math.round((x - CELL / 2) / CELL),
    r: ground - 1 - Math.round((y - CELL / 2) / CELL),
  });
  const treeOf = (x: number): 'pink' | 'coral' => (x < W / 2 ? 'pink' : 'coral');
  for (const sg of segs) {
    const len = Math.hypot(sg.x1 - sg.x0, sg.y1 - sg.y0);
    const n = Math.max(1, Math.ceil(len / 3));
    for (let i = 0; i <= n; i += 1) {
      const x = sg.x0 + ((sg.x1 - sg.x0) * i) / n;
      const y = sg.y0 + ((sg.y1 - sg.y0) * i) / n;
      const rad = sg.w / 2;
      const c0 = cellOf(x - rad, y).c;
      const c1 = cellOf(x + rad, y).c;
      const r0 = cellOf(x, y + rad).r;
      const r1 = cellOf(x, y - rad).r;
      for (let c = c0; c <= c1; c += 1)
        for (let r = r0; r <= r1; r += 1) {
          const q = cellXY(c, r);
          if (Math.hypot(q.x - x, q.y - y) > Math.max(rad, CELL * 0.55) || blocked(q.x, q.y)) continue;
          if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) continue;
          const ca = Math.cos(sg.a);
          const sa = Math.sin(sg.a);
          const slant = ca * sa < 0 ? '/' : '\\';
          const ch =
            sg.w > 14
              ? '#HQ'[Math.floor(rnd(c * 3 + r) * 3)]!
              : sg.w > 7
                ? Math.abs(ca) < 0.35 ? '|' : slant
                : Math.abs(sa) < 0.35 ? '-' : slant;
          put(c, r, { x: q.x, y: q.y, kind: 'branch', ch, rgb: FLOWER_BARK, a: sg.w > 7 ? 0.4 : 0.24, t: sg.t, d: 0, seed: rnd(c * 5 + r * 3), tree: treeOf(q.x), z: 1 });
        }
    }
  }
  puffs.forEach((pf, n) => {
    const base = pf.tree === 'coral' ? FLOWER_CORAL : FLOWER_PINK;
    const hi = pf.tree === 'coral' ? FLOWER_CORAL_HI : FLOWER_PINK_HI;
    // A cauliflower cluster: a few overlapping round heads.
    const heads = [{ x: pf.x, y: pf.y, r: pf.r }];
    for (let h = 0; h < 4; h += 1) {
      const ang = rnd(n * 7 + h) * 6.283;
      const d = pf.r * (0.45 + rnd(n * 11 + h) * 0.25);
      heads.push({ x: pf.x + Math.cos(ang) * d, y: pf.y + Math.sin(ang) * d * 0.8, r: pf.r * (0.5 + rnd(n * 5 + h) * 0.2) });
    }
    const big = pf.r * 1.6;
    const a0 = cellOf(pf.x - big, pf.y + big);
    const a1 = cellOf(pf.x + big, pf.y - big);
    for (let c = a0.c; c <= a1.c; c += 1)
      for (let r = a0.r; r <= a1.r; r += 1) {
        const q = cellXY(c, r);
        if (blocked(q.x, q.y) || q.x < 0 || q.x > W || q.y < 0 || q.y > H) continue;
        let dmin = 9;
        for (const hd of heads) dmin = Math.min(dmin, Math.hypot(q.x - hd.x, q.y - hd.y) / hd.r);
        const s2 = c * 7 + r * 13 + n;
        if (dmin < 1.45 && dmin >= 0.9) {
          put(c, r, {
            x: q.x + 3,
            y: q.y + 4,
            kind: 'leaf',
            ch: FLOWER_SPARSE[Math.floor(rnd(s2) * FLOWER_SPARSE.length)]!,
            rgb: pf.tree === 'coral' ? FLOWER_LEAF : FLOWER_LEAF_COOL,
            a: 0.22,
            t: pf.t,
            d: dmin,
            seed: rnd(s2 + 6),
            tree: pf.tree,
            z: 0.5,
          });
        }
        if (dmin >= 1) continue;
        if (rnd(s2 + 1) > 0.8 - dmin * 0.12) continue;
        // Each cluster lit from the top-left: a bright crown, shadow beneath.
        const light = clamp01(0.55 + ((pf.x - q.x) * 0.6 + (pf.y - q.y)) / (pf.r * 1.6));
        const pick = (set: string, k: number) => set[Math.floor(rnd(s2 + k) * set.length)]!;
        const rim = light > 0.5 ? FLOWER_LIT_RIM : FLOWER_SPARSE;
        const ch =
          dmin < 0.5 ? pick(FLOWER_HEART, 2) : dmin < 0.8 ? (rnd(s2 + 3) < 0.45 ? pick(FLOWER_HEART, 4) : pick(rim, 4)) : pick(rim, 5);
        const tone =
          light < 0.35 ? mixRgb(mixRgb(base, FLOWER_SHADE, 0.45), base, light / 0.35) : mixRgb(base, hi, (light - 0.35) / 0.65);
        put(c, r, { x: q.x, y: q.y, kind: 'bloom', ch, rgb: tone, a: 0.2 + 0.4 * light, t: pf.t, d: dmin, seed: rnd(s2 + 5), tree: pf.tree, z: 2 });
      }
  });
  const cells: FlowerCell[] = [...grid.values()].map(({ z: _z, ...cell }) => cell);
  const petals: FlowerPetal[] = [];
  for (let m = 0; m < FLOWER_PETALS; m += 1) {
    petals.push({
      x0: rnd(m * 3.1) < 0.45 ? rnd(m * 5.3) * W * 0.34 : W - rnd(m * 7.1) * W * 0.32,
      speed: 12 + rnd(m * 2.7) * 16,
      phase: rnd(m * 9.4) * 60,
      spin: rnd(m * 4.4),
      rgb: rnd(m) < 0.55 ? FLOWER_PINK_HI : FLOWER_CORAL_HI,
    });
  }
  return { cells, petals };
}

export function createCompanyEngine(
  block: HTMLElement,
  cv: HTMLCanvasElement,
  options: { reveal: () => void },
): SceneEngine {
  const panel = createPanelEngine(block, { reveal: options.reveal });
  const ctx = context2d(cv);
  let W = 0;
  let H = 0;
  let t0 = 0;
  let trees: FlowerTrees | null = null;
  let keptFor: KeepOutBox | null = null;
  /** Once grown, a re-fit (the content changed height) does not grow them again. */
  let grown = false;
  let churn = 0;

  function contentBox(): KeepOutBox {
    const r = rect(block);
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  }
  function moved(a: KeepOutBox, b: KeepOutBox): boolean {
    return Math.abs(a.top - b.top) > SKY_CELL || Math.abs(a.bottom - b.bottom) > SKY_CELL || Math.abs(a.left - b.left) > SKY_CELL || Math.abs(a.right - b.right) > SKY_CELL;
  }
  function fit() {
    keptFor = contentBox();
    trees = flowerTreesLayout(W, H, keptFor);
  }
  function size() {
    panel.size();
    W = vw();
    H = vh();
    const k = dpr();
    cv.width = W * k;
    cv.height = H * k;
    ctx?.setTransform(k, 0, 0, k, 0, 0);
    fit();
  }

  function draw(t: number) {
    if (!ctx || !trees) return;
    // Each company screen has its own height; the trees step around it.
    const box = contentBox();
    if (keptFor && moved(box, keptFor)) fit();
    const live = clamp01(1 - (performance.now() - pointer.lastMove) / 1000 / 0.9);
    churn += (live - churn) * 0.035;
    const tick = Math.floor(t * 7);
    const reach = grown ? 9 : (t - 0.3) / 1.4;
    if (reach > 2.5) grown = true;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `10px ui-monospace, Menlo, Monaco, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const put = (ch: string, x: number, y: number, a: number, rgb: Rgb) => {
      if (a <= 0.004) return;
      ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
      ctx.globalAlpha = Math.min(0.62, a);
      ctx.fillText(ch, x, y);
    };
    const cells = trees.cells;
    for (let i = 0; i < cells.length; i += 1) {
      const m = cells[i]!;
      const sway = Math.sin(t * 0.7 + m.x * 0.008) * (m.kind === 'branch' ? 0.4 : 1.4);
      if (m.kind === 'branch') {
        put(m.ch, m.x + sway, m.y, m.a * clamp01((reach - m.t) * 6), m.rgb);
        continue;
      }
      const g = clamp01((reach - m.t) * 2.2);
      if (g <= 0) continue;
      if (m.kind === 'leaf') {
        put(m.ch, m.x + sway, m.y, m.a * g, m.rgb);
        continue;
      }
      if (m.d > g * 1.05) continue;
      const pulse = 0.93 + 0.07 * Math.sin(t * 1.3 + m.seed * 30);
      // As on the skyline: while the pointer moves, a few characters change
      // (the lit ones most) and brighten a touch.
      let ch = m.ch;
      let lift = 0;
      if (churn > 0.004) {
        if (rnd(i * 53.1 + tick * 7.3) < churn * (m.a > 0.4 ? 0.5 : 0.18))
          ch = FLOWER_CHURN[Math.floor(rnd(i * 29.7 + tick * 3.7) * FLOWER_CHURN.length)]!;
        lift = churn * 0.06;
      }
      put(ch, m.x + sway, m.y, m.a * pulse + lift, m.rgb);
    }
    // Petals drift down, larger than the grid; never across the content.
    const petalsOn = clamp01((t - 2) / 1.5);
    if (petalsOn > 0) {
      ctx.font = `15px ui-monospace, Menlo, Monaco, monospace`;
      trees.petals.forEach((p) => {
        const y = ((t * p.speed + p.phase * 20) % (H * 0.95)) + H * 0.04;
        const x = p.x0 + Math.sin(t * 0.8 + p.phase) * 22 - y * 0.08;
        if (keptFor && x > keptFor.left - 12 && x < keptFor.right + 12 && y > keptFor.top - 12 && y < keptFor.bottom + 12) return;
        const phase = Math.floor(t * 2 + p.spin * 4) % 3;
        put(phase === 0 ? '*' : phase === 1 ? '+' : '.', x, y, 0.7 * petalsOn, p.rgb);
      });
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  }

  return {
    size,
    skip() {
      panel.skip();
      t0 -= 30000;
      grown = true;
    },
    enter(now) {
      t0 = now;
      panel.enter(now);
      size();
    },
    exit() {
      panel.exit?.();
    },
    frame(now) {
      panel.frame(now);
      draw((now - t0) / 1000);
    },
    destroy() {
      panel.destroy?.();
    },
  };
}
