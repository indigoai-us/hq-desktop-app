// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import WorkMeshActivityRow from "./WorkMeshActivityRow.svelte";
import { normalizeWorkMeshEvent } from "./workSessionEvent";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountActivity(raw: unknown, over: Record<string, unknown> = {}) {
  const activity = normalizeWorkMeshEvent(raw, {
    resolveActor: () => "Ada Lovelace",
  });
  if (!activity) throw new Error("fixture did not normalise");
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(WorkMeshActivityRow, {
    target: host,
    props: { activity: { ...activity, ...over }, time: "11:58" },
  });
  return host;
}

function rowText(root: HTMLDivElement): string {
  return root.querySelector(".work-mesh-row .sys-summary")?.textContent ?? "";
}

const V2_TASK_MOVE = {
  v: 1,
  eventId: "01JQ2RYAHXHDPCTY9GPQPTH3DG",
  kind: "task_status",
  sessionId: "sess-1",
  harness: "claude-code",
  adapterVersion: "1.4.0",
  at: "2026-09-03T09:00:00.000Z",
  seq: 7,
  taskId: "US-004",
  status: "in_progress",
  previousStatus: "queued",
  // The server projects the JWT-resolved actor onto the stored row; the raw
  // spool line has no actor field at all.
  actorUid: "prs_ada",
  actorType: "human",
};

describe("WorkMeshActivityRow — task moves", () => {
  it("renders a board move with both column labels", async () => {
    const root = mountActivity(V2_TASK_MOVE);
    await tick();
    const text = rowText(root);
    expect(text).toContain("Ada Lovelace");
    expect(text).toContain("moved US-004 To do → Doing");
  });

  it("falls back to A teammate when no actor can be resolved", async () => {
    const root = mountActivity({ ...V2_TASK_MOVE, actorUid: undefined });
    await tick();
    expect(rowText(root)).toContain("A teammate");
  });

  it("renders a destination-only move when the previous column is unknown", async () => {
    const root = mountActivity({ ...V2_TASK_MOVE, previousStatus: undefined });
    await tick();
    expect(rowText(root)).toContain("moved US-004 to Doing");
  });

  it("tags the row kind so the accent can key off it", async () => {
    const root = mountActivity(V2_TASK_MOVE);
    await tick();
    expect(
      root.querySelector('[data-testid="work-mesh-row"]')?.getAttribute("data-kind"),
    ).toBe("task_status");
  });

  it("labels a collapsed burst with its update count", async () => {
    const root = mountActivity(
      {
        eventKind: "progress",
        eventId: "e1",
        createdAt: "2026-09-03T09:00:00.000Z",
        authorUid: "prs_ada",
        payload: { kind: "progress", summary: "Wiring the timeline" },
      },
      { burstCount: 4 },
    );
    await tick();
    const text = rowText(root);
    expect(text).toContain("made progress on");
    expect(text).toContain("4 updates");
  });

  it("shows a single event with no burst tail", async () => {
    const root = mountActivity({
      eventKind: "progress",
      eventId: "e1",
      createdAt: "2026-09-03T09:00:00.000Z",
      authorUid: "prs_ada",
      payload: { kind: "progress", summary: "Wiring the timeline" },
    });
    await tick();
    expect(rowText(root)).not.toContain("updates");
  });

  it("renders a blocked row with its reason", async () => {
    const root = mountActivity({
      eventKind: "blocked",
      eventId: "e2",
      createdAt: "2026-09-03T09:00:00.000Z",
      authorUid: "prs_ada",
      payload: { kind: "blocked", reason: "waiting on hq-pro deploy" },
    });
    await tick();
    const text = rowText(root);
    expect(text).toContain("is blocked on");
    expect(text).toContain("waiting on hq-pro deploy");
  });
});
