// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import AtlasCard from "./AtlasCard.svelte";
import { atlasStoryProgress } from "./atlas-activity.js";
import type { AtlasNode } from "./atlas-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function project(stories?: { done: number; total: number }): AtlasNode {
  return {
    id: "project:projects/retention/",
    type: "project",
    label: "retention",
    path: "projects/retention/",
    folder: true,
    count: 1,
    ...(stories ? { stories } : {}),
  };
}

function render(node: AtlasNode, onclick = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AtlasCard, { target: host, props: { node, meta: "8 min ago", onclick } });
  flushSync();
  return host;
}

describe("AtlasCard story progress", () => {
  it("hides the bar and count when the project has no stories", () => {
    const el = render(project());
    expect(el.querySelector('[data-testid="atlas-card-progress"]')).toBeNull();
    expect(el.textContent).not.toMatch(/stor/);
  });

  it("hides the bar for a zero-story board", () => {
    const el = render(project({ done: 0, total: 0 }));
    expect(el.querySelector('[data-testid="atlas-card-progress"]')).toBeNull();
  });

  it("shows done over total and a partial bar", () => {
    const el = render(project({ done: 12, total: 20 }));
    expect(el.querySelector('[data-testid="atlas-card-count"]')?.textContent).toBe("12 / 20 stories");
    const bar = el.querySelector('[data-testid="atlas-card-progress"]') as HTMLElement;
    expect(bar.dataset.done).toBe("0.600");
    expect((el.querySelector(".fill") as HTMLElement).style.width).toBe("60.0%");
  });

  it("fills the bar when every story is done", () => {
    const el = render(project({ done: 7, total: 7 }));
    expect(el.querySelector('[data-testid="atlas-card-count"]')?.textContent).toBe("7 / 7 stories");
    expect((el.querySelector(".fill") as HTMLElement).style.width).toBe("100.0%");
  });

  it("drops the type word and keeps the name and quiet line", () => {
    const onclick = vi.fn();
    const el = render(project({ done: 1, total: 1 }), onclick);
    expect(el.querySelector(".tt")?.textContent).toBe("retention");
    expect(el.querySelector(".mm")?.textContent).toBe("8 min ago");
    expect(el.textContent).not.toContain("project");
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(onclick).toHaveBeenCalledOnce();
  });
});

describe("atlasStoryProgress", () => {
  it("is null without stories and clamps done to total", () => {
    expect(atlasStoryProgress({})).toBeNull();
    expect(atlasStoryProgress({ stories: { done: 0, total: 0 } })).toBeNull();
    expect(atlasStoryProgress({ stories: { done: 1, total: 1 } })?.text).toBe("1 / 1 story");
    expect(atlasStoryProgress({ stories: { done: 9, total: 4 } })).toMatchObject({ done: 4, total: 4, fraction: 1 });
  });
});
