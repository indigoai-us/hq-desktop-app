import { describe, expect, it } from "vitest";
import { publicSecret, shareSheet } from "../company/files-connect/files-connect-model.js";
import {
  BOT_POLICY_LABEL,
  clampBotPolicy,
  execSnippet,
  filterConnections,
  filterPersonalSecrets,
  fixturePersonalRail,
  metadata,
  personalSecretFromRaw,
  personalSecretsOnly,
  secretHasValue,
} from "./personal-rail-model.js";

describe("US-033 personal secrets and connections", () => {
  it("lists only personal-scope secrets when the page opens", () => {
    const mixed = [
      publicSecret({ name: "GITHUB_TOKEN", scope: "Personal", value: "ghp_secret" })!,
      publicSecret({ name: "ATTIO_API_KEY", scope: "Company", value: "sk-company" })!,
      publicSecret({ name: "SLACK_BOT_TOKEN", scope: "Indigo", value: "xoxb-nope" })!,
    ];
    const open = personalSecretsOnly(mixed);
    expect(open.map((row) => row.name)).toEqual(["GITHUB_TOKEN"]);
    expect(open.every((row) => row.scope === "Personal")).toBe(true);
    expect(JSON.stringify(open)).not.toContain("ghp_secret");
    expect(JSON.stringify(fixturePersonalRail().secrets)).not.toMatch(/ghp_|sk-|xoxb-/);
  });

  it("drops a value inside publicSecret before a personal row is built", () => {
    const row = personalSecretFromRaw({
      name: "OPENAI_API_KEY",
      scope: "personal",
      value: "sk-live-never",
      kind: "proxy",
    });
    expect(row?.name).toBe("OPENAI_API_KEY");
    expect(secretHasValue(row ?? {})).toBe(false);
    expect(JSON.stringify(row)).not.toContain("sk-live");
    expect(personalSecretFromRaw({ name: "STRIPE_SECRET_KEY", scope: "Company", value: "sk_live" })).toBeNull();
  });

  it("reuses the US-029 share sheet, name only", () => {
    const secret = fixturePersonalRail().secrets[0];
    expect(shareSheet({ name: secret.name, value: "should-not-travel" })).toEqual({
      name: "GITHUB_TOKEN",
      levels: ["read", "write"],
    });
    expect(execSnippet(secret.name)).toBe("hq secrets exec --only GITHUB_TOKEN");
  });

  it("names bot policy Allowed, Ask first, and Never", () => {
    expect(clampBotPolicy("allow")).toBe("allowed");
    expect(clampBotPolicy("never")).toBe("never");
    expect(clampBotPolicy("something")).toBe("ask");
    expect(BOT_POLICY_LABEL).toEqual({
      allowed: "Allowed",
      ask: "Ask first",
      never: "Never",
    });
    const agents = filterConnections(fixturePersonalRail().connections, "agents", "");
    expect(agents.some((row) => row.name === "GitHub")).toBe(true);
    expect(agents.every((row) => row.policy === "allowed" || row.policy === "ask" || row.policy === "never")).toBe(true);
  });

  it("keeps scroll inside the sidepane budget", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
    const stale = filterPersonalSecrets(fixturePersonalRail().secrets, "stale", "");
    expect(stale.map((row) => row.name)).toContain("SCREENPIPE_TOKEN");
  });
});
