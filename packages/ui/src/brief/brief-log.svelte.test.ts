// @vitest-environment happy-dom
// The brief log: line shape, the host seam, and the events the brief state writes.
import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { BriefState } from "./brief-context.svelte.js";
import { adapterBriefLog, briefItemKinds, briefLogLine, type BriefLogEvent, type BriefLogSink } from "./brief-log.js";
import { octoberEightBrief } from "./brief-fixture.js";

function recorder(): BriefLogSink & { events: BriefLogEvent[] } {
  const events: BriefLogEvent[] = [];
  return { events, append: (e) => void events.push(e) };
}

describe("briefLogLine", () => {
  it("is one JSON line with the time first and only the fields the event carries", () => {
    const line = briefLogLine({ event: "launch", run_id: "brief-1", kind: "needs", item_id: "d1", engine: "codex" }, new Date("2026-10-13T12:00:00Z"));
    expect(line).toBe('{"at":"2026-10-13T12:00:00.000Z","event":"launch","run_id":"brief-1","kind":"needs","item_id":"d1","engine":"codex"}');
    expect(line).not.toContain("\n");
    expect(briefLogLine({ event: "shown", run_id: null, widgets: ["sunrise", "needs"] }, new Date(0))).toBe(
      '{"at":"1970-01-01T00:00:00.000Z","event":"shown","run_id":null,"widgets":["sunrise","needs"]}',
    );
  });
});

describe("adapterBriefLog", () => {
  it("is null when the host cannot append", () => {
    expect(adapterBriefLog(null)).toBeNull();
    expect(adapterBriefLog({})).toBeNull();
  });

  it("appends one line per event, in order, and keeps going after a failure with one warning", async () => {
    const lines: string[] = [];
    let calls = 0;
    const files = {
      appendBriefLogLine: vi.fn(async (line: string) => {
        calls += 1;
        if (calls === 2) return { ok: false as const, reason: "error" as const, message: "disk full" };
        lines.push(line);
        return { ok: true as const, value: undefined };
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = adapterBriefLog(files, () => new Date("2026-10-13T12:00:00Z"))!;
    sink.append({ event: "shown", run_id: "r1", widgets: ["sunrise"] });
    sink.append({ event: "dismiss", run_id: "r1", item_id: "d1", kind: "needs" });
    sink.append({ event: "launch", run_id: "r1", item_id: "d2", kind: "needs", engine: "claude" });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(files.appendBriefLogLine).toHaveBeenCalledTimes(3);
    expect(lines.map((l) => JSON.parse(l).event)).toEqual(["shown", "launch"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("disk full");
    warn.mockRestore();
  });
});

describe("briefItemKinds", () => {
  it("names the card for decisions, risks, waiting, carry, handoffs and reminders", () => {
    const input = octoberEightBrief(new Date("2026-10-08T13:00:00Z"));
    const kinds = briefItemKinds(input);
    for (const d of input.decisions) expect(kinds[d.id]).toBe("needs");
    for (const r of input.risks) expect(kinds[r.id]).toBe(r.severity === "incident" ? "incident" : "risk");
    for (const w of input.waitingOn) expect(kinds[w.id]).toBe("waiting");
    expect(kinds["not-an-item"]).toBeUndefined();
  });
});

describe("BriefState logging", () => {
  function state(log: BriefLogSink, launch: (engine: string, prompt: string) => Promise<string | null> = async () => null) {
    return new BriefState(launch as never, () => [], {
      log: () => log,
      runId: () => "brief-20261012-200000",
      kindOf: (id) => (id === "d1" ? "needs" : id === "rem1" ? "reminders" : null),
    });
  }

  it("a clear without a launch is a dismiss with the item's card", () => {
    const log = recorder();
    const s = state(log);
    s.clear("rem1");
    s.clear("rem1");
    flushSync();
    expect(log.events).toEqual([{ event: "dismiss", run_id: "brief-20261012-200000", item_id: "rem1", kind: "reminders" }]);
  });

  it("a launch logs the engine once and never a dismiss for the same item", async () => {
    const log = recorder();
    const s = state(log);
    s.setEngine("codex");
    await s.start("d1", "Tell Corey where the logout fix stands");
    flushSync();
    expect(log.events).toEqual([{ event: "launch", run_id: "brief-20261012-200000", item_id: "d1", kind: "needs", engine: "codex" }]);
    expect(s.cleared.d1).toBe(true);
  });

  it("a launch that failed outright logs nothing and leaves the item open", async () => {
    const log = recorder();
    const s = state(log, async () => "Could not open Claude.");
    await s.start("d1", "prompt");
    expect(log.events).toEqual([]);
    expect(s.cleared.d1).toBeUndefined();
  });

  it("a copied prompt counts as a launch", async () => {
    const log = recorder();
    const s = state(log, async () => "Prompt copied. Paste it into Claude.");
    await s.start("d1", "prompt");
    expect(log.events.map((e) => e.event)).toEqual(["launch"]);
  });

  it("pin and hide name the card", () => {
    const log = recorder();
    const s = state(log);
    s.pin("weekArc");
    s.hide("team");
    expect(log.events).toEqual([
      { event: "pin", run_id: "brief-20261012-200000", kind: "weekArc" },
      { event: "hide", run_id: "brief-20261012-200000", kind: "team" },
    ]);
  });

  it("without a sink nothing is written and nothing breaks", async () => {
    const s = new BriefState(async () => null, () => []);
    s.clear("x");
    await s.start("y", "p");
    expect(s.cleared).toEqual({ x: true, y: true });
  });
});
