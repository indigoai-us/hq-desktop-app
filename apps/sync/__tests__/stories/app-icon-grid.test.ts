/**
 * App icon sits on Apple's macOS icon grid — and still carries HQ's artwork.
 *
 * HQ shipped a full-bleed 1024x1024 square with fully opaque corners, so the
 * Dock rendered it as a hard-edged square that read visibly larger than the
 * inset squircles every other Mac app ships. macOS does not mask or inset app
 * icons, so the shape and margin have to be baked into the artwork.
 *
 * These tests decode the generated PNG and assert the geometry directly, so a
 * future full-bleed regeneration fails here instead of shipping. They also pin
 * the artwork's colour: `src-tauri/icons/app-icon.svg` is a stale near-black
 * design that does NOT match the shipped pink/violet gradient, and regenerating
 * from it silently rebrands the app — the colour assertion is what catches that.
 */

import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Apple's macOS app-icon grid on a 1024 canvas.
const CANVAS = 1024;
const BODY = 824;
const MARGIN = (CANVAS - BODY) / 2; // 100

const repoRoot = join(process.cwd());
const iconPath = join(repoRoot, 'src-tauri/icons/app-icon.png');

type Decoded = { width: number; height: number; rgba: Buffer };

/**
 * Minimal PNG decoder: 8-bit RGBA, non-interlaced only.
 *
 * Deliberately narrow — it exists to read one file this repo generates, not to
 * be a general decoder. It throws loudly on any other format rather than
 * guessing, so a change in what `tauri icon` emits surfaces as a clear failure
 * instead of a silently wrong measurement.
 */
function decodePng(buf: Buffer): Decoded {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(SIG)) throw new Error('not a PNG');

  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let off = 8;

  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colorType, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      if (depth !== 8) throw new Error(`expected 8-bit, got ${depth}`);
      if (colorType !== 6) throw new Error(`expected RGBA (6), got colour type ${colorType}`);
      if (interlace !== 0) throw new Error('interlaced PNG unsupported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len; // len + type + data + crc
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);

    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0; // left
      const b = prev[x]; // up
      const c = x >= 4 ? prev[x - 4] : 0; // up-left
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      out[x] = v & 0xff;
    }
  }

  return { width, height, rgba };
}

const alphaAt = (d: Decoded, x: number, y: number) => d.rgba[(y * d.width + x) * 4 + 3];

function opaqueBounds(d: Decoded, threshold = 0) {
  let minX = d.width;
  let minY = d.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < d.height; y++) {
    for (let x = 0; x < d.width; x++) {
      if (alphaAt(d, x, y) > threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

function meanOpaqueRgb(d: Decoded) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = 0; y < d.height; y += 4) {
    for (let x = 0; x < d.width; x += 4) {
      const i = (y * d.width + x) * 4;
      if (d.rgba[i + 3] > 200) {
        r += d.rgba[i];
        g += d.rgba[i + 1];
        b += d.rgba[i + 2];
        n++;
      }
    }
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), samples: n };
}

describe('app icon: Apple macOS icon grid', () => {
  it('has a generated source at the full 1024 canvas', () => {
    expect(existsSync(iconPath), 'run scripts/generate-app-icon.py').toBe(true);
    const d = decodePng(readFileSync(iconPath));
    expect([d.width, d.height]).toEqual([CANVAS, CANVAS]);
  });

  it('has fully transparent corners — the regression that shipped', () => {
    const d = decodePng(readFileSync(iconPath));
    const corners = [
      alphaAt(d, 0, 0),
      alphaAt(d, CANVAS - 1, 0),
      alphaAt(d, 0, CANVAS - 1),
      alphaAt(d, CANVAS - 1, CANVAS - 1),
    ];
    // Opaque corners mean a full-bleed square: the exact defect that made HQ
    // look oversized and hard-edged next to every other Dock icon.
    expect(corners).toEqual([0, 0, 0, 0]);
  });

  it('insets the body by the grid margin on every side', () => {
    const d = decodePng(readFileSync(iconPath));
    const { minX, minY, maxX, maxY } = opaqueBounds(d);
    expect({ minX, minY }).toEqual({ minX: MARGIN, minY: MARGIN });
    expect({ maxX, maxY }).toEqual({ maxX: MARGIN + BODY - 1, maxY: MARGIN + BODY - 1 });
  });

  it('rounds the corners rather than shipping a plain square', () => {
    const d = decodePng(readFileSync(iconPath));
    // One row inside the body's top edge, opacity must start well inward of the
    // body edge — that inset IS the corner arc. A square would start at MARGIN.
    const y = MARGIN + 1;
    let firstOpaque = -1;
    for (let x = 0; x < CANVAS; x++) {
      if (alphaAt(d, x, y) > 0) {
        firstOpaque = x;
        break;
      }
    }
    expect(firstOpaque).toBeGreaterThan(MARGIN + 40);
  });

  it('still carries HQ artwork, not the stale near-black app-icon.svg design', () => {
    const d = decodePng(readFileSync(iconPath));
    const { r, g, b, samples } = meanOpaqueRgb(d);
    expect(samples).toBeGreaterThan(1000);
    // Shipped brand mark is a light pink/violet gradient (~212,141,227). The
    // stale SVG rasterises to ~(52,44,50); regenerating from it would rebrand
    // the app, so assert we are nowhere near that.
    expect(r).toBeGreaterThan(170);
    expect(b).toBeGreaterThan(190);
    expect(r + g + b).toBeGreaterThan(400);
  });
});

describe('app icon: pipeline is reproducible and the stale source is defused', () => {
  it('checks in the master artwork the generator reads', () => {
    expect(existsSync(join(repoRoot, 'src-tauri/icons/source/app-icon-master.png'))).toBe(true);
  });

  it('pins the grid constants in the generator', () => {
    const src = readFileSync(join(repoRoot, 'scripts/generate-app-icon.py'), 'utf8');
    expect(src).toMatch(/CANVAS = 1024/);
    expect(src).toMatch(/BODY = 824/);
    expect(src).toMatch(/RADIUS = 185\.4/);
    // BOX, not LANCZOS: a coverage mask must be area-averaged or it rings and
    // pushes faint alpha outside the grid.
    expect(src).toMatch(/Image\.BOX/);
  });

  it('marks app-icon.svg stale so nobody regenerates a rebrand from it', () => {
    const svg = readFileSync(join(repoRoot, 'src-tauri/icons/app-icon.svg'), 'utf8');
    expect(svg).toMatch(/STALE/);
    expect(svg).toMatch(/DO NOT REGENERATE/i);
  });
});
