// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import WorkMeshActivityRow from "./WorkMeshActivityRow.svelte";
import type { WorkSessionCardModel } from "./channelMessageModels.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.useRealTimers();
});

function card(
  over: Partial<WorkSessionCardModel> = {},
): WorkSessionCardModel {
  return {
    kind: "work_session_card",
    type: "work_session",
    title: "Work session",
    summary: "active",
    actorUid: "prs_ada",
    actorType: "human",
    harness: "claude-code",
    taskId: "US-015",
    turnCount: 12,
    lastTurnAt: "2026-09-04T11:58:00.000Z",
    status: "active",
    principalDisplay: "Ada Lovelace",
    note: null,
    ...over,
  };
}

function mountCard(
  model: WorkSessionCardModel,
  actorLabel?: string | null,
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(WorkMeshActivityRow, {
    target: host,
    props: { card: model, actorLabel },
  });
  return host;
}

describe("WorkMeshActivityRow — work_session card", () => {
  it("renders a human card with harness, taskId, turns, and relative activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:40:00.000Z"));
    const root = mountCard(card());
    await tick();

    const row = root.querySelector('[data-testid="work-mesh-card"]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-actor-type")).toBe("human");
    const text = row?.textContent ?? "";
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("claude-code");
    expect(text).toContain("US-015");
    expect(text).toContain("12 turns");
    expect(text).toContain("last activity 42m ago");
    expect(root.querySelector(".agent-mark")).toBeNull();
  });

  it("marks agent cards with the agent glyph", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:04:30.000Z"));
    const root = mountCard(
      card({
        actorUid: "agt_parker",
        actorType: "agent",
        principalDisplay: "Parker",
        harness: "codex",
        taskId: "US-006",
        turnCount: 1,
        lastTurnAt: "2026-09-04T12:04:00.000Z",
      }),
      "Parker",
    );
    await tick();

    const row = root.querySelector('[data-testid="work-mesh-card"]');
    expect(row?.getAttribute("data-actor-type")).toBe("agent");
    expect(root.querySelector(".agent-mark")).not.toBeNull();
    const text = row?.textContent ?? "";
    expect(text).toContain("Parker");
    expect(text).toContain("codex");
    expect(text).toContain("US-006");
    expect(text).toContain("1 turn");
    expect(text).toContain("last activity just now");
  });

  it("renders an empty-ish card without crashing when fields are sparse", async () => {
    const root = mountCard(
      card({
        actorUid: null,
        actorType: "human",
        harness: null,
        taskId: null,
        turnCount: null,
        lastTurnAt: null,
        status: null,
        principalDisplay: null,
        note: null,
        title: "Work session",
        summary: null,
      }),
    );
    await tick();

    const row = root.querySelector('[data-testid="work-mesh-card"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("A teammate");
    expect(row?.textContent).not.toContain("last activity");
    expect(row?.textContent).not.toContain("turns");
  });
});
