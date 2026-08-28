// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BoardTab from "./BoardTab.svelte";
import type {
  BoardColumnModel,
  BoardStoryPanelModel,
} from "./channelTabModels";

const columns: BoardColumnModel[] = [
  {
    id: "done",
    title: "Done",
    cards: [{ storyId: "US-001", label: "Send the brief", statusLine: "DONE" }],
  },
];

const stories: Record<string, BoardStoryPanelModel> = {
  "US-001": {
    id: "US-001",
    title: "Send the brief",
    statusBadge: "Done",
    description: "",
    fields: { status: "Done", assignee: "", project: "demo", branch: "" },
    acceptanceCriteria: [],
    acCountLabel: "0 / 0",
    activity: [],
  },
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function renderBoard(): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BoardTab, {
    target: host,
    props: { columns, stories },
  });
  return host;
}

describe("BoardTab column filter", () => {
  it("shows To do, Doing, and Done by default even when empty", () => {
    const root = renderBoard();
    expect(
      root.querySelector('[data-testid="board-column-queued"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="board-column-in_progress"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="board-column-done"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="board-column-review"]'),
    ).toBeNull();
    expect(
      root.querySelector('[data-testid="board-column-empty-queued"]')
        ?.textContent,
    ).toContain("No tasks");
    expect(
      root
        .querySelector('[data-testid="board-filter-queued"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      root
        .querySelector('[data-testid="board-filter-review"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("reveals Waiting when the filter is toggled on", () => {
    const root = renderBoard();
    const toggle = root.querySelector<HTMLButtonElement>(
      '[data-testid="board-filter-review"]',
    );
    expect(toggle).not.toBeNull();
    flushSync(() => toggle?.click());
    expect(
      root.querySelector('[data-testid="board-column-review"]'),
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="board-column-empty-review"]')
        ?.textContent,
    ).toContain("No tasks");
  });
});
