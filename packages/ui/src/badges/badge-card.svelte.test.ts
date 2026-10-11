// @vitest-environment happy-dom
/**
 * The badge card (owner decision 2026-10-08, "All three, in that order"):
 * step 1, a "View card" button on the badge detail page opens the foil card
 * on a dark stage, tilting toward the pointer. WebGPU when the webview has
 * it; otherwise the static card. Reduced motion keeps it flat.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BadgeCard from "./BadgeCard.svelte";
import BadgeCardModal from "./BadgeCardModal.svelte";
import BadgeDetailPane from "./BadgeDetailPane.svelte";
import { BADGE_BY_ID, type ResolvedBadge } from "./badge-catalog.js";
import {
  REVEAL_FLIP_MS,
  REVEAL_GLOW_MS,
  cardAccessibleLabel,
  cardNumber,
  cardTierLabel,
  cardTilt,
  pointerOnCard,
} from "./badge-card.js";
import { FOIL_WGSL, foilUsers } from "./foil-gpu.js";
import { shortcutsSuspended } from "../common/keyboard-shortcuts.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (file: string) => readFileSync(join(here, file), "utf8");
const styleOf = (file: string) => {
  const src = read(file);
  return src.slice(src.indexOf("<style"));
};

const liftoff: ResolvedBadge = { def: BADGE_BY_ID.liftoff, tier: 2, earnedAt: "2026-10-06" };
const founding: ResolvedBadge = { def: BADGE_BY_ID.founding, tier: 3, earnedAt: "2026-03-02" };

const mounted: Array<ReturnType<typeof mount>> = [];
let host: HTMLElement;

function setMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function setGpu(gpu: unknown): void {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => gpu });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

beforeEach(() => {
  setMotion(false);
  setGpu(undefined);
  host = document.createElement("div");
  host.className = "desktop-shell";
  document.body.appendChild(host);
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("card words", () => {
  it("numbers the card in the set, names the tier, and says it all to a screen reader", () => {
    expect(cardNumber("founding")).toBe("No. 001 / 015");
    expect(cardNumber("liftoff")).toBe("No. 004 / 015");
    expect(cardNumber("nope")).toBe("");
    expect(cardTierLabel(2)).toBe("Tier II · Silver");
    expect(cardTierLabel("L")).toBe("Legendary");
    expect(cardAccessibleLabel(liftoff)).toBe("Liftoff card, Silver. Deploys that went live. Earned Oct 6, 2026.");
  });

  it("tilts toward the pointer, eased in across the approach and capped", () => {
    const rect = { left: 0, top: 0, width: 200, height: 280 };
    const over = pointerOnCard(rect, 200, 0);
    expect(over).toEqual({ x: 1, y: -1, near: 1 });
    expect(cardTilt(over)).toEqual({ x: 0.16, y: 0.12 });
    expect(pointerOnCard(rect, 100, 140).near).toBe(1);
    expect(pointerOnCard(rect, 224, 140).near).toBeCloseTo(0.5);
    expect(pointerOnCard(rect, 300, 140).near).toBe(0);
    expect(cardTilt(pointerOnCard(rect, 900, 140))).toEqual({ x: 0, y: -0 });
  });
});

describe("BadgeCard", () => {
  it("is the static card without WebGPU, with the card's words and an accessible name", async () => {
    const renders: string[] = [];
    mounted.push(mount(BadgeCard, { target: host, props: { badge: liftoff, onrender: (m: string) => renders.push(m) } }));
    await settle();
    const card = host.querySelector('[data-testid="badge-card"]') as HTMLElement;
    expect(card.dataset.render).toBe("static");
    expect(renders).toEqual(["static"]);
    expect(card.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(cardAccessibleLabel(liftoff));
    const face = card.querySelector(".face")!;
    expect(face.getAttribute("aria-hidden")).toBe("true");
    expect(face.textContent).toContain("No. 004 / 015");
    expect(face.textContent).toContain("Liftoff");
    expect(face.textContent).toContain("Deploys that went live.");
    expect(face.textContent).toContain("Tier II · Silver");
    expect(face.textContent).toContain("Oct 6, 2026");
    expect(card.querySelector(".card")?.classList.contains("t2")).toBe(true);
  });

  it("asks for a low-power adapter and stays static when there is none", async () => {
    const requestAdapter = vi.fn(async () => null);
    setGpu({ requestAdapter, getPreferredCanvasFormat: () => "bgra8unorm" });
    mounted.push(mount(BadgeCard, { target: host, props: { badge: founding } }));
    await settle();
    expect(requestAdapter).toHaveBeenCalledWith({ powerPreference: "low-power" });
    expect(host.querySelector('[data-testid="badge-card"]')?.getAttribute("data-render")).toBe("static");
    unmount(mounted.pop()!);
    expect(foilUsers()).toBe(0);
  });

  it("draws the foil with WebGPU and frees the GPU when it goes", async () => {
    const destroyed: string[] = [];
    let draws = 0;
    const texture = { width: 0, height: 0, destroy: () => destroyed.push("texture"), createView: () => ({}) };
    const device = {
      createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
      createRenderPipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
      createSampler: () => ({}),
      createTexture: (d: { size: number[] }) => Object.assign(texture, { width: d.size[0], height: d.size[1] }),
      createBuffer: () => ({ destroy: () => destroyed.push("buffer") }),
      createBindGroup: () => ({}),
      createCommandEncoder: () => ({
        beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw: () => (draws += 1), end() {} }),
        finish: () => ({}),
      }),
      queue: { writeBuffer() {}, submit() {}, copyExternalImageToTexture() {} },
      lost: new Promise(() => {}),
      destroy: () => destroyed.push("device"),
    };
    setGpu({ requestAdapter: async () => ({ requestDevice: async () => device }), getPreferredCanvasFormat: () => "bgra8unorm" });
    (globalThis as Record<string, unknown>).GPUTextureUsage = { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 };
    (globalThis as Record<string, unknown>).GPUBufferUsage = { UNIFORM: 64, COPY_DST: 8 };
    const context = { configure: vi.fn(), unconfigure: () => destroyed.push("context"), getCurrentTexture: () => ({ createView: () => ({}) }) };
    const original = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
      return kind === "webgpu" ? (context as never) : (original.call(this, kind as "2d", ...(rest as [])) as never);
    });
    mounted.push(mount(BadgeCard, { target: host, props: { badge: liftoff } }));
    await settle();
    const card = host.querySelector('[data-testid="badge-card"]') as HTMLElement;
    expect(card.dataset.render).toBe("gpu");
    expect(card.querySelector(".card")?.classList.contains("gpu")).toBe(true);
    expect(context.configure).toHaveBeenCalledWith(expect.objectContaining({ alphaMode: "opaque" }));
    expect(foilUsers()).toBe(1);
    // The light follows the pointer: a frame draws the foil.
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    const before = draws;
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10, isPrimary: true }));
    frames.shift()!(performance.now() + 16);
    expect(draws).toBeGreaterThan(before);
    unmount(mounted.pop()!);
    await settle();
    expect(destroyed).toEqual(expect.arrayContaining(["context", "texture", "buffer", "device"]));
    expect(foilUsers()).toBe(0);
    // Closed: nothing draws any more.
    const after = draws;
    frames.forEach((cb) => cb(performance.now() + 32));
    expect(draws).toBe(after);
  });

  it("tilts toward the pointer, and stops the loop while the window is hidden", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    mounted.push(mount(BadgeCard, { target: host, props: { badge: liftoff, width: 280 } }));
    await settle();
    const cardEl = host.querySelector(".card") as HTMLElement;
    cardEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 392, right: 280, bottom: 392, x: 0, y: 0, toJSON() {} });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 280, clientY: 0, isPrimary: true }));
    expect(frames.length).toBe(1);
    frames.shift()!(performance.now() + 50);
    const tilt = host.querySelector(".tilt") as HTMLElement;
    expect(tilt.style.transform).toMatch(/rotateX\(0\.0\d+rad\) rotateY\(0\.0\d+rad\)/);
    expect(frames.length).toBe(1);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancel).toHaveBeenCalled();
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });

  it("stays flat with reduced motion", async () => {
    setMotion(true);
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => frames.push(cb));
    mounted.push(mount(BadgeCard, { target: host, props: { badge: liftoff, width: 280 } }));
    await settle();
    const cardEl = host.querySelector(".card") as HTMLElement;
    cardEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 392, right: 280, bottom: 392, x: 0, y: 0, toJSON() {} });
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 280, clientY: 0, isPrimary: true }));
    frames.shift()?.(performance.now() + 50);
    expect((host.querySelector(".tilt") as HTMLElement).style.transform).toContain("rotateX(0.0000rad) rotateY(0.0000rad)");
  });
});

describe("View card on the badge detail page", () => {
  it("opens the card on a dark stage; Escape and the close button close it and focus goes back", async () => {
    mounted.push(mount(BadgeDetailPane, { target: host, props: { badge: liftoff, owner: "Maya Chen" } }));
    await settle();
    const button = host.querySelector('[data-testid="badge-detail-view-card"]') as HTMLButtonElement;
    expect(button.textContent?.trim()).toBe("View card");
    expect(button.querySelector("svg")).not.toBeNull();
    button.click();
    await settle();
    const modal = document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal.parentElement).toBe(host);
    const dialog = modal.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Liftoff card, Silver");
    expect(modal.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe(cardAccessibleLabel(liftoff));
    expect(modal.querySelector('[data-testid="badge-card-owner"]')?.textContent).toBe("Earned by Maya Chen");
    expect(shortcutsSuspended()).toBe(true);
    const close = modal.querySelector('[data-testid="badge-card-close"]') as HTMLButtonElement;
    expect(document.activeElement).toBe(close);

    // Tab stays inside.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.activeElement).toBe(close);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    expect(document.querySelector('[data-testid="badge-card-modal"]')).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(shortcutsSuspended()).toBe(false);

    button.click();
    await settle();
    (document.querySelector('[data-testid="badge-card-close"]') as HTMLButtonElement).click();
    await settle();
    expect(document.querySelector('[data-testid="badge-card-modal"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("card reveal staging", () => {
  it("glows, turns the card over, then lets it tilt", async () => {
    vi.useFakeTimers();
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: founding, reveal: true, onclose: () => {} } }));
    flushSync();
    const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement;
    expect(modal().dataset.phase).toBe("glow");
    expect(modal().querySelector(".bc-back")).not.toBeNull();
    vi.advanceTimersByTime(REVEAL_GLOW_MS);
    flushSync();
    expect(modal().dataset.phase).toBe("flip");
    vi.advanceTimersByTime(REVEAL_FLIP_MS);
    flushSync();
    expect(modal().dataset.phase).toBe("done");
  });

  it("goes straight to the face with reduced motion", () => {
    setMotion(true);
    mounted.push(mount(BadgeCardModal, { target: host, props: { open: true, badge: founding, reveal: true, onclose: () => {} } }));
    flushSync();
    expect((document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement).dataset.phase).toBe("done");
  });
});

describe("card design contract", () => {
  it("is dark in both themes: no theme variables on the card or its stage", () => {
    for (const file of ["BadgeCard.svelte", "BadgeCardModal.svelte"]) {
      expect(styleOf(file)).not.toMatch(/var\(--v4-|var\(--t\d|prefers-color-scheme|data-force-theme/);
    }
    expect(styleOf("BadgeCard.svelte")).toContain("background: #17161A;");
    expect(styleOf("BadgeCardModal.svelte")).toContain("background: rgba(9, 9, 11, 0.92);");
  });

  it("sets the card in Geist and Geist Mono, never JetBrains Mono", () => {
    const css = styleOf("BadgeCard.svelte");
    expect(css).toContain('"Geist Mono Variable", "Geist Mono"');
    expect(css).toContain('font-family: "Geist"');
    expect(css).not.toMatch(/JetBrains/i);
  });

  it("draws the art from the app's full ASCII data in the dark palette", () => {
    const src = read("BadgeCard.svelte");
    expect(src).toContain('import("./full-ascii-data.js")');
    expect(src).not.toContain("full-ascii-data-light");
    expect(src).toContain('theme: "dark"');
  });

  it("keeps the vgpu attribution with the shader and in the repo notices", () => {
    expect(read("foil-gpu.ts")).toMatch(/vercel-labs\/vgpu[\s\S]*MIT License, Copyright \(c\) 2025\s+\* Vercel, Inc\./);
    expect(FOIL_WGSL).toContain('Adapted from the "holographic-card" example in vercel-labs/vgpu (MIT License');
    const root = join(here, "../../../..");
    expect(readFileSync(join(root, "NOTICE"), "utf8")).toContain("vercel-labs/vgpu");
    expect(readFileSync(join(root, "LICENSES/MIT-vgpu.txt"), "utf8")).toContain("Copyright (c) 2025 Vercel, Inc.");
  });

  it("only brackets where the light is, with no dots, and a smooth fade under the text", () => {
    expect(FOIL_WGSL).toContain("only the brackets near the light show up");
    expect(FOIL_WGSL).toContain("let textFade = fadeBottom * fadeBottom * fadeTop * fadeTop;");
    // `dot()` is the vector product; a dot pattern would be named "dots".
    expect(FOIL_WGSL).not.toMatch(/\bdots\b/i);
  });
});
