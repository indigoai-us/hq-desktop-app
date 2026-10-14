// @vitest-environment happy-dom
// The sunrise's frame loop must stop once the component is gone, even when the
// bloom callback is what removed it (the page swaps the sunrise for the brief).
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BriefDawn from "./BriefDawn.svelte";

let target: HTMLElement;

afterEach(() => {
  target?.remove();
  vi.restoreAllMocks();
});

describe("BriefDawn frame loop", () => {
  it("unmounting from onbloomdone ends the loop without another prop read or frame", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    // happy-dom has no 2d canvas; a recording stub is enough for the loop.
    const gradient = { addColorStop() {} };
    const ctx = new Proxy({}, { get: (_t, k) => (String(k).startsWith("create") ? () => gradient : () => undefined), set: () => true }) as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 300 });

    target = document.createElement("div");
    document.body.appendChild(target);

    // Props read through a getter, like the page's `dawn.phase`: null after the swap.
    let dawn: { phase: "ready"; progress: number } | null = { phase: "ready", progress: 1 };
    const reads: string[] = [];
    let app: ReturnType<typeof mount> | null = null;
    const props = {
      get phase() {
        reads.push("phase");
        return dawn!.phase;
      },
      get progress() {
        reads.push("progress");
        return dawn!.progress;
      },
      onbloomdone() {
        dawn = null;
        if (app) unmount(app);
        app = null;
      },
    };
    app = mount(BriefDawn, { target, props });
    flushSync();
    expect(frames.length).toBe(1);

    // Drive frames until the bloom fires and unmounts the component.
    let now = 0;
    for (let i = 0; i < 400 && app; i += 1) {
      const cb = frames[frames.length - 1];
      now += 16;
      cb(now);
    }
    expect(app).toBeNull();
    const scheduled = frames.length;
    const readsBefore = reads.length;

    // Any frame still queued runs without touching the props or queuing more.
    expect(() => frames[frames.length - 1](now + 16)).not.toThrow();
    expect(frames.length).toBe(scheduled);
    expect(reads.length).toBe(readsBefore);
  });
});
