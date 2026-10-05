import { hostComputerNoun } from '@hq/platform';

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

export function ease(u: number): number {
  return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

export function rnd(n: number): number {
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

/** Screens 01-03 share one title position so the heading never shifts. */
export function copyTop(height = vh()): number {
  return Math.max(56, Math.round(height * 0.13));
}

/**
 * Content under the title keeps a near-fixed gap: on a tall window it may
 * drift down by at most `extra`, and the rest of the spare room goes below.
 */
export function placeUnder(top: number, bottom: number, blockH: number, extra: number): number {
  return Math.round(top + Math.min(extra, Math.max(0, (bottom - top - blockH) / 2)));
}

/** The forward button sits right under each screen's content. */
export const NAVH = 44;
const NAVGAP = 44;
/** Room kept above the bottom edge (Back / the install card). */
export const FLOOR = 64;
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

export const pointer = { x: -9999, y: -9999, lastMove: -1e9 };

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

export function createSkyline(cv: HTMLCanvasElement, keepOut: () => KeepOut, RISE0: number) {
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
    ctx.fillStyle = '#fff';
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
    const { y, th, treeTop } = at;
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
    const railTop = Math.round(cy + orbitH / 2 + GAP2);
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

/** KEYBOARD_ROWS from intro-sequence.ts: a compact ANSI Mac layout, widths in key units. */
export const KEYBOARD_ROWS: KeyDef[][] = (() => {
  const L = (str: string): KeyDef[] => str.split('').map((k) => ({ id: k.toLowerCase(), label: k }));
  const mac = hostComputerNoun() === 'Mac';
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
})();

export const CHORD = ['alt', 'shift', 'o'] as const;

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
    const start = placeUnder(top, bottom, block, 30);
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
    const ft = placeUnder(y + ch + GAP1, H - FLOOR, fh + NAVGAP + NAVH, 30);
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
  };
}

// ---------------------------------------------------------------------------
// Panels that are not story screens (the connector import, the post-ready
// tutorial steps): centred, no timeline beyond the copy's own fade.
// ---------------------------------------------------------------------------

export function createPanelEngine(block: HTMLElement, options: { reveal: () => void }): SceneEngine {
  let t0 = 0;
  let revealed = false;
  let active = false;
  let placedHeight = -1;
  let observer: ResizeObserver | null = null;
  function size() {
    const H = vh();
    const bh = rect(block).height;
    placedHeight = bh;
    block.style.top = `${Math.max(56, Math.round((H - bh) / 2))}px`;
  }
  // A panel's content can change height after it is shown (the company step
  // goes from "Getting things ready…" to its form, then to the plan cards).
  // Centre it again whenever that happens, not only on enter and window
  // resize; otherwise it keeps the short block's position and runs off the
  // bottom of the window.
  function watch() {
    if (observer || typeof ResizeObserver === 'undefined') return;
    observer = new ResizeObserver(() => {
      if (active && rect(block).height !== placedHeight) size();
    });
    observer.observe(block);
  }
  return {
    size,
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
