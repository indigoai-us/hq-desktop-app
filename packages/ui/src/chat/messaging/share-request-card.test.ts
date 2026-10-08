import { describe, expect, it } from "vitest";
import {
  accessDecisionActionId,
  parseShareRequestEvent,
  shareOpenInClaudeUrl,
  sharePrompt,
} from "./share-request-card";

describe("US-015 share and access-request envelopes (home-share-request)", () => {
  it("parses a shared folder with its files", () => {
    const model = parseShareRequestEvent({
      v: 1,
      type: "vault_share",
      id: "shr_1",
      path: "companies/indigo/projects/x/copy/",
      level: "read",
      sharedBy: "Hassaan",
      files: [{ name: "welcome-v2.md", size: 4198 }, "signin-steps.md"],
    });
    expect(model).toMatchObject({
      kind: "shared_folder",
      id: "shr_1",
      level: "read",
      sharedBy: "Hassaan",
      files: [
        { name: "welcome-v2.md", sizeLabel: "4.1 KB" },
        { name: "signin-steps.md", sizeLabel: null },
      ],
    });
  });

  it("parses an access request and only allows read or write levels", () => {
    const model = parseShareRequestEvent({
      type: "access_request",
      requestId: "req_9",
      path: "companies/indigo/projects/hq-desktop-console-rail/",
      level: "admin",
      status: "pending",
    });
    expect(model).toMatchObject({ kind: "access_request", id: "req_9", level: "read", state: "pending", canAct: true });
    expect(parseShareRequestEvent({ type: "access_request", path: "p/", level: "write" })?.level).toBe("write");
  });

  it("rejects unknown types, versions, and envelopes with no path", () => {
    expect(parseShareRequestEvent({ type: "deploy", path: "p/" })).toBeNull();
    expect(parseShareRequestEvent({ v: 2, type: "vault_share", path: "p/" })).toBeNull();
    expect(parseShareRequestEvent({ type: "vault_share" })).toBeNull();
    expect(parseShareRequestEvent("nope")).toBeNull();
  });

  it("builds the prompt, the Claude Code link, and the decision action ids", () => {
    const model = parseShareRequestEvent({ type: "vault_share", path: "a/b/" })!;
    expect(sharePrompt(model)).toContain("a/b/");
    const url = shareOpenInClaudeUrl(model, "/Users/me/HQ");
    expect(url.startsWith("claude://code/new?")).toBe(true);
    expect(new URL(url.replace("claude://", "https://x/")).searchParams.get("folder")).toBe("/Users/me/HQ");
    expect(accessDecisionActionId("approve", "read")).toBe("grant_read");
    expect(accessDecisionActionId("approve", "write")).toBe("grant_write");
    expect(accessDecisionActionId("deny", "write")).toBe("deny");
  });
});
