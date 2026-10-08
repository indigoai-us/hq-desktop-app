import { describe, expect, it } from "vitest";

import { SCAN_LIMITS, cleanText, isScanNotRun, parseScanEvent, parseScanLine, prettySourceId } from "./scan-stream.js";

describe("scan stream parser", () => {
  it("reads every event type of the v1 contract", () => {
    expect(parseScanLine('{"v":1,"type":"start","sources":[{"id":"hq","label":"HQ companies"},{"id":"claude-code","label":"Claude Code"}]}')).toEqual({
      type: "start",
      sources: [
        { id: "hq", label: "HQ companies" },
        { id: "claude-code", label: "Claude Code" },
      ],
    });
    expect(parseScanLine('{"v":1,"type":"source","id":"codex","status":"scanning"}')).toEqual({
      type: "source",
      id: "codex",
      status: "scanning",
      counts: null,
      message: null,
    });
    expect(parseScanLine('{"v":1,"type":"source","id":"codex","status":"done","counts":{"sessions":96}}')).toMatchObject({
      status: "done",
      counts: { sessions: 96 },
    });
    expect(parseScanLine('{"v":1,"type":"source","id":"grok","status":"skipped","message":"Not here"}')).toMatchObject({
      status: "skipped",
      message: "Not here",
    });
    expect(parseScanLine('{"v":1,"type":"count","source":"claude-code","key":"sessions","value":120}')).toEqual({
      type: "count",
      source: "claude-code",
      key: "sessions",
      value: 120,
    });
    expect(parseScanLine('{"v":1,"type":"company","id":"indigo","name":"Indigo","basis":"hq-company"}')).toEqual({
      type: "company",
      id: "indigo",
      name: "Indigo",
      basis: "hq-company",
    });
    expect(parseScanLine('{"v":1,"type":"project","id":"p_9a1f3c2b7d40","name":"alpha","company":null,"basis":"repo"}')).toEqual({
      type: "project",
      id: "p_9a1f3c2b7d40",
      name: "alpha",
      company: null,
      basis: "repo",
    });
    expect(parseScanLine('{"v":1,"type":"error","source":"scanner","message":"Update HQ and try again."}')).toEqual({
      type: "error",
      source: "scanner",
      message: "Update HQ and try again.",
    });
    expect(parseScanLine('{"v":1,"type":"done","report":"/tmp/r.json","summary":{"companies":3,"projects":9,"sessions":508}}')).toEqual({
      type: "done",
      report: "/tmp/r.json",
      summary: { companies: 3, projects: 9, sessions: 508 },
    });
  });

  it("accepts objects as the host forwards them", () => {
    expect(parseScanEvent({ v: 1, type: "count", source: "codex", key: "sessions", value: 2 })).toMatchObject({ value: 2 });
  });

  it("drops anything that is not a v1 event it understands", () => {
    for (const line of [
      "",
      "Scanning…",
      "{not json",
      "[]",
      '{"v":2,"type":"count","source":"a","key":"k","value":1}',
      '{"type":"count","source":"a","key":"k","value":1}',
      '{"v":1,"type":"telemetry"}',
      '{"v":1,"type":"count","source":"a","key":"k","value":-1}',
      '{"v":1,"type":"count","source":"a","key":"Bad Key","value":1}',
      '{"v":1,"type":"count","source":"../x","key":"k","value":1}',
      '{"v":1,"type":"source","id":"a","status":"exploded"}',
      '{"v":1,"type":"company","id":"a","name":"   "}',
      '{"v":1,"type":"error","source":"a"}',
    ]) {
      expect(parseScanLine(line), line).toBeNull();
    }
    expect(parseScanLine(`{"v":1,"type":"error","source":"a","message":"${"x".repeat(70000)}"}`)).toBeNull();
  });

  it("cleans every string that reaches the screen", () => {
    expect(cleanText("  hq-\u0007desktop\n\t app ", 60)).toBe("hq- desktop app");
    expect(cleanText("‮evil", 60)).toBe("evil");
    const long = cleanText("a".repeat(200), SCAN_LIMITS.nameLength)!;
    expect([...long].length).toBe(SCAN_LIMITS.nameLength);
    expect(long.endsWith("…")).toBe(true);
    expect(cleanText(42, 10)).toBeNull();
  });

  it("caps counts and keys, and ignores unknown basis values without dropping the event", () => {
    const done = parseScanLine('{"v":1,"type":"source","id":"a","status":"done","counts":{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9}}');
    expect(Object.keys((done as { counts: object }).counts)).toHaveLength(SCAN_LIMITS.countKeys);
    expect(parseScanLine('{"v":1,"type":"count","source":"a","key":"k","value":1e12}')).toMatchObject({ value: SCAN_LIMITS.maxCount });
    expect(parseScanLine('{"v":1,"type":"company","id":"x","name":"X","basis":"vibes"}')).toMatchObject({ basis: null });
  });

  it("tells a scan that never ran from an empty one", () => {
    expect(isScanNotRun({ report: null, summary: { companies: 0, projects: 0, sessions: 0 } })).toBe(true);
    expect(isScanNotRun({ report: "/tmp/r.json", summary: { companies: 0, projects: 0, sessions: 0 } })).toBe(false);
    expect(isScanNotRun({ report: null, summary: { sessions: 3 } })).toBe(false);
  });

  it("names a source the start line did not", () => {
    expect(prettySourceId("claude-ai")).toBe("Claude ai");
  });
});
