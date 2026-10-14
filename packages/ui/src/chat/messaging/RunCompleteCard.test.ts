// @vitest-environment happy-dom

// The run card used to stretch to the full column with a hairline outline: a
// two-line summary left a metre of empty card beside it and read as a banner,
// and the outline drew a second edge a few pixels inside the raised fill. It
// hugs its content now (floored at the artifact card's 440px) and the fill
// carries the edge.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import RunCompleteCard from "./RunCompleteCard.svelte";

const css = (
  readFileSync(join(import.meta.dirname, "RunCompleteCard.svelte"), "utf8")
    .split("<style>")[1] ?? ""
).replace(/\/\*[\s\S]*?\*\//g, "");
const card = css.match(/\.run-card\s*\{([^}]*)\}/)?.[1] ?? "";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("RunCompleteCard shell", () => {
  it("hugs its content with a 440px floor instead of spanning the column", () => {
    expect(card).toMatch(/(?:^|;)\s*width:\s*fit-content;/);
    expect(card).toMatch(/min-width:\s*min\(440px, 100%\);/);
    expect(card).toMatch(/max-width:\s*100%;/);
    expect(card).toMatch(/box-sizing:\s*border-box;/);
    expect(card).not.toMatch(/(?:^|;)\s*width:\s*100%/);
  });

  it("has no visible outline at rest — the raised fill is the edge", () => {
    expect(card).toMatch(/border:\s*1px solid transparent;/);
    expect(card).toMatch(/background:\s*var\(--raised\b/);
    expect(card).not.toMatch(/border:[^;]*var\(--line/);
  });

  it("still renders the title, summary and actions", () => {
    const onopenurl = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(RunCompleteCard, {
      target: host,
      props: {
        model: {
          kind: "run_complete",
          title: "Run complete",
          summary: "Shipped the thing.",
          previewUrl: "https://preview.example",
          diffUrl: null,
        },
        onopenurl,
      },
    });
    flushSync();
    expect(host.querySelector(".run-card-title")?.textContent).toBe("Run complete");
    host.querySelector<HTMLButtonElement>(".run-card-btn")!.click();
    expect(onopenurl).toHaveBeenCalledWith("https://preview.example");
  });
});
