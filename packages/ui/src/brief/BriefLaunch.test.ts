// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { BRAND_ICONS } from "../common/button/rail-icons.js";

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("engine switcher", () => {
  it("shows the rail's brand marks with names, not letters, and switches engine", () => {
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(DailyBrief, { target, props: { input: octoberEightBrief(new Date(2026, 9, 8, 7, 42)) } });
    flushSync();
    const group = target.querySelector<HTMLElement>('[data-testid="brief-launch"] .eng')!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual(["Claude", "Codex", "Grok"]);
    expect(buttons.map((b) => b.title)).toEqual(["Claude", "Codex", "Grok"]);
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["", "", ""]);
    expect(buttons.map((b) => b.querySelector("path")?.getAttribute("d"))).toEqual([
      BRAND_ICONS["claude-code"].d,
      BRAND_ICONS.codex.d,
      BRAND_ICONS.grok.d,
    ]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");
    buttons[1]!.click();
    flushSync();
    expect(buttons[1]!.getAttribute("aria-pressed")).toBe("true");
    expect(target.querySelector('[data-testid="brief-start"]')?.textContent).toContain("Codex");
  });
});
