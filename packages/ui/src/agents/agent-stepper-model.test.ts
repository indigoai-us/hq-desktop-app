import { describe, expect, it } from "vitest";
import {
  accessSummary,
  emptyDraft,
  enrollPlaceholder,
  probeScript,
  redactProbeText,
  setGrant,
  toCloudDraft,
  toLocalInput,
} from "./agent-stepper-model.js";

const ctx = { canLocal: true, canCloud: true, existingNames: [], companies: [], runtimeReady: null };

describe("agent stepper model", () => {
  it("keeps grants to read and write, and write implies read", () => {
    const grant = { path: "companies/indigo/knowledge/", note: "", read: false, write: false };
    const read = setGrant(grant, "read", true);
    expect(read).toMatchObject({ read: true, write: false });
    const write = setGrant(read, "write", true);
    expect(write).toMatchObject({ read: true, write: true });
    expect(setGrant(write, "read", false)).toMatchObject({ read: false, write: false });
  });

  it("maps a local draft through the existing create-bot input", () => {
    const draft = emptyDraft({ place: "local", name: "scout", runtime: "claude" });
    expect(toLocalInput(draft, ctx)).toMatchObject({ name: "scout", runtime: "claude" });
  });

  it("maps a hosted draft onto the cloud create draft with a box size", () => {
    const draft = emptyDraft({ place: "hosted", name: "ledger", size: "power", region: "us-east-1" });
    expect(toCloudDraft(draft)).toMatchObject({ name: "ledger", handle: "ledger", size: "power" });
    expect(accessSummary(draft)).toContain("0 paths");
  });

  it("redacts enroll tokens and secret values, including on the probe log", () => {
    expect(enrollPlaceholder()).toBe("••••");
    expect(redactProbeText("enroll token: abcdefghijklmnopqrstuvwxyz012345 secret=sk_live_abcdefghijklmnop")).not.toMatch(/sk_live_|abcdefghijklmnopqrstuvwxyz012345/);
    const lines = probeScript(emptyDraft({ place: "hosted", name: "ledger" }), new Date("2026-10-01T14:32:12.000Z"));
    const text = lines.map((line) => `${line.text} ${line.detail ?? ""}`).join("\n");
    expect(text).toContain("reply received");
    expect(text).not.toMatch(/sk_live_|enroll token: [^•]/);
  });
});
