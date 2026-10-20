// @vitest-environment happy-dom

/**
 * First view, the watch list: the welcome actions left after the other
 * cards. Zero counts ("0 companies") are dropped from labels and reasons, a
 * row left with no label is dropped, and an empty list draws no empty-state
 * line such as "Nothing is owed today".
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import FirstViewWatch from "./FirstViewWatch.svelte";
import type { WelcomeAction } from "./brief-welcome-contract.js";

let target: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function act(id: string, label: string, reason = "", kind: WelcomeAction["kind"] = "open_tree"): WelcomeAction {
  return { id, kind, label, reason, launch_prompt: "", primary: false };
}

async function render(list: WelcomeAction[]): Promise<void> {
  target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(FirstViewWatch, { target, props: { list } });
  await tick();
}
const rows = (): string[] =>
  [...target.querySelectorAll('[data-testid="first-view-watch-row"]')].map((r) => r.textContent!.replace(/\s+/g, " ").trim());

afterEach(() => {
  if (component) unmount(component);
  component = null;
  target?.remove();
});

describe("FirstViewWatch", () => {
  it("shows each action's label and reason", async () => {
    await render([act("a", "See your project tree", "38 projects in 2 companies"), act("b", "Bring in your past work", "", "import_history")]);
    expect(rows()).toEqual(["See your project tree 38 projects in 2 companies", "Bring in your past work"]);
  });

  it("drops zero counts from labels and reasons, so no row says 0 companies", async () => {
    await render([act("a", "See your project tree", "38 projects across 0 companies"), act("b", "Review 3 PRs and 0 companies", "4 open, 0 companies")]);
    expect(rows()).toEqual(["See your project tree 38 projects", "Review 3 PRs 4 open"]);
    expect(target.textContent).not.toMatch(/\b0 companies\b/);
  });

  it("drops a row whose label was only a zero count", async () => {
    await render([act("a", "0 companies"), act("b", "Open Codex")]);
    expect(rows()).toEqual(["Open Codex"]);
  });

  it("an empty list draws no empty-state line", async () => {
    await render([]);
    expect(rows()).toEqual([]);
    expect(target.textContent!.trim()).toBe("");
    expect(target.textContent).not.toContain("Nothing is owed today");
  });
});
