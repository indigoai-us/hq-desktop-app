// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import StoryPanel from "../home/StoryPanel.svelte";
import type { Story } from "./projects-model.js";

function story(id: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: [],
    passes: false,
    labels: [],
    dependsOn: [],
    ...extra,
  };
}

let host: Record<string, unknown> | null = null;

afterEach(async () => {
  if (host) await unmount(host);
  host = null;
  document.body.replaceChildren();
});

function render(item: Story, stories: Story[]): { badge: string; selected: string } {
  host = mount(StoryPanel, {
    target: document.body,
    props: { story: item, stories, project: null, prdPath: "", onclose: () => {} },
  });
  flushSync();
  const badge = document.querySelector("[data-testid='task-detail-status']")?.textContent?.trim() ?? "";
  const selected =
    document.querySelector("[data-testid='task-status-control'] button.active")?.textContent?.trim() ?? "";
  return { badge, selected };
}

// QA-036 (round 18): the badge said In progress but the status selector still
// highlighted To do. The selected half of the control must name the same status.
describe("task status control (QA-036)", () => {
  it("selects In progress, not To do, for a started task", () => {
    const stories = [story("US-002", { passes: true }), story("US-003", { notes: "started" })];
    const { badge, selected } = render(stories[1], stories);
    expect(badge).toContain("In progress");
    expect(selected).toBe("In progress");
  });

  it("still says To do for a task that has not started", () => {
    const stories = [story("US-001", { notes: "started" }), story("US-002", { dependsOn: ["US-001"] })];
    const { badge, selected } = render(stories[1], stories);
    expect(badge).toContain("To do");
    expect(selected).toBe("To do");
  });

  it("selects Done for a complete task", () => {
    const stories = [story("US-001", { passes: true })];
    expect(render(stories[0], stories).selected).toBe("Done");
  });
});
