import { describe, expect, it } from "vitest";
import {
  brainFromPayload,
  channelsFromPayload,
  controlError,
  controlViewFromPayload,
  personaFromPayload,
  relativeTime,
  routinesFromPayload,
  scheduleInWords,
  validKnowledgePath,
} from "./agent-control-model.js";

describe("scheduleInWords", () => {
  it.each([
    ["0 9 * * 1-5", "Weekdays at 9:00"],
    ["30 7 * * *", "Daily at 7:30"],
    ["0 * * * *", "Every hour"],
    ["15 * * * *", "Every hour at :15"],
    ["*/10 * * * *", "Every 10 minutes"],
    ["0 */4 * * *", "Every 4 hours"],
    ["0 9 * * 1", "Mondays at 9:00"],
    ["0 18 * * 1,3", "Mon, Wed at 18:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 8 1 * *", "Monthly on day 1 at 8:00"],
    ["0 9 * 1 *", "0 9 * 1 *"],
    ["every 30m", "every 30m"],
    ["", "No schedule"],
  ])("%s reads %s", (cron, words) => {
    expect(scheduleInWords(cron)).toBe(words);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-13T12:00:00Z");
  it("reads past and future times", () => {
    expect(relativeTime("2026-10-13T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-10-13T12:20:00Z", now)).toBe("in 20m");
    expect(relativeTime("2026-10-11T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("2026-10-13T12:00:10Z", now)).toBe("just now");
    expect(relativeTime(null, now)).toBeNull();
    expect(relativeTime("not a date", now)).toBeNull();
  });
});

describe("readers", () => {
  it("reads channels bare or wrapped, in a fixed order, filling missing kinds", () => {
    const wrapped = channelsFromPayload({ channels: [{ kind: "slack", enabled: true, status: "connected", detail: "#ops" }] });
    expect(wrapped.map((c) => c.kind)).toEqual(["hq", "slack", "telegram", "email"]);
    expect(wrapped[1]).toEqual({ kind: "slack", enabled: true, status: "connected", detail: "#ops" });
    expect(wrapped[2]).toEqual({ kind: "telegram", enabled: false, status: "not_connected", detail: null });
    expect(channelsFromPayload([{ kind: "email", enabled: true, status: "weird" }])[3]?.status).toBe("not_connected");
  });

  it("reads routines and drops rows without an id", () => {
    const rows = routinesFromPayload({ routines: [{ id: "r1", name: "Brief", schedule: "0 9 * * *", enabled: false }, { name: "no id" }] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "r1", name: "Brief", enabled: false, prompt: "", lastStatus: null });
  });

  it("reads persona and brain with missing fields as empty", () => {
    expect(personaFromPayload({ persona: { displayName: "Nova", instructions: "Be brief." } })).toMatchObject({
      displayName: "Nova", title: "", instructions: "Be brief.", instructionsPath: null,
    });
    const brain = brainFromPayload({ model: "m1", availableModels: ["m1", { id: "m2" }], memory: [{ id: "a", title: "A" }, {}], knowledge: [{ path: "x.md", size: 12 }] });
    expect(brain.availableModels).toEqual(["m1", "m2"]);
    expect(brain.memory).toEqual([{ id: "a", title: "A", preview: "", updatedAt: null }]);
    expect(brain.knowledge).toEqual([{ path: "x.md", size: 12, updatedAt: null }]);
  });

  it("reads the whole control view and falls back to the roster for the agent", () => {
    const v = controlViewFromPayload({ source: "snapshot" }, { uid: "agt_1", displayName: "Nova", online: true });
    expect(v.agent).toMatchObject({ uid: "agt_1", displayName: "Nova", online: true });
    expect(v.source).toBe("snapshot");
    expect(v.channels).toHaveLength(4);
  });
});

describe("controlError", () => {
  it("shows the server's sentence when it sent a code", () => {
    expect(controlError({ ok: false, reason: "error", code: "READBACK_MISMATCH", message: "The box did not keep it." })).toEqual({
      offline: false, message: "The box did not keep it.",
    });
  });

  it("flags an offline box", () => {
    expect(controlError({ ok: false, reason: "error", code: "BOX_OFFLINE", message: "Box is offline." }).offline).toBe(true);
    expect(controlError({ ok: false, reason: "error", code: "AGENT_UNREACHABLE" })).toEqual({
      offline: true, message: "This bot is offline. Try again when it's back.",
    });
  });

  it("never shows transport or bare-status text", () => {
    expect(controlError({ ok: false, reason: "error", code: "http-500", message: "PUT /x failed" }).message).toBe("Something went wrong. Try again.");
    expect(controlError({ ok: false, reason: "error", code: "network", message: "[invoke] boom" }).message).toContain("Could not reach HQ");
    expect(controlError({ ok: false, reason: "error", code: "http-403", status: 403 }).message).toContain("owners");
    expect(controlError({ ok: false, reason: "error", code: "http-404", status: 404 }).message).toContain("newer HQ server");
  });
});

describe("validKnowledgePath", () => {
  it("accepts relative paths and refuses escapes", () => {
    expect(validKnowledgePath("notes/pricing.md")).toBe(true);
    expect(validKnowledgePath("../secrets.md")).toBe(false);
    expect(validKnowledgePath("a/../b.md")).toBe(false);
    expect(validKnowledgePath("/etc/passwd")).toBe(false);
    expect(validKnowledgePath("a//b.md")).toBe(false);
    expect(validKnowledgePath("")).toBe(false);
  });
});
