// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { HQ_GLYPHS, asciiDecode, decodeFrame, decodeMs, hoverTilt, pointerOn, tiltTransform } from "./brief-hover.js";

describe("brief hover", () => {
  it("maps the pointer to -1..1 from the element's center and clamps outside it", () => {
    const r = { left: 100, top: 100, width: 200, height: 100 };
    expect(pointerOn(r, 200, 150)).toEqual({ x: 0, y: 0 });
    expect(pointerOn(r, 300, 100)).toEqual({ x: 1, y: -1 });
    expect(pointerOn(r, 900, 900)).toEqual({ x: 1, y: 1 });
  });

  it("tilts reward cards a third as far as the badge card, and not at all without presence", () => {
    expect(hoverTilt({ x: 1, y: -1 }, 1)).toEqual({ x: 0.055, y: 0.04 });
    expect(hoverTilt({ x: 1, y: 1 }, 0)).toEqual({ x: 0, y: -0 });
    expect(tiltTransform({ x: 0, y: 0 }, 300)).toBe("");
    expect(tiltTransform({ x: 0.05, y: 0.02 }, 200)).toBe("perspective(700px) rotateX(0.0200rad) rotateY(0.0500rad)");
  });

  it("decodes left to right from HQ glyphs, keeps spaces, and ends on the exact text", () => {
    const text = "Cut the release";
    const start = decodeFrame(text, 0, 3);
    expect(start).toHaveLength(text.length);
    expect(start[3]).toBe(" ");
    expect([...start.replace(/ /g, "")].every((c) => HQ_GLYPHS.includes(c))).toBe(true);
    const mid = decodeFrame(text, 0.5, 3);
    expect(mid.startsWith("Cut the")).toBe(true);
    expect(decodeFrame(text, 1, 3)).toBe(text);
  });

  it("keeps decodes short", () => {
    expect(decodeMs(0)).toBe(240);
    expect(decodeMs(200)).toBe(520);
  });
});

describe("asciiDecode", () => {
  function row(done: boolean) {
    const host = document.createElement("div");
    host.setAttribute("data-decode-host", "");
    if (done) host.classList.add("done");
    const title = document.createElement("span");
    title.textContent = "Cut the hq-core release";
    host.append(title);
    document.body.append(host);
    const action = asciiDecode(title);
    host.dispatchEvent(new Event("pointerenter"));
    return { host, title, action };
  }

  it("decodes a title when its row is reached for", () => {
    const { host, title, action } = row(false);
    expect(title.classList.contains("decoding")).toBe(true);
    action.destroy();
    host.remove();
  });

  it("leaves a done row's title still", () => {
    const { host, title, action } = row(true);
    expect(title.classList.contains("decoding")).toBe(false);
    expect(title.querySelector(".decode-overlay")).toBeNull();
    action.destroy();
    host.remove();
  });
});
