// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import AtlasLandingHost from "./AtlasLandingHost.svelte";

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

async function settle(target: HTMLElement): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    if (target.querySelector("[data-testid='atlas-inspector']")) return;
  }
}

describe("AtlasLandingHost (US-009)", () => {
  it("paints the skeleton in the first frame, then the company roll-up", async () => {
    const onopenperson = vi.fn();
    const target = document.createElement("div");
    document.body.appendChild(target);
    mounted.push(
      mount(AtlasLandingHost, {
        target,
        props: {
          companyLabel: "Indigo",
          workingNow: [
            { nodeId: "person:u_zed", name: "Zed", bot: false },
            { nodeId: "person:b_scout", name: "Scout", bot: true },
          ],
          onopenperson,
        },
      }),
    );
    flushSync();
    // First frame: skeleton and loading note, never a blank pane or spinner.
    expect(target.querySelector("[data-testid='atlas-landing-skeleton']")).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-landing']")?.getAttribute("aria-busy")).toBe("true");
    expect(target.textContent).toContain("Loading Indigo");

    await settle(target);
    const inspector = target.querySelector("[data-testid='atlas-inspector']");
    expect(inspector).not.toBeNull();
    expect(target.querySelector("[data-testid='atlas-landing-skeleton']")).toBeNull();
    const rollup = target.querySelector("[data-testid='atlas-inspector-rollup']")?.textContent ?? "";
    expect(rollup).toContain("2 live");
    expect(rollup).toContain("0 projects in progress");
    // The landing has no map yet, so the objects chip stays hidden.
    expect(rollup).not.toContain("objects");
    const working = target.querySelectorAll("[data-testid='atlas-inspector-working-now'] button");
    expect([...working].map((b) => b.textContent?.trim())).toEqual(["ZE Zed", "⌁ Scout"]);
    (working[0] as HTMLButtonElement).click();
    expect(onopenperson).toHaveBeenCalledWith("u_zed");
  });
});
