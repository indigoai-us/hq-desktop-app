import { describe, expect, it } from "vitest";
import {
  findDeploySources,
  companyDeploymentRows,
  legacyDeploymentRow,
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
  companyIntegrationRows,
  emptyCompanyCache,
} from "./files-connect-model.js";
import {
  appMetaLine,
  appStatusSummary,
  catalogFailureLine,
  catalogIntegrationRows,
  filterIntegrationApps,
  groupIntegrationApps,
  integrationHealth,
} from "./integration-apps.js";
import { integrationDisplayName, integrationDomain, registrableDomain } from "../../common/integration-display.js";

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

describe("company deployment rows (QA-013)", () => {
  it("uses the legacy subdomain field instead of a placeholder name", () => {
    const row = legacyDeploymentRow({ sub: "board-v2", url: "board-v2.indigo-hq.com", state: "active" }, "indigo", 0);
    expect(row.name).toBe("board-v2");
    expect(row.url).toBe("https://board-v2.indigo-hq.com");
  });

  it("maps hq-deploy apps through the shared client mapping", () => {
    const rows = companyDeploymentRows(
      { apps: [{ id: "1", name: "real", subdomain: "real", url: "https://real.indigo-hq.com", active: false }, 7] },
      "indigo",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("real");
    expect(rows[0]!.status).toBe("off");
  });
});

describe("findDeploySources (QA-044)", () => {
  const d = (path: string) => ({ name: path.split("/").pop()!, path, isDir: true });
  const f = (path: string) => ({ name: path.split("/").pop()!, path, isDir: false });
  const P = "companies/acme/projects";

  it("lists project folders that hold an index.html, from the real listing", async () => {
    const tree: Record<string, ReturnType<typeof d>[]> = {
      [P]: [d(`${P}/site`), d(`${P}/notes`)],
      [`${P}/site`]: [d(`${P}/site/dist`), d(`${P}/site/node_modules`)],
      [`${P}/site/dist`]: [f(`${P}/site/dist/index.html`)],
      [`${P}/site/node_modules`]: [f(`${P}/site/node_modules/index.html`)],
      [`${P}/notes`]: [f(`${P}/notes/README.md`)],
    };
    const scan = await findDeploySources("acme", async (path) => tree[path] ?? []);
    expect(scan.reason).toBeNull();
    expect(scan.sources).toEqual([{ id: `${P}/site/dist`, project: "site", path: `${P}/site/dist`, dir: "dist" }]);
  });

  it("says why nothing is deployable", async () => {
    const none = await findDeploySources("acme", async () => []);
    expect(none.sources).toEqual([]);
    expect(none.reason).toMatch(/no projects yet/);
    const unbuilt = await findDeploySources("acme", async (path) => (path === P ? [d(`${P}/a`), d(`${P}/b`)] : []));
    expect(unbuilt.reason).toMatch(/None of this company's 2 projects has a built web page/);
  });

  it("throws when the projects folder cannot be read", async () => {
    await expect(findDeploySources("acme", async () => { throw new Error("denied"); })).rejects.toThrow("denied");
  });
});

describe("integration display names (shared with the chat connection cards)", () => {
  it("prefers the installation's display name", () => {
    expect(integrationDisplayName({ provider: "factory:linear", installation: { displayName: " Linear (Acme) " } })).toBe("Linear (Acme)");
  });

  it("drops factory:, transport words and the install hash", () => {
    expect(integrationDisplayName({ provider: "factory:linear" })).toBe("Linear");
    expect(integrationDisplayName({ provider: "factory:remote_mcp_posthog_com_e755da2a91c4" })).toBe("PostHog");
    expect(integrationDisplayName({ provider: "factory:remote-mcp-posthog-com-e755da2a" })).toBe("PostHog");
    expect(integrationDisplayName({ provider: "factory:remote_mcp_acme_io_0a1b2c3d4e" })).toBe("Acme");
    expect(integrationDisplayName({ provider: "managed-slack" })).toBe("Slack");
    expect(integrationDisplayName({ provider: "factory:google-drive" })).toBe("Google Drive");
    expect(integrationDisplayName({ provider: "remote_mcp_server" })).toBe("Remote MCP Server");
    expect(integrationDisplayName({ provider: "" })).toBe("App");
  });

  it("finds the app's website for its brand mark", () => {
    expect(integrationDomain({ provider: "factory:remote_mcp_posthog_com_e755da2a" })).toBe("posthog.com");
    expect(integrationDomain({ provider: "factory:x", installation: { domain: "mcp.linear.app" } })).toBe("linear.app");
    expect(integrationDomain({ provider: "linear" })).toBe("linear.app");
    expect(integrationDomain({ provider: "factory:unknownthing" })).toBe("");
    expect(registrableDomain("https://www.notion.so/product")).toBe("notion.so");
    expect(registrableDomain("not a host")).toBeNull();
  });
});

describe("integration health (console connStatus)", () => {
  it("maps connected, revoked and fault states", () => {
    expect(integrationHealth({ status: "connected" })).toMatchObject({ state: "active", label: "Active" });
    expect(integrationHealth({ status: "revoked" })).toMatchObject({ state: "disconnected", label: "Disconnected" });
    expect(integrationHealth({ status: "needs-reauth" })).toMatchObject({ state: "needs-sign-in", label: "Needs sign-in" });
    // error and degraded used to read "Disconnected"; they need attention.
    expect(integrationHealth({ status: "error" })).toMatchObject({ state: "needs-attention", label: "Needs attention" });
    expect(integrationHealth({ status: "degraded" })).toMatchObject({ state: "needs-attention", reason: "Partly working." });
    // A status hq-pro adds later fails closed.
    expect(integrationHealth({ status: "paused_by_admin" }).state).toBe("needs-attention");
  });

  it("reads reason codes, the access-key wait and the server fix path", () => {
    expect(integrationHealth({ status: "connected", errorReason: "oauth_token_expired" })).toMatchObject({
      state: "needs-sign-in",
      reason: "The saved sign-in expired.",
    });
    expect(integrationHealth({ status: "error", errorReason: "http_429", fix_path: "Ask an admin to reconnect it." })).toMatchObject({
      state: "needs-attention",
      reason: "The app turned the request away (error 429).",
      fixPath: "Ask an admin to reconnect it.",
    });
    expect(integrationHealth({ status: "connected", installation: { status: "needs_credentials" } })).toMatchObject({
      state: "needs-attention",
      reason: "Waiting for an access key before agents can use it.",
    });
    // `unspecified` is no diagnosis, and provider text is never echoed.
    expect(integrationHealth({ status: "connected", errorReason: "unspecified" }).state).toBe("active");
    expect(integrationHealth({ status: "error", errorReason: "token=abc leaked" }).reason).toBe("");
  });

  it("feeds the connected rows", () => {
    const rows = companyIntegrationRows({
      connections: [
        { id: "a", provider: "factory:linear", status: "degraded", degradedReason: "upstream_503" },
        { id: "b", provider: "slack", status: "revoked" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Linear", domain: "linear.app", appKey: "linear.app", status: "needs-attention", reason: "The app is temporarily unavailable." });
  });
});

describe("integrations grouped by app (console groupByApp)", () => {
  const rows = companyIntegrationRows({
    connections: [
      { id: "1", provider: "factory:linear", status: "connected", createdByName: "Ada" },
      { id: "2", provider: "linear", status: "needs-reauth", createdByName: "Bo" },
      { id: "3", provider: "factory:remote_mcp_posthog_com_e755da2a", status: "connected" },
      { id: "4", provider: "factory:remote_mcp_posthog_com_99ffee11", status: "connected" },
      { id: "5", provider: "slack", status: "connected" },
    ],
  });

  it("puts every connection of one app under one row", () => {
    const apps = groupIntegrationApps(rows);
    expect(apps.map((app) => [app.name, app.domain, app.connections.length, app.category])).toEqual([
      ["Linear", "linear.app", 2, "Work"],
      ["PostHog", "posthog.com", 2, "Analytics"],
      ["Slack", "slack.com", 1, "Comms"],
    ]);
    expect(appMetaLine(apps[0]!)).toBe("2 connections · Work");
    expect(appMetaLine(apps[2]!)).toBe("1 connection · Comms");
  });

  it("summarizes status with the worst state first", () => {
    const [linear, posthog] = groupIntegrationApps(rows);
    expect(appStatusSummary(linear!)).toEqual({ state: "needs-attention", text: "Needs attention" });
    expect(appStatusSummary(posthog!)).toEqual({ state: "active", text: "2 active" });
    expect(appStatusSummary({ connections: [] })).toEqual({ state: "disconnected", text: "Disconnected" });
    const two = groupIntegrationApps(
      companyIntegrationRows({ connections: [{ id: "x", provider: "notion", status: "error" }, { id: "y", provider: "notion", status: "degraded" }] }),
    );
    expect(appStatusSummary(two[0]!).text).toBe("2 need attention");
  });

  it("filters apps by name, website or a connection's detail", () => {
    const apps = groupIntegrationApps(rows);
    expect(filterIntegrationApps(apps, "posthog.com").map((a) => a.name)).toEqual(["PostHog"]);
    expect(filterIntegrationApps(apps, "bo").map((a) => a.name)).toEqual(["Linear"]);
    expect(filterIntegrationApps(apps, "")).toHaveLength(3);
  });
});

describe("the Available catalog (factory catalog, not a fixed list)", () => {
  it("reads catalog entries into available rows", () => {
    const rows = catalogIntegrationRows({
      ok: true,
      entries: [
        { name: "Canva", domain: "canva.com", description: "Design tools", authClass: "oauth", entryId: "ent_1" },
        { domain: "mcp.linear.app", authClass: "oauth" },
        { name: "Canva", domain: "canva.com", entryId: "ent_1" },
        { description: "no name or domain" },
      ],
    });
    expect(rows.map((r) => [r.id, r.name, r.domain, r.kind, r.status])).toEqual([
      ["catalog:ent_1", "Canva", "canva.com", "available", "available"],
      ["catalog:linear.app", "Linear", "linear.app", "available", "available"],
    ]);
    expect(rows[0]!.detail).toBe("Design tools");
    expect(rows[1]!.detail).toBe("Sign in with your browser");
    expect(() => catalogIntegrationRows({ error: "boom" })).toThrow();
  });

  it("explains a refused catalog in plain words", () => {
    expect(catalogFailureLine({ status: 403, message: "HTTP 403 INTEGRATION_FACTORY_FORBIDDEN" })).toEqual({
      line: "Only company owners and admins can browse apps to connect.",
      retry: false,
    });
    expect(catalogFailureLine({ status: 403, message: "INTEGRATION_FACTORY_DISABLED" }).retry).toBe(false);
    expect(catalogFailureLine({ status: 500, message: "HTTP 500 {\"error\":\"boom\"}" })).toEqual({
      line: "Could not load apps to connect.",
      retry: true,
    });
  });

  it("starts a company with no catalog rows; the catalog loads from hq-pro", () => {
    expect(emptyCompanyCache().integrations).toEqual([]);
  });
});
