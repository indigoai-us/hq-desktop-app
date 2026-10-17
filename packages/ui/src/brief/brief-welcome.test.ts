import { describe, expect, it } from "vitest";
import { parseWelcome, readRunWelcome, parseExclusions } from "./brief-welcome.js";

describe("welcome edition", () => {
  it("renders only explicit exclusion reasons and tolerates malformed metadata", () => {
    expect(parseExclusions([{company: "alpha", reason: "Open HQ in that company."}, null, {company: 12}])).toEqual([{company: "alpha", reason: "Open HQ in that company."}]);
    expect(parseExclusions({company: "alpha"})).toEqual([]);
  });
  it("preserves the skill's getting-started copy even after the first run", () => {
    expect(parseWelcome({first_run: false, getting_started: "A personal task first.", next_steps: [{kind: "connect_company", reason: "Join your team."}]})).toMatchObject({gettingStarted: "A personal task first.", nextSteps: ["Join your team."], connectCompany: true});
  });
  it("reads personal welcome content in the skill's schema", () => {
    expect(parseWelcome({ first_run: true, import: { skills: 4, conversations: 12 }, sessions: { total: 31 }, apps: ["Claude Code", "Codex"], next_steps: [{kind: "connect_company"}] })).toEqual({ skills: 4, conversations: 12, sessions: 31, apps: ["Claude Code", "Codex"], connectCompany: true });
  });
  it("ignores absent, failed and malformed welcome data", () => {
    for (const value of [null, {}, [], { error: "unavailable" }, "welcome"]) expect(parseWelcome(value)).toBeNull();
    expect(parseWelcome({first_run: true, apps: {}, sessions: {total: -5}, next_steps: "bad"})).toEqual({skills: 0, conversations: 0, sessions: 0, apps: [], connectCompany: false});
  });
  it("falls back to raw sweep welcome when synthesized output omits it", async () => {
    expect(await readRunWelcome({readHqFile: async p => p.endsWith("brief-data.json") ? JSON.stringify({welcome: {first_run: true}}) : "{}"}, "brief-20261017-090000")).not.toBeNull();
  });
});
