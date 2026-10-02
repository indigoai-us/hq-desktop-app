import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS,
  acceptSecretKey,
  applyDeepLink,
  beginConnect,
  clampAccess,
  deployPrompt,
  filterSecrets,
  fixtureCache,
  metadata,
  publicSecret,
  redeployAllowed,
  redeployPrompt,
  shareSheet,
} from "./files-connect-model.js";

describe("US-029 files and connect", () => {
  it("offers only read and write for grant and share", () => {
    expect([...ACCESS_LEVELS]).toEqual(["read", "write"]);
    expect(clampAccess("admin")).toBe("read");
    expect(clampAccess("write")).toBe("write");
    expect(shareSheet({ name: "ATTIO_API_KEY", value: "sk-live-secret" })).toEqual({
      name: "ATTIO_API_KEY",
      levels: ["read", "write"],
    });
  });

  it("strips secret values before a row can render", () => {
    const row = publicSecret({
      name: "STRIPE_SECRET_KEY",
      value: "sk_live_should_never_render",
      kind: "standard",
    });
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk_live");
    expect(row?.name).toBe("STRIPE_SECRET_KEY");
  });

  it("accepts paste and drop on secret fields and rejects typed keys", () => {
    expect(acceptSecretKey("insertFromPaste")).toBe(true);
    expect(acceptSecretKey("insertFromDrop")).toBe(true);
    expect(acceptSecretKey("insertText")).toBe(false);
  });

  it("opens connect in the system browser and waits for the deep link", () => {
    const session = beginConnect("Slack");
    expect(session.phase).toBe("waiting");
    expect(session.url).toContain("Slack");
    expect(applyDeepLink(session, "https://example.com").phase).toBe("waiting");
    expect(applyDeepLink(session, "hq://oauth?code=abc").phase).toBe("returned");
  });

  it("routes deploy and confirmed redeploy through /deploy", () => {
    expect(deployPrompt("indigo", "standup-brief")).toContain("/deploy indigo");
    expect(redeployAllowed(false)).toBe(false);
    expect(redeployAllowed(true)).toBe(true);
    expect(redeployPrompt("indigo", "docs")).toContain("Redeploy docs");
    expect(redeployPrompt("indigo", "docs")).toContain("/deploy indigo");
  });

  it("keeps the scroll budget on the page metadata", () => {
    expect(metadata.performanceBudget.scrollDroppedFramesPct).toBeLessThanOrEqual(0.01);
    expect(metadata.performanceBudget.worstFrameMs).toBeLessThanOrEqual(33);
    expect(filterSecrets(fixtureCache().secrets, "proxy", "").map((row) => row.name)).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
  });
});
