import { describe, expect, it } from "vitest";

import { evidenceLine, matchFoundApps, type FoundApp } from "./found-apps.js";
import {
  YOUR_APPS_COPY,
  autoConnectPlan,
  fallbackFoundApps,
  yourAppsConsentLine,
  yourAppsHandoff,
  connectedCount,
  yourAppsLead,
  yourAppsStatus,
  yourAppsView,
  type CatalogMatch,
  type StepConnection,
  type YourAppsInput,
} from "./your-apps.js";

const found: FoundApp[] = matchFoundApps({
  platform: "macos",
  scannedAtMs: 1,
  apps: [
    { bundleId: "com.linear", name: "Linear" },
    { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
    { bundleId: "us.zoom.xos", name: "zoom.us" },
    { bundleId: "com.microsoft.teams2", name: "Microsoft Teams" },
    { bundleId: "com.docker.docker", name: "Docker" },
    { bundleId: "dev.example.other", name: "Other" },
  ],
  mcpServers: [
    { tool: "claude_code", name: "supabase", transport: "http", host: "mcp.supabase.com", local: false, hasCredentialFields: false, enabled: true },
    { tool: "codex", name: "posthog", transport: "http", host: "mcp.posthog.com", local: false, hasCredentialFields: true, enabled: true },
    { tool: "codex", name: "aws", transport: "http", host: "knowledge-mcp.global.api.aws", local: false, hasCredentialFields: false, enabled: true },
  ],
  sources: [],
  truncated: false,
}).apps;

const all = found;

const catalog: Record<string, CatalogMatch | null> = {
  "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" },
  "supabase.com": { entryId: "e-supabase", name: "Supabase", authClass: "oauth" },
  "posthog.com": { entryId: "e-posthog", name: "PostHog", authClass: "key" },
  "api.aws": { entryId: "e-aws", name: "AWS Knowledge", authClass: "none" },
  "zoom.us": null,
};

function input(over: Partial<YourAppsInput> = {}): YourAppsInput {
  return {
    found: all,
    unmatched: 1,
    catalog,
    connections: [{ id: "c-slack", domain: null, provider: "slack" }],
    canManage: true,
    runs: {},
    evidence: (app) => evidenceLine(app.evidence),
    ...over,
  };
}

describe("yourAppsView", () => {
  it("groups by status: team connections, catalog apps, docs-path apps, apps HQ does not offer", () => {
    const view = yourAppsView(input());
    expect(view.connected).toEqual([
      { domain: "slack.com", name: "Slack", how: "team", connectionId: "c-slack", installationId: null, canUndo: false, undoing: false },
    ]);
    expect(view.ready.map((t) => [t.domain, t.action, t.note])).toEqual([
      ["linear.app", "connect", "Mac app"],
      ["supabase.com", "connect", "In Claude Code"],
      ["posthog.com", "needs-key", YOUR_APPS_COPY.needsKey],
      ["api.aws", "install", "In Codex"],
    ]);
    expect(view.notInHq.map((t) => [t.domain, t.action, t.note])).toEqual([
      ["zoom.us", "setup", "Meetings"],
      ["teams.microsoft.com", "not-yet", YOUR_APPS_COPY.cantYet],
    ]);
    expect(view.alsoFound).toEqual(["Docker"]);
    expect(view.unmatched).toBe(1);
    expect(view.foundCount).toBe(all.length + 1);
  });

  it("a member sees every connectable app as admin-only and nothing to set up", () => {
    const view = yourAppsView(input({ canManage: false }));
    expect(new Set(view.ready.map((t) => t.action))).toEqual(new Set(["admin-only"]));
    expect(view.ready.every((t) => t.note === YOUR_APPS_COPY.adminOnly)).toBe(true);
    expect(view.notInHq.find((t) => t.domain === "zoom.us")?.action).toBe("admin-only");
  });

  it("shows run states on the tile and moves connected apps to the chips", () => {
    const view = yourAppsView(
      input({
        runs: {
          "supabase.com": { state: "connecting", via: "browser" },
          "linear.app": { state: "failed", reason: "Linear did not finish connecting. Try again.", retry: true },
          "zoom.us": { state: "checking-docs" },
          "api.aws": { state: "connected", how: "auto", connectionId: "c-aws", installationId: "inst-aws" },
        },
      }),
    );
    const tile = (d: string) => [...view.ready, ...view.notInHq].find((t) => t.domain === d);
    expect(tile("supabase.com")?.note).toBe(YOUR_APPS_COPY.inBrowser);
    // The reason itself is the visible note (not hidden in a tooltip).
    expect(tile("linear.app")?.note).toBe("Linear did not finish connecting. Try again.");
    expect(tile("zoom.us")?.note).toBe(YOUR_APPS_COPY.readingGuide);
    expect(view.connected.find((c) => c.domain === "api.aws")).toEqual({
      domain: "api.aws",
      name: "AWS Knowledge",
      how: "auto",
      connectionId: "c-aws",
      installationId: "inst-aws",
      canUndo: true,
      undoing: false,
    });
    expect(connectedCount(view)).toBe(2);
  });

  it("offers no Undo for an automatic connection whose installation is not known", () => {
    const view = yourAppsView(input({ runs: { "api.aws": { state: "connected", how: "auto", connectionId: "c-aws", installationId: null } } }));
    expect(view.connected.find((c) => c.domain === "api.aws")).toMatchObject({ how: "auto", installationId: null, canUndo: false });
  });

  it("matches a connection with no domain only on a provider slug that names the app", () => {
    const aws = yourAppsView(input({ connections: [{ id: "c", domain: null, provider: "aws" }] }));
    expect(aws.connected.map((c) => c.domain)).toContain("api.aws");
    // "api" is a generic label: a provider called "api" matches nothing.
    const generic = yourAppsView(input({ connections: [{ id: "c", domain: null, provider: "api" }] }));
    expect(generic.connected.map((c) => c.domain)).not.toContain("api.aws");
  });

  it("an unsupported docs result ends as not-yet with no retry", () => {
    const view = yourAppsView(input({ runs: { "zoom.us": { state: "unsupported" } } }));
    expect(view.notInHq.find((t) => t.domain === "zoom.us")).toMatchObject({ action: "not-yet", note: YOUR_APPS_COPY.cantYet });
  });

  it("matches connections on a subdomain and marks hq-pro's auto-connected record", () => {
    const view = yourAppsView(
      input({ connections: [{ id: "c-lin", domain: "mcp.linear.app", provider: "linear" }, { id: "c-aws", domain: "api.aws", provider: "aws", autoConnected: true }] }),
    );
    expect(view.connected.map((c) => [c.domain, c.how])).toEqual([
      ["linear.app", "team"],
      ["api.aws", "auto"],
    ]);
  });

  it("handles a failed catalog lookup as nothing in the catalog", () => {
    const view = yourAppsView(input({ catalog: null }));
    expect(view.ready.map((t) => t.domain)).toEqual([]);
    expect(view.notInHq.map((t) => t.domain)).toContain("linear.app");
  });
});

describe("autoConnectPlan", () => {
  it("only owner/admin, only authClass none, only not yet connected or undone", () => {
    expect(autoConnectPlan(input(), new Set())).toEqual([{ domain: "api.aws", entryId: "e-aws" }]);
    expect(autoConnectPlan(input({ canManage: false }), new Set())).toEqual([]);
    expect(autoConnectPlan(input(), new Set(["api.aws"]))).toEqual([]);
    const connected: StepConnection[] = [{ id: "c", domain: "api.aws", provider: "aws" }];
    expect(autoConnectPlan(input({ connections: connected }), new Set())).toEqual([]);
    expect(autoConnectPlan(input({ catalog: null }), new Set())).toEqual([]);
  });

  it("skips an app already connecting, connected or failed in this step (Retry never installs twice)", () => {
    for (const run of [
      { state: "connecting", via: "install" },
      { state: "connected", how: "auto", connectionId: "c", installationId: "i" },
      { state: "failed", reason: "r", retry: true },
    ] as const) {
      expect(autoConnectPlan({ ...input(), runs: { "api.aws": run } }, new Set())).toEqual([]);
    }
    expect(autoConnectPlan({ ...input(), runs: { "api.aws": { state: "idle" } } }, new Set())).toEqual([{ domain: "api.aws", entryId: "e-aws" }]);
  });

  it("never plans an app that needs a sign-in or a key", () => {
    const planned = autoConnectPlan(input(), new Set()).map((p) => p.domain);
    expect(planned).not.toContain("linear.app");
    expect(planned).not.toContain("posthog.com");
    expect(planned).not.toContain("slack.com");
  });
});

describe("copy", () => {
  it("leads with the count, or the nothing-found line", () => {
    expect(yourAppsLead(20, "Atlas", "Mac")).toBe("We found 20 work apps on this Mac. Connect any you want Atlas to use.");
    expect(yourAppsLead(1, "", "PC")).toBe("We found 1 work app on this PC. Connect any you want your assistant to use.");
    expect(yourAppsLead(0, "Atlas", "Mac")).toMatch(/^We didn't find work apps on this Mac\./);
    expect(yourAppsStatus(3, "Northwind")).toBe("3 connected to Northwind. You can connect more later from Integrations.");
    expect(yourAppsStatus(0, "Northwind")).toMatch(/^Nothing connected yet\./);
  });

  it("has no em dashes", () => {
    const all = [...Object.values(YOUR_APPS_COPY), yourAppsLead(2, "a", "Mac"), yourAppsLead(0, "a", "Mac"), yourAppsStatus(1, "x")];
    for (const line of all) expect(line).not.toContain("—");
  });
});

describe("native providers, fallback and handoff", () => {
  it("sends Google Workspace to Integrations, and tells Slack to connect later with no sign-in here", () => {
    const view = yourAppsView(input({ connections: [] }));
    expect(view.ready.find((t) => t.domain === "slack.com")).toMatchObject({ action: "later", native: "slack", note: YOUR_APPS_COPY.later });
    expect(YOUR_APPS_COPY.later).toBe("Connect later in Integrations");
  });

  it("lets an owner undo an earlier automatic connection, never a member", () => {
    const connections: StepConnection[] = [{ id: "c-aws", domain: "api.aws", provider: "aws", autoConnected: true }];
    const installations = { "c-aws": "inst-aws" };
    expect(yourAppsView(input({ connections, installations })).connected.find((c) => c.domain === "api.aws")).toMatchObject({ canUndo: true, installationId: "inst-aws" });
    expect(yourAppsView(input({ connections, installations, canManage: false })).connected.find((c) => c.domain === "api.aws")?.canUndo).toBe(false);
    // The list did not say which installation it is: no Undo that would do nothing.
    expect(yourAppsView(input({ connections })).connected.find((c) => c.domain === "api.aws")?.canUndo).toBe(false);
  });

  it("offers the catalog's note takers and project tools when nothing was found", () => {
    const apps = fallbackFoundApps({ "fireflies.ai": { entryId: "f", name: "Fireflies", authClass: "oauth" }, "linear.app": { entryId: "l", name: "Linear", authClass: "oauth" }, "zoom.us": null });
    expect(apps.map((a) => a.domain)).toEqual(["fireflies.ai", "linear.app"]);
    expect(fallbackFoundApps(null)).toEqual([]);
  });

  it("hands off the first note taker and project tool, and the rest as others", () => {
    const view = yourAppsView(
      input({
        runs: {
          "linear.app": { state: "connected", how: "person", connectionId: "c1" },
          "api.aws": { state: "connected", how: "auto", connectionId: "c2" },
        },
      }),
    );
    const kinds = Object.fromEntries(all.map((a) => [a.domain, a.kind]));
    expect(yourAppsHandoff(view, kinds)).toEqual({
      notes: null,
      projects: { name: "Linear", domain: "linear.app" },
      others: [
        { name: "Slack", domain: "slack.com" },
        { name: "AWS Knowledge", domain: "api.aws" },
      ],
    });
  });
});

describe("consent", () => {
  it("is the owner's line on a Mac, and names the computer elsewhere", () => {
    expect(yourAppsConsentLine("Mac")).toBe("It also lists the work apps on this Mac by name, never their passwords or keys, so you can connect them next.");
    expect(yourAppsConsentLine("PC")).toContain("on this PC by name");
    expect(yourAppsConsentLine("computer")).toContain("on this computer by name");
    expect(yourAppsConsentLine("Mac")).not.toContain("\u2014");
  });
});
