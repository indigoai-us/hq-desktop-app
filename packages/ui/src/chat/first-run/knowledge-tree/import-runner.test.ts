import { describe, expect, it, vi } from "vitest";

import { IMPORT_COPY, createImportRunner, importResultOf, type ImportRunView, type ImportScanHost } from "./import-runner.js";
import { createImportScanHost } from "./import-host.js";
import { ok, failure, IMPORT_SCAN_EVENT, type ContextImportApi } from "@hq/platform";

const line = (o: Record<string, unknown>) => ({ v: 1, ...o });

/** A host whose scans the test drives by hand. */
function fakeHost() {
  const runs: Array<{ scanId: string; emit: (raw: unknown) => void; end: (status: string) => void }> = [];
  const cancel = vi.fn();
  const host: ImportScanHost = {
    run: (scanId, onevent) =>
      new Promise((resolve) => {
        runs.push({ scanId, emit: onevent, end: (status) => resolve({ status: status as never }) });
      }),
    cancel,
  };
  return { host, runs, cancel };
}

function runner(host: ImportScanHost | null) {
  let t = 5;
  const views: ImportRunView[] = [];
  const r = createImportRunner(host, () => t, (v) => views.push(v));
  return { r, views, tick: (s: number) => (t += s), last: () => views[views.length - 1]! };
}

describe("import runner", () => {
  it("shows running at once, stamps events on the scene clock, and finishes on done", async () => {
    const { host, runs } = fakeHost();
    const { r, last, tick } = runner(host);
    r.start();
    expect(last()).toMatchObject({ phase: "running", scanStart: 5 });
    // a double press starts nothing more
    r.start();
    await Promise.resolve();
    expect(runs).toHaveLength(1);
    tick(1);
    runs[0]!.emit(line({ type: "start", sources: [] }));
    runs[0]!.emit("not json");
    runs[0]!.emit({ v: 1, type: "count", source: "x" }); // incomplete: dropped
    tick(1);
    runs[0]!.emit(line({ type: "done", report: "/tmp/r.json", summary: { companies: 1, projects: 2, sessions: 3 } }));
    expect(last().phase).toBe("done");
    expect(last().events.map((e) => [e.at, e.event.type])).toEqual([
      [6, "start"],
      [7, "done"],
    ]);
    expect(importResultOf(last().events)).toEqual({ summary: { companies: 1, projects: 2, sessions: 3 }, report: "/tmp/r.json" });
    // the host ending afterwards changes nothing
    runs[0]!.end("done");
    await Promise.resolve();
    expect(last().phase).toBe("done");
    r.start();
    expect(runs).toHaveLength(1);
  });

  it("a stream that ends without done fails with a plain message; Retry runs again", async () => {
    const { host, runs } = fakeHost();
    const { r, last } = runner(host);
    r.start();
    await Promise.resolve();
    runs[0]!.end("failed");
    await vi.waitFor(() => expect(last().phase).toBe("failed"));
    expect(last().failure?.message).toBe(IMPORT_COPY.failed);
    r.retry();
    expect(last().phase).toBe("running");
    await Promise.resolve();
    expect(runs).toHaveLength(2);
    expect(runs[1]!.scanId).not.toBe(runs[0]!.scanId);
  });

  it("an hq without the scan, or an HQ whose scanner is too old, asks for an update", async () => {
    const a = fakeHost();
    const one = runner(a.host);
    one.r.start();
    await Promise.resolve();
    a.runs[0]!.end("unavailable");
    await vi.waitFor(() => expect(one.last().failure?.message).toBe(IMPORT_COPY.update));

    const b = fakeHost();
    const two = runner(b.host);
    two.r.start();
    await Promise.resolve();
    b.runs[0]!.emit(line({ type: "error", source: "scanner", message: "The import-context scanner is not installed in this HQ. Update HQ and try again." }));
    b.runs[0]!.emit(line({ type: "done", report: null, summary: { companies: 0, projects: 0, sessions: 0 } }));
    expect(two.last()).toMatchObject({ phase: "failed", failure: { message: IMPORT_COPY.update } });
    expect(importResultOf(two.last().events)).toBeNull();

    const c = fakeHost();
    const three = runner(c.host);
    three.r.start();
    await Promise.resolve();
    c.runs[0]!.emit(line({ type: "error", source: "scanner", message: "The HQ folder was not found." }));
    c.runs[0]!.emit(line({ type: "done", report: null, summary: { companies: 0, projects: 0, sessions: 0 } }));
    expect(three.last().failure?.message).toBe(IMPORT_COPY.failed);
  });

  it("a host that is missing or throws never leaves the screen hanging", async () => {
    const none = runner(null);
    none.r.start();
    expect(none.last()).toMatchObject({ phase: "failed", failure: { message: IMPORT_COPY.update } });

    const throwing = runner({ run: () => Promise.reject(new Error("boom")), cancel: () => undefined });
    throwing.r.start();
    await vi.waitFor(() => expect(throwing.last().phase).toBe("failed"));
  });

  it("gives up on a scan the host never ends", async () => {
    vi.useFakeTimers();
    try {
      const { host, cancel } = fakeHost();
      let t = 0;
      const views: ImportRunView[] = [];
      const r = createImportRunner(host, () => t, (v) => views.push(v), { timeoutMs: 1000 });
      r.start();
      await vi.advanceTimersByTimeAsync(1001);
      expect(views[views.length - 1]).toMatchObject({ phase: "failed", failure: { message: IMPORT_COPY.timeout } });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel stops the running scan and goes back to asking; late lines are ignored", async () => {
    const { host, runs, cancel } = fakeHost();
    const { r, last } = runner(host);
    r.start();
    await Promise.resolve();
    r.cancel();
    expect(cancel).toHaveBeenCalledWith(runs[0]!.scanId);
    expect(last()).toMatchObject({ phase: "idle", scanStart: null, events: [] });
    runs[0]!.emit(line({ type: "start", sources: [] }));
    runs[0]!.end("cancelled");
    await Promise.resolve();
    expect(last().phase).toBe("idle");
    expect(last().events).toEqual([]);
  });

  it("skip cancels a running scan and records the skip", async () => {
    const { host, cancel } = fakeHost();
    const { r, last } = runner(host);
    r.start();
    await Promise.resolve();
    r.skip();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(last().phase).toBe("skipped");
  });

  it("dispose cancels a scan still running", async () => {
    const { host, cancel } = fakeHost();
    const { r } = runner(host);
    r.start();
    await Promise.resolve();
    r.dispose();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("without a summary on done, the result counts what the stream carried", () => {
    const events = [
      { at: 1, event: { type: "company", id: "a", name: "A", basis: null } },
      { at: 1, event: { type: "project", id: "p_1", name: "x", company: "a", basis: null } },
      { at: 1, event: { type: "count", source: "codex", key: "sessions", value: 4 } },
      { at: 1, event: { type: "source", id: "claude-code", status: "done", counts: { sessions: 6 }, message: null } },
      { at: 2, event: { type: "done", report: "/r.json", summary: {} } },
    ] as const;
    expect(importResultOf(events as never)).toEqual({ summary: { companies: 1, projects: 1, sessions: 10 }, report: "/r.json" });
  });
});

describe("import host (desktop)", () => {
  function bus() {
    const handlers = new Set<(e: { payload?: unknown }) => void>();
    return {
      handlers,
      listen: vi.fn(async (_event: string, h: (e: { payload?: unknown }) => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      }),
      emit: (payload: unknown) => handlers.forEach((h) => h({ payload })),
    };
  }

  it("has no host without the command or the event bus", () => {
    const api = { scanStart: vi.fn(), scanCancel: vi.fn() } as unknown as ContextImportApi;
    expect(createImportScanHost(undefined, bus())).toBeNull();
    expect(createImportScanHost(api, null)).toBeNull();
  });

  it("forwards only this scan's lines, listens before starting, and stops listening at the end", async () => {
    const b = bus();
    let finish: (v: unknown) => void = () => undefined;
    const api: ContextImportApi = {
      scanStart: vi.fn(() => new Promise((resolve) => (finish = resolve))) as never,
      scanCancel: vi.fn(async () => ok(true)),
    };
    const host = createImportScanHost(api, b, { graceMs: 0 })!;
    const seen: unknown[] = [];
    const running = host.run("scan-1", (raw) => seen.push(raw));
    await vi.waitFor(() => expect(api.scanStart).toHaveBeenCalledWith("scan-1"));
    expect(b.listen).toHaveBeenCalledWith(IMPORT_SCAN_EVENT, expect.any(Function));
    b.emit({ scanId: "scan-1", event: { v: 1, type: "start", sources: [] } });
    b.emit({ scanId: "other", event: { v: 1, type: "start", sources: [] } });
    b.emit(null);
    finish(ok({ status: "done", lines: 1, dropped: 0 }));
    await expect(running).resolves.toEqual({ status: "done" });
    expect(seen).toEqual([{ v: 1, type: "start", sources: [] }]);
    expect(b.handlers.size).toBe(0);
    await host.cancel("scan-1");
    expect(api.scanCancel).toHaveBeenCalledWith("scan-1");
  });

  it("a failed or unknown answer is a failure, never a hang", async () => {
    const b = bus();
    const api: ContextImportApi = {
      scanStart: vi.fn(async () => failure("unknown", "command import_scan_start not found")) as never,
      scanCancel: vi.fn(async () => ok(true)),
    };
    const host = createImportScanHost(api, b, { graceMs: 0 })!;
    await expect(host.run("s", () => undefined)).resolves.toEqual({ status: "failed" });
    const odd: ContextImportApi = { ...api, scanStart: vi.fn(async () => ok(null)) as never };
    await expect(createImportScanHost(odd, b, { graceMs: 0 })!.run("s", () => undefined)).resolves.toEqual({ status: "failed" });
  });
});
