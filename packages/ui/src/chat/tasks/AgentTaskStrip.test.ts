// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount } from "svelte";

import type { AgentTask } from "./agent-tasks";
import AgentTaskStrip from "./AgentTaskStrip.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(tasks: AgentTask[], now: () => number = () => Date.now()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgentTaskStrip, { target: host, props: { tasks, now } });
}

function scopedCss(root: ParentNode): string {
  const scope = [...root.querySelectorAll("[class]")].flatMap((el) =>
    [...el.classList].filter((name) => name.startsWith("svelte-")),
  )[0];
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => (scope ? css.includes(scope) : false))
    .join("\n");
}

const NOW = 1_700_000_000_000;

describe("AgentTaskStrip", () => {
  it("renders nothing at all when there are no tasks", () => {
    render([]);
    expect(host.querySelector("[data-testid='agent-task-strip']")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("is a polite status region with one chip per visible task", () => {
    render(
      [
        { id: "live", title: "Ship the strip", status: "queued" },
        { id: "working", title: "Watch CI", status: "working" },
      ],
      () => NOW,
    );
    const strip = host.querySelector("[data-testid='agent-task-strip']");
    expect(strip?.getAttribute("role")).toBe("status");
    expect(strip?.getAttribute("aria-live")).toBe("polite");
    const chips = [...host.querySelectorAll("[data-testid='task-chip']")];
    expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual([
      "Ship the strip, Queued",
      "Watch CI, Working in the background",
    ]);
  });

  it("drops a finished task once its recent window has passed", () => {
    const stale = new Date(NOW - 16 * 60 * 1000).toISOString();
    render(
      [
        { id: "live", title: "Still going", status: "queued" },
        { id: "old", title: "Already done", status: "done", lastEventAt: stale },
      ],
      () => NOW,
    );
    const labels = [...host.querySelectorAll("[data-testid='task-chip']")].map((chip) =>
      chip.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Still going, Queued"]);
  });

  it("uses no hardcoded hex colors", () => {
    render([{ id: "live", title: "Ship the strip", status: "queued" }]);
    expect(scopedCss(host)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(host.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
