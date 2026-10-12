// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DailyBrief from "./DailyBrief.svelte";
import { promptWithPick } from "./BriefLaunch.svelte";
import { octoberEightBrief } from "./brief-fixture.js";
import { decisionPrompt } from "./brief-prompts.js";
import type { BriefDecision, BriefInput } from "./brief-types.js";
import { BRAND_ICONS } from "../common/button/rail-icons.js";

let app: ReturnType<typeof mount> | null = null;
let target: HTMLElement;

function render(input: BriefInput, props: Record<string, unknown> = {}) {
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(DailyBrief, { target, props: { input, ...props } });
  flushSync();
}

afterEach(() => {
  if (app) unmount(app);
  app = null;
  target?.remove();
  localStorage.clear();
});

describe("engine switcher", () => {
  it("shows the rail's brand marks with names, not letters, and switches engine", () => {
    render(octoberEightBrief(new Date(2026, 9, 8, 7, 42)));
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

describe("decide choices", () => {
  const decision = (i: number, extra: Partial<BriefDecision> = {}): BriefDecision => ({
    id: `d${i}`,
    title: `Decision number ${i}`,
    summary: `Why ${i}`,
    action: "decide",
    origin: { companyUid: "cmp_indigo", repo: "indigoai-us/hq-desktop-app" },
    ...extra,
  });

  it("promptWithPick appends the pick as its own sentence", () => {
    expect(promptWithPick("Help me decide: keep the rule?", "Keep")).toBe("Help me decide: keep the rule? My pick: Keep.");
    expect(promptWithPick("Decide the thing", " Retire ")).toBe("Decide the thing. My pick: Retire.");
  });

  it("the pill splits into the two answers; picking one starts the prompt with the pick and marks the row done", async () => {
    const onlaunch = vi.fn(async () => null);
    const d1 = decision(1, { choices: ["Keep", "Retire"] });
    const input: BriefInput = { ...octoberEightBrief(new Date(2026, 9, 10, 14, 30)), today: "2026-10-10", priorities: undefined, decisions: [d1, decision(2), decision(3)] };
    render(input, { onlaunch });
    const rowEl = [...target.querySelectorAll<HTMLElement>('[data-testid="brief-need"]')].find((el) => el.getAttribute("aria-label") === d1.title)!;
    const split = rowEl.querySelector<HTMLElement>('[data-testid="brief-start-split"]')!;
    expect(split).not.toBeNull();
    expect(rowEl.querySelector('[data-testid="brief-start"]')).toBeNull();
    // The resting label still says where it starts (full label in a two-row slot); the answers are real buttons.
    expect(split.querySelector(".lbl")!.textContent).toBe("Start in Claude");
    const choices = [...split.querySelectorAll<HTMLButtonElement>('[data-testid="brief-choice"]')];
    expect(choices.map((b) => b.textContent)).toEqual(["Keep", "Retire"]);
    // The engine switcher and copy button still sit beside the split pill.
    expect(rowEl.querySelector('[data-testid="brief-launch"] .eng')).not.toBeNull();
    expect(rowEl.querySelector('[data-testid="brief-copy"]')).not.toBeNull();
    choices[1]!.click();
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(onlaunch).toHaveBeenCalledWith("claude", promptWithPick(decisionPrompt(d1), "Retire"));
    expect(onlaunch).toHaveBeenCalledWith("claude", expect.stringMatching(/The options are Keep or Retire\..* My pick: Retire\.$/));
    expect(rowEl.classList.contains("done")).toBe(true);
    // Done replaces the pill; nothing else to start on this row.
    expect(rowEl.querySelector('[data-testid="brief-start-split"]')).toBeNull();
    expect(rowEl.textContent).toContain("Done");
  });
});
