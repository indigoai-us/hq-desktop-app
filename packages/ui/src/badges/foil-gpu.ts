/**
 * Holographic foil for the badge card, drawn with WebGPU.
 *
 * Adapted from the "holographic-card" example in vercel-labs/vgpu
 * (https://github.com/vercel-labs/vgpu), MIT License, Copyright (c) 2025
 * Vercel, Inc. The license text is in LICENSES/MIT-vgpu.txt and the
 * attribution in NOTICE. The shader is the approved design's
 * (hq-accomplishment-badges/assets/foil-cards), kept as-is; the app always
 * draws the Color set (mono = 0).
 *
 * One low-power device and one pipeline are shared by every open card and
 * released when the last card goes. Each card owns its canvas context,
 * uniform buffer and badge texture and frees them in dispose(). A card only
 * draws when asked to (its owner runs the loop while the light or the tilt is
 * still moving), so nothing renders while the card is at rest or closed.
 *
 * When WebGPU is missing (the macOS 13 webview has none), the adapter is
 * refused, the shader fails to build, or the device is lost, `ready` resolves
 * false and the card stays the static version.
 */

// Minimal structural types: the package carries no WebGPU type definitions.
/* eslint-disable @typescript-eslint/no-explicit-any */
type Gpu = any;

export const FOIL_WGSL = `// Holographic foil for one badge card.
// Adapted from the "holographic-card" example in vercel-labs/vgpu (MIT License,
// Copyright (c) 2025 Vercel, Inc.; full text in LICENSES/MIT-vgpu.txt and NOTICE). The lighting,
// diffraction, pearlescence, grain and etched-contour model are kept as-is; the
// triangle artwork is replaced by the badge circle, the card fills the canvas
// (CSS does the 3D tilt), and mono cards reflect a bronze/silver/gold (or HQ gradient) foil.
struct Params {
  resolution: vec2f,
  tilt: vec2f,
  pointer: vec2f,
  hover: f32,
  mono: f32,
  art: vec4f,   // xy = badge centre, z = half size of the art square, w = where the text starts (card units)
  base0: vec4f, // mono foil palette: light, dark, light stops of the tier metal (w = half-width of the text column)
  base1: vec4f,
  base2: vec4f,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var artTex: texture_2d<f32>;
@group(0) @binding(2) var linear: sampler;

struct VsOut { @builtin(position) position: vec4f, @location(0) uv: vec2f }
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(xy, 0, 1);
  out.uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
  return out;
}

fn roundedBox(p: vec2f, halfSize: vec2f, radius: f32) -> f32 {
  let q = abs(p) - halfSize + radius;
  return length(max(q, vec2f(0))) + min(max(q.x, q.y), 0.0) - radius;
}
fn segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let v = b - a;
  return length(p - a - v * clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0));
}
fn stroke(distance: f32, width: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(width, width + aa, abs(distance));
}
fn wavelengthColor(wavelength: f32) -> vec3f {
  let response = (vec3f(wavelength) - vec3f(0.610, 0.545, 0.460)) / vec3f(0.045, 0.038, 0.032);
  let visible = smoothstep(0.380, 0.410, wavelength) * (1.0 - smoothstep(0.700, 0.780, wavelength));
  return exp(-0.5 * response * response) * visible;
}
fn diffraction(across: vec2f, lightAndView: vec2f, spacing: f32) -> vec3f {
  let pathDifference = spacing * abs(dot(lightAndView, across));
  let along = dot(lightAndView, vec2f(-across.y, across.x));
  let envelope = exp(-along * along / 0.36);
  var reflected = vec3f(0);
  for (var order = 1; order <= 3; order++) {
    let m = f32(order);
    reflected += wavelengthColor(pathDifference / m) / (m * m);
  }
  return reflected * envelope;
}
fn pearlColor(phase: f32) -> vec3f {
  return vec3f(0.55, 0.52, 0.64) + vec3f(0.43, 0.40, 0.34) * cos(6.2831853 * (phase + vec3f(0.05, 0.38, 0.63)));
}
// Mono cards: the same pearl phase, mapped onto the tier's metal palette instead of a rainbow.
fn metalColor(phase: f32) -> vec3f {
  let t = 0.5 + 0.5 * cos(6.2831853 * phase);
  return select(mix(params.base1.rgb, params.base2.rgb, (t - 0.5) * 2.0), mix(params.base0.rgb, params.base1.rgb, t * 2.0), t < 0.5);
}
fn foilPearl(phase: f32) -> vec3f {
  return mix(pearlColor(phase), metalColor(phase) * 1.25, params.mono);
}
fn foilDiffraction(d: vec3f) -> vec3f {
  return mix(d, dot(d, vec3f(0.3333)) * (params.base0.rgb + params.base2.rgb) * 0.7, params.mono);
}
fn grain(point: vec2f) -> f32 {
  let p = vec2u(abs(point) * 2400.0);
  var n = (p.x * 1597334677u) ^ (p.y * 3812015801u);
  n = (n ^ (n >> 16u)) * 2246822519u;
  return f32(n & 1023u) / 1023.0 - 0.5;
}
fn etchedPhase(p: vec2f) -> f32 {
  let warp = vec2f(sin(p.y * 7.0 + sin(p.x * 4.0)) * 0.085, sin(p.x * 6.0 - p.y * 3.0) * 0.07);
  let q = p + warp - vec2f(0.13, 0.08);
  let radius = length(q * vec2f(1.0, 0.76));
  return radius * 142.0 + sin(atan2(q.y, q.x) * 3.0 + radius * 8.0) * 1.7;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let halfCard = vec2f(0.64, 0.896);
  let p = (uv - 0.5) * halfCard * 2.0;
  let sx = sin(params.tilt.y);
  let cx = cos(params.tilt.y);
  let sy = sin(params.tilt.x);
  let cy = cos(params.tilt.x);
  let right = vec3f(cy, 0, -sy);
  let down = vec3f(sy * sx, cx, cy * sx);
  let normal = cross(right, down);
  let eye = vec3f(0, 0, 4.5);
  let hit = right * p.x + down * p.y;
  let aa = max(length(fwidth(p)), 0.0006);
  let edge = roundedBox(p, halfCard, 0.055);
  let mono = params.mono;

  // Light: a diagonal band times a soft spotlight that follow the pointer.
  let hover = clamp(params.hover, 0.0, 1.0);
  let lightCenter = params.pointer * halfCard;
  let delta = p - lightCenter;
  let sweepDistance = delta.x * 0.72 + delta.y * 0.52 + sin(p.y * 4.0 + p.x * 3.0) * 0.08;
  let bandDistance = sweepDistance / 0.36;
  let lightBand = exp(-bandDistance * bandDistance);
  let glintDistance = sweepDistance / 0.085;
  let glint = exp(-glintDistance * glintDistance);
  let spotlight = exp(-dot(delta * vec2f(1.05, 0.72), delta * vec2f(1.05, 0.72)) * 2.6);
  let light = lightBand * spotlight * hover;
  let lightDirection = normalize(vec3f(lightCenter, 1.2) - hit);
  let viewDirection = normalize(eye - hit);
  let lightAndView = vec2f(dot(lightDirection + viewDirection, right), dot(lightDirection + viewDirection, down));
  let illumination = max(dot(normal, lightDirection), 0.0) * max(dot(normal, viewDirection), 0.0);
  let tint = mix(vec3f(0.72, 0.76, 0.8), (params.base0.rgb + params.base2.rgb) * 0.5, params.mono);
  let noise = grain(p + vec2f(2));

  let artMask = 1.0 - smoothstep(params.art.z * 0.97 - aa, params.art.z * 0.97, length(p - params.art.xy));
  // Card: flat #17161A for both directions; only the light adds to it.
  var color = vec3f(0.0902, 0.0863, 0.1020) + 0.008 * (0.2 - p.y);
  color += noise * (0.022 + light * 0.085) * (1.0 - artMask * 0.7);
  color += light * (vec3f(0.045) + tint * 0.065);

  // Regions: the badge circle stays clean; the etched contours surround it and fade under the text.
  let q = p - params.art.xy;
  let r = length(q);
  let ringR = params.art.z * 0.97;
  let inside = 1.0 - smoothstep(ringR - aa, ringR, r);
  // fade under the title/description, and under the header row
  let fadeBottom = 1.0 - smoothstep(params.art.w - 0.26, params.art.w + 0.10, p.y);
  let fadeTop = smoothstep(-0.82, -0.56, p.y);
  let textFade = fadeBottom * fadeBottom * fadeTop * fadeTop; // long, eased fade toward the text
  // Corner brackets sit on clean ground: the etched rings clear a few pixels around them.
  let corner = vec2f(abs(p.x) - params.base0.w, abs(q.y) - params.art.z);
  let bracketArm = 0.034;
  let bracketDist = min(segment(corner, vec2f(0), vec2f(-bracketArm, 0)), segment(corner, vec2f(0), vec2f(0, -bracketArm)));
  let bracketClear = smoothstep(0.006, 0.02, bracketDist);
  let outside = smoothstep(ringR * 1.06, ringR * 1.06 + aa * 1.5, r) * textFade * bracketClear;
  let radial = q / max(r, 0.00001);

  let contour = etchedPhase(p);
  let dx = dpdx(p);
  let dy = dpdy(p);
  let gradient = vec2f(dpdx(contour) * dy.y - dpdy(contour) * dx.y, dpdy(contour) * dx.x - dpdx(contour) * dy.x);
  let across = gradient / max(length(gradient), 0.00000001);
  let outerDiffraction = foilDiffraction(diffraction(across, lightAndView, 1.65) * illumination);
  let contours = stroke(sin(contour), 0.06, min(fwidth(contour), 1.0));
  let reveal = hover * (0.06 + 0.24 * spotlight + light * 1.15);
  let innerDiffraction = foilDiffraction(diffraction(radial, lightAndView, 1.35) * illumination);
  let pearlPhase = dot(lightAndView, vec2f(0.48, -0.32)) + p.y * 0.32 + contour * 0.003;
  let outerPearl = foilPearl(pearlPhase);
  let innerPearl = foilPearl(pearlPhase + dot(radial, lightAndView) * 0.32 + 0.12);
  let pearl = outerPearl * (1.0 - inside) + innerPearl * inside;

  let foilOffset = vec2f(0.007, -0.004) + params.tilt * 0.012;
  let foilPhase = etchedPhase(p - foilOffset);
  let foilLines = stroke(sin(foilPhase), 0.025, min(fwidth(foilPhase), 1.0));
  let sparkle = pow(max(noise + 0.5, 0.0), 24.0) * glint * spotlight * hover;

  // Colour is added on top of the dark card, exactly as on the original graphite card.
  color += pearl * light * 0.24 * (1.0 - inside * 0.5) * mix(0.2, 1.0, textFade);
  color += (pearl * 0.5 + vec3f(0.5) * (1.0 - inside)) * glint * spotlight * hover * 0.12;
  color += pearl * sparkle * 0.22;
  let outerFoil = vec3f(0.12, 0.14, 0.18) * (1.0 - mono * 0.5) + outerPearl * 0.65 + outerDiffraction * 0.12;
  color += contours * mix(0.65, 0.8, mono) * outside * outerFoil * reveal;
  color += foilLines * 0.65 * outside * (outerPearl + outerDiffraction * 0.2) * reveal * 0.22;

  // Thin foil ring just outside the badge, revealed by the light.
  let foilTint = outerPearl * 0.8 + vec3f(0.2) + outerDiffraction * 0.15;
  let foilRing = stroke(r - ringR * 1.03, 0.0007, aa * 0.5) * textFade;
  color += foilRing * foilTint * hover * (0.12 + light * 0.5);
  // Corner brackets around the badge, muted, revealed by hover like the etched contours.
  let bracket = stroke(bracketDist, 0.0013, aa * 0.6);
  // only the brackets near the light show up
  color = mix(color, vec3f(1.0), bracket * hover * clamp(pow(spotlight, 3.0) * 0.6 + light * 0.3, 0.0, 0.6));

  // The badge itself, with its ink catching the foil light.
  let auv = q / (2.0 * params.art.z) + 0.5;
  let art = textureSampleLevel(artTex, linear, clamp(auv, vec2f(0), vec2f(1)), 0.0);
  let ink = art.a * inside;
  color = mix(color, art.rgb, ink);
  // the badge is printed in foil too: its glyphs and fine concentric grooves catch the light
  let innerFoil = vec3f(0.12, 0.14, 0.18) + innerPearl * 0.65 + innerDiffraction * 0.12;
  color += ink * innerFoil * reveal * 0.5;
  let grooves = r * 220.0;
  color += stroke(sin(grooves), 0.05, min(fwidth(grooves), 1.0)) * inside * (1.0 - ink) * innerFoil * reveal * 0.3;
  color += ink * (innerPearl * light * mix(0.45, 0.2, mono) + innerDiffraction * reveal * 0.4
    + vec3f(0.6) * glint * spotlight * hover * mix(0.25, 0.1, mono));

  let rim = stroke(edge + 0.002, 0.0008, aa * 0.7);
  let rimLight = pow(max(0.0, 1.0 - length(delta) * 0.65), 3.0) * hover;
  color = mix(color, vec3f(0.25, 0.28, 0.32) + (outerPearl * 0.7 + tint * 0.3) * rimLight * 0.6, rim);
  return vec4f(clamp(color, vec3f(0), vec3f(1)), 1);
}
`;

/** Mono foil palettes per tier (light, dark, light). Unused by the Color set except base0.w. */
const FOIL_PALETTE: Readonly<Record<string, readonly string[]>> = {
  1: ["#ffd2ad", "#c9773f", "#f0b07f"],
  2: ["#ffffff", "#8d93a8", "#dfe3ee"],
  3: ["#fff0a8", "#b9850f", "#f6d36a"],
  L: ["#8a6cff", "#ff7ac0", "#ffc29a"],
};

interface Shared {
  device: Gpu;
  format: string;
  pipeline: Gpu;
  sampler: Gpu;
}

let shared: Promise<Shared> | null = null;
let users = 0;

function gpuApi(): Gpu | null {
  const nav = globalThis.navigator as Gpu;
  return nav && nav.gpu ? nav.gpu : null;
}

/** Whether this webview offers WebGPU at all. A true here can still end in the static card. */
export function webgpuAvailable(): boolean {
  return gpuApi() !== null;
}

async function init(): Promise<Shared> {
  const gpu = gpuApi();
  if (!gpu) throw new Error("WebGPU is not available");
  // Low power: the integrated GPU is plenty for one card and spares the battery.
  const adapter = await gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const format = gpu.getPreferredCanvasFormat();
  const module = device.createShaderModule({ code: FOIL_WGSL, label: "badge-card-foil" });
  const info = typeof module.getCompilationInfo === "function" ? await module.getCompilationInfo() : { messages: [] };
  const errors = (info.messages as Gpu[]).filter((m) => m.type === "error");
  if (errors.length) throw new Error(`Foil shader: ${errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("; ")}`);
  const pipeline = await device.createRenderPipelineAsync({
    label: "badge-card-foil",
    layout: "auto",
    vertex: { module, entryPoint: "vs_main" },
    fragment: { module, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({ minFilter: "linear", magFilter: "linear" });
  return { device, format, pipeline, sampler };
}

function acquire(): Promise<Shared> {
  users += 1;
  if (!shared) {
    const started = init();
    shared = started;
    // A failed start is not kept: the next card may try again.
    started.catch(() => {
      if (shared === started) shared = null;
    });
  }
  return shared;
}

function release(): void {
  users = Math.max(0, users - 1);
  if (users > 0 || !shared) return;
  const done = shared;
  shared = null;
  done.then((g) => g.device.destroy?.(), () => {});
}

/** Test seam: how many cards hold the shared device. */
export function foilUsers(): number {
  return users;
}

/** Where the light and the tilt are, in the shader's terms. */
export interface FoilState {
  /** Tilt in radians: x turns the card sideways, y up or down. */
  tiltX: number;
  tiltY: number;
  /** The light, -1..1 across the card. */
  lightX: number;
  lightY: number;
  /** How strongly the light is on the card, 0..1. */
  hover: number;
}

export interface FoilParts {
  /** The canvas the foil draws into, filling the card. */
  canvas: HTMLCanvasElement;
  /** The card element; its size is the canvas size. */
  card: HTMLElement;
  /** The badge art canvas (drawn by drawFullBadge), copied into a texture. */
  art: HTMLCanvasElement;
  /** The title, where the fade under the text starts and the brackets line up. */
  title: HTMLElement;
  tier: string;
}

export interface Foil {
  /** True once the foil can draw; false for the static card. */
  ready: Promise<boolean>;
  /** Re-read the layout after the card changes size. */
  measure(): void;
  /** Copy the badge art again after it was redrawn. */
  updateArt(): void;
  /** Draw one frame with this light and tilt. */
  draw(state: FoilState): void;
  /** Free the context, buffer and texture, and let go of the shared device. */
  dispose(): void;
}

function rgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** Optical correction: a letter's side bearing sits about 2.5px in from its text box. */
const BRACKET_INSET_PX = 2.5;

export function createFoil(parts: FoilParts, onlost?: () => void): Foil {
  const U = new Float32Array(24);
  let gpu: Shared | null = null;
  let ctx: Gpu = null;
  let buf: Gpu = null;
  let tex: Gpu = null;
  let bind: Gpu = null;
  let disposed = false;
  let last: FoilState = { tiltX: 0, tiltY: 0, lightX: 0.2, lightY: -0.25, hover: 0 };
  const held = gpuApi() ? (acquire(), true) : false;

  function bindArt(): void {
    if (!gpu || disposed) return;
    const { device } = gpu;
    const w = Math.max(1, parts.art.width);
    const h = Math.max(1, parts.art.height);
    if (!tex || tex.width !== w || tex.height !== h) {
      tex?.destroy?.();
      const usage = (globalThis as Gpu).GPUTextureUsage;
      tex = device.createTexture({
        label: "badge-card-art",
        size: [w, h],
        format: "rgba8unorm",
        usage: usage.TEXTURE_BINDING | usage.COPY_DST | usage.RENDER_ATTACHMENT,
      });
      bind = device.createBindGroup({
        layout: gpu.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: tex.createView() },
          { binding: 2, resource: gpu.sampler },
        ],
      });
    }
    device.queue.copyExternalImageToTexture({ source: parts.art }, { texture: tex }, [w, h]);
  }

  function measure(): void {
    if (!gpu || disposed) return;
    const { card, canvas, art, title } = parts;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ax = ((art.offsetLeft + art.offsetWidth / 2) / w - 0.5) * 1.28;
    const ay = ((art.offsetTop + art.offsetHeight / 2) / h - 0.5) * 1.792;
    U.set([canvas.width, canvas.height], 0);
    U.set([ax, ay, (art.offsetWidth / 2 / w) * 1.28, (title.offsetTop / h - 0.5) * 1.792 - 0.05], 8);
    const pal = (FOIL_PALETTE[parts.tier] ?? FOIL_PALETTE[1]).map(rgb);
    pal.forEach((c, i) => U.set(c, 12 + i * 4));
    const pad = parseFloat(getComputedStyle(title).paddingLeft) || 0;
    const textX = title.offsetLeft + pad + BRACKET_INSET_PX;
    U[15] = (0.5 - textX / w) * 1.28; // bracket x = the text's edges
    U[7] = 0; // Color set
    draw(last);
  }

  function draw(state: FoilState): void {
    last = state;
    if (!gpu || disposed || !bind || !parts.canvas.width) return;
    U.set([state.tiltX, state.tiltY, state.lightX, state.lightY, state.hover], 2);
    const { device } = gpu;
    device.queue.writeBuffer(buf, 0, U);
    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    pass.setPipeline(gpu.pipeline);
    pass.setBindGroup(0, bind);
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    try {
      ctx?.unconfigure?.();
    } catch {
      // The context may already be gone with the canvas.
    }
    tex?.destroy?.();
    buf?.destroy?.();
    tex = buf = bind = ctx = null;
    gpu = null;
    if (held) release();
  }

  const ready: Promise<boolean> = !held
    ? Promise.resolve(false)
    : (shared as Promise<Shared>).then(
        (g) => {
          if (disposed) return false;
          try {
            const context = parts.canvas.getContext("webgpu") as Gpu;
            if (!context) return false;
            context.configure({ device: g.device, format: g.format, alphaMode: "opaque" });
            const usage = (globalThis as Gpu).GPUBufferUsage;
            buf = g.device.createBuffer({ label: "badge-card-params", size: U.byteLength, usage: usage.UNIFORM | usage.COPY_DST });
            ctx = context;
            gpu = g;
            bindArt();
            g.device.lost?.then((info: Gpu) => {
              if (disposed || info?.reason === "destroyed") return;
              console.info("[badges] WebGPU device lost; showing the static card.", info?.message ?? "");
              onlost?.();
            });
            measure();
            return true;
          } catch (err) {
            console.info("[badges] Foil card: showing the static card.", (err as Error)?.message ?? err);
            return false;
          }
        },
        (err: unknown) => {
          console.info("[badges] Foil card: showing the static card.", (err as Error)?.message ?? err);
          return false;
        },
      );

  return { ready, measure, updateArt: bindArt, draw, dispose };
}
