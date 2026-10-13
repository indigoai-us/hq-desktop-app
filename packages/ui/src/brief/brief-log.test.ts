import { describe, expect, it, vi } from "vitest";
import { briefLogLine, createBriefLogger } from "./brief-log.js";

const AT = new Date("2026-10-13T09:00:00.000Z");
const RUN = "brief-20261013-090000";

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("briefLogLine", () => {
  it("is one JSON object with the writer's field names", () => {
    expect(JSON.parse(briefLogLine({ event: "shown", runId: RUN }, AT))).toEqual({ at: "2026-10-13T09:00:00.000Z", event: "shown", run_id: RUN });
    expect(JSON.parse(briefLogLine({ event: "launch", runId: RUN, itemId: "d1", engine: "codex" }, AT))).toEqual({
      at: "2026-10-13T09:00:00.000Z",
      event: "launch",
      run_id: RUN,
      item_id: "d1",
      engine: "codex",
    });
    expect(briefLogLine({ event: "dismiss", runId: RUN, itemId: "p2" }, AT)).not.toContain("\n");
  });
});

describe("createBriefLogger", () => {
  it("appends each event once, and `shown` only once per run", async () => {
    const append = vi.fn(async (_line: string) => ({ ok: true as const, value: undefined }));
    const log = createBriefLogger(append, { now: () => AT });
    log({ event: "shown", runId: RUN });
    log({ event: "shown", runId: RUN });
    log({ event: "dismiss", runId: RUN, itemId: "d1" });
    log({ event: "dismiss", runId: RUN, itemId: "d1" });
    log({ event: "shown", runId: "brief-20261013-100000" });
    await settle();
    expect(append.mock.calls.map((c) => JSON.parse(c[0] as string))).toEqual([
      { at: "2026-10-13T09:00:00.000Z", event: "shown", run_id: RUN },
      { at: "2026-10-13T09:00:00.000Z", event: "dismiss", run_id: RUN, item_id: "d1" },
      { at: "2026-10-13T09:00:00.000Z", event: "dismiss", run_id: RUN, item_id: "d1" },
      { at: "2026-10-13T09:00:00.000Z", event: "shown", run_id: "brief-20261013-100000" },
    ]);
  });

  it("does nothing without a host append, and never throws when the host refuses or fails", async () => {
    const warn = vi.fn();
    createBriefLogger(null, { warn })({ event: "shown", runId: RUN });
    const refused = createBriefLogger(async () => ({ ok: false as const, reason: "unavailable" as const, message: "the brief log requires a signed-in user" }), { warn });
    refused({ event: "shown", runId: RUN });
    refused({ event: "dismiss", runId: RUN, itemId: "d1" });
    const thrown = createBriefLogger(async () => {
      throw new Error("disk full");
    }, { warn });
    thrown({ event: "launch", runId: RUN, itemId: "d1", engine: "claude" });
    await settle();
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      "brief log append failed: the brief log requires a signed-in user",
      "brief log append failed: disk full",
    ]);
  });
});
