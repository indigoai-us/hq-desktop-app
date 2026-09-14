import { describe, expect, it } from "vitest";

import { botKindFor, botKindLabel } from "./bot-kind.js";

const LOCAL = [{ agentUid: "agt_01SCOUT" }, { agentUid: " agt_01PADDED " }];

describe("botKindFor", () => {
  it("is null for humans, empty, and missing uids", () => {
    expect(botKindFor("prs_marcus", LOCAL)).toBeNull();
    expect(botKindFor("", LOCAL)).toBeNull();
    expect(botKindFor("   ", LOCAL)).toBeNull();
    expect(botKindFor(null, LOCAL)).toBeNull();
    expect(botKindFor(undefined, LOCAL)).toBeNull();
  });

  it("is local when one of the user's local bots owns the uid", () => {
    expect(botKindFor("agt_01SCOUT", LOCAL)).toBe("local");
    // Whitespace on either side never changes the verdict.
    expect(botKindFor(" agt_01SCOUT ", LOCAL)).toBe("local");
    expect(botKindFor("agt_01PADDED", LOCAL)).toBe("local");
  });

  it("is cloud for every other bot uid, including agent_ and agent: forms", () => {
    expect(botKindFor("agt_374A1JY3NE63KSYBN97PND4QGC", LOCAL)).toBe("cloud");
    expect(botKindFor("agent_fleet", LOCAL)).toBe("cloud");
    expect(botKindFor("agent:izzy", LOCAL)).toBe("cloud");
    expect(botKindFor("agt_01SCOUT", [])).toBe("cloud");
    expect(botKindFor("agt_01SCOUT", null)).toBe("cloud");
    expect(botKindFor("agt_01SCOUT", undefined)).toBe("cloud");
  });
});

describe("botKindLabel", () => {
  it("names the kind, with the runtime for local bots", () => {
    expect(botKindLabel("cloud")).toBe("Cloud");
    expect(botKindLabel("cloud", "claude")).toBe("Cloud");
    expect(botKindLabel("local")).toBe("Local");
    expect(botKindLabel("local", null)).toBe("Local");
    expect(botKindLabel("local", "  ")).toBe("Local");
    expect(botKindLabel("local", "claude")).toBe("Local · Claude Code");
    expect(botKindLabel("local", "codex")).toBe("Local · Codex");
    expect(botKindLabel("local", "grok")).toBe("Local · Grok");
  });

  it("falls back to the raw runtime id when it is not a known runtime", () => {
    expect(botKindLabel("local", "mystery")).toBe("Local · mystery");
  });
});
