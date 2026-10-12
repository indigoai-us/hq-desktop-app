import { describe, expect, it, vi } from "vitest";

import type { IntegrationInstallInput } from "@hq/platform";

import { SIGNATURE_DOMAINS } from "./found-apps.js";
import { CANT_CONNECT_YET, LOOKUP_FAILED, createYourAppsHost, isHttpsUrl, readDocsDiscovery, readStepConnections, type YourAppsHostDeps } from "./your-apps-host.js";
import type { AppTile } from "./your-apps.js";

const ok = <T>(value: T) => ({ ok: true as const, value });
const fail = (status: number, code = "X") => ({ ok: false as const, error: { message: "nope" }, status, code }) as never;

function tile(over: Partial<AppTile> = {}): AppTile {
  return {
    domain: "linear.app",
    name: "Linear",
    kind: "Work",
    native: null,
    entryId: "e-linear",
    docsUrl: null,
    action: "connect",
    run: { state: "idle" },
    note: "",
    ...over,
  };
}

const SUMMARY_BEFORE = {
  viewer: { personUid: "prs_me", canManageIntegrations: true },
  connections: [
    { id: "c-slack", provider: "slack", status: "connected", installation: null },
    { id: "c-aws", provider: "factory:aws", status: "connected", origin: "first-run-auto", installation: { id: "inst-aws", domain: "api.aws", origin: "first-run-auto" } },
    { id: "c-old", provider: "factory:notion", status: "revoked", installation: { id: "inst-n", domain: "notion.com" } },
  ],
};

function deps(over: Partial<YourAppsHostDeps> = {}): YourAppsHostDeps {
  return { openUrl: vi.fn(), dry: false, pollMs: 1, timeoutMs: 50, ...over };
}

describe("readStepConnections", () => {
  it("keeps connected rows, the automatic marker and installation ids, and the viewer's role", () => {
    expect(readStepConnections(SUMMARY_BEFORE)).toEqual({
      connections: [
        { id: "c-slack", domain: null, provider: "slack" },
        { id: "c-aws", domain: "api.aws", provider: "aws", autoConnected: true },
      ],
      installations: { "c-aws": "inst-aws" },
      canManage: true,
    });
    expect(readStepConnections({ viewer: { canManageIntegrations: false }, connections: [] })?.canManage).toBe(false);
    expect(readStepConnections(null)).toBeNull();
  });
});

describe("readDocsDiscovery", () => {
  it("installs a verified no-auth server, signs in to an OAuth one, and stops at anything else", () => {
    const base = { ok: true, discoveryReceiptId: "r1" };
    expect(readDocsDiscovery({ ...base, discovery: { authMode: "none", verification: "verified" } })).toEqual({ next: "install", receiptId: "r1" });
    expect(readDocsDiscovery({ ...base, discovery: { authMode: "oauth", verification: "pending-auth" } })).toEqual({ next: "oauth", receiptId: "r1" });
    expect(readDocsDiscovery({ ...base, discovery: { authMode: "bearer", verification: "pending-auth" } })).toEqual({ next: "unsupported" });
    expect(readDocsDiscovery({ ok: true, cliDetection: { provider: "vercel" } })).toEqual({ next: "unsupported" });
    expect(readDocsDiscovery({ ok: true, discovery: { authMode: "none", verification: "verified" } })).toEqual({ next: "unsupported" });
  });
});

describe("createYourAppsHost", () => {
  it("loads the catalog for the whole fixed list and the connections", async () => {
    const catalogLookup = vi.fn(async () => ok({ ok: true, matches: { "linear.app": { entryId: "e-linear", name: "Linear", authClass: "oauth" } } }));
    const host = createYourAppsHost(deps({ catalogLookup, listConnections: async () => ok(SUMMARY_BEFORE) }));
    const load = await host.load("cmp_acme");
    expect(catalogLookup).toHaveBeenCalledWith("cmp_acme", SIGNATURE_DOMAINS);
    expect(load.catalog?.["linear.app"]?.authClass).toBe("oauth");
    expect(load.connections.map((c) => c.id)).toEqual(["c-slack", "c-aws"]);
    expect(load.installations).toEqual({ "c-aws": "inst-aws" });
    expect(load.canManage).toBe(true);
    expect(load.problem).toBeNull();
  });

  it("reports a failed catalog lookup with a retry", async () => {
    const host = createYourAppsHost(deps({ catalogLookup: async () => fail(502), listConnections: async () => ok(SUMMARY_BEFORE) }));
    const load = await host.load("cmp_acme");
    expect(load.catalog).toBeNull();
    expect(load.problem).toEqual({ reason: LOOKUP_FAILED, retry: true });
  });

  it("reports an unreadable connection list instead of guessing", async () => {
    const host = createYourAppsHost(deps({ listConnections: async () => fail(500) }));
    const load = await host.load("cmp_acme");
    expect(load.problem?.retry).toBe(true);
    expect(load.canManage).toBe(false);
  });

  it("auto-connects with the catalog entry and the first-run-auto origin, and returns the ids for Undo", async () => {
    const install = vi.fn(async (_input: IntegrationInstallInput) => ok({ ok: true, connection: { id: "c-new" }, installation: { id: "inst-new", origin: "first-run-auto" } }));
    const host = createYourAppsHost(deps({ install }));
    const res = await host.autoConnect("cmp_acme", "e-aws", "AWS Knowledge");
    expect(install).toHaveBeenCalledWith({ companyUid: "cmp_acme", catalogEntryId: "e-aws", origin: "first-run-auto" });
    expect(res).toEqual({ ok: true, connectionId: "c-new", installationId: "inst-new" });
  });

  it("connects by OAuth and answers once a new connection to the domain or a subdomain appears", async () => {
    let reads = 0;
    const listConnections = vi.fn(async () => {
      reads += 1;
      const rows = reads < 3 ? [] : [{ id: "c-lin", provider: "factory:linear", status: "connected", installation: { id: "i", domain: "mcp.linear.app" } }];
      return ok({ viewer: {}, connections: rows });
    });
    const openUrl = vi.fn();
    const startOAuth = vi.fn(async () => ok({ authorizationUrl: "https://linear.app/oauth/authorize?x=1" } as never));
    const host = createYourAppsHost(deps({ listConnections, startOAuth, openUrl }));
    const res = await host.connect("cmp_acme", tile());
    expect(startOAuth).toHaveBeenCalledWith({ companyUid: "cmp_acme", domain: "linear.app", catalogEntryId: "e-linear" });
    expect(openUrl).toHaveBeenCalledWith("https://linear.app/oauth/authorize?x=1");
    expect(res).toEqual({ ok: true, connectionId: "c-lin", installationId: null });
  });

  it("stops with a retry when the list before sign-in cannot be read (an old connection never counts as new)", async () => {
    let reads = 0;
    const listConnections = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return fail(500);
      return ok({ connections: [{ id: "c-old", provider: "factory:linear", status: "connected", installation: { domain: "linear.app" } }] });
    });
    const openUrl = vi.fn();
    const startOAuth = vi.fn(async () => ok({ authorizationUrl: "https://linear.app/oauth" } as never));
    const host = createYourAppsHost(deps({ listConnections, startOAuth, openUrl }));
    const res = await host.connect("cmp_acme", tile());
    expect(res).toMatchObject({ ok: false, retry: true });
    expect(startOAuth).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("isHttpsUrl accepts only well-formed https addresses", () => {
    expect(isHttpsUrl("https://linear.app/oauth")).toBe(true);
    expect(isHttpsUrl("https://")).toBe(false);
    expect(isHttpsUrl("http://linear.app")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl(null)).toBe(false);
  });

  it("does not open a non-https sign-in address", async () => {
    const openUrl = vi.fn();
    const host = createYourAppsHost(
      deps({ listConnections: async () => ok({ connections: [] }), startOAuth: async () => ok({ authorizationUrl: "javascript:alert(1)" } as never), openUrl }),
    );
    const res = await host.connect("cmp_acme", tile());
    expect(res.ok).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("times out a sign-in that never finishes, with a retry", async () => {
    let t = 0;
    const host = createYourAppsHost(
      deps({
        listConnections: async () => ok({ connections: [] }),
        startOAuth: async () => ok({ authorizationUrl: "https://x.example/a" } as never),
        now: () => (t += 20),
      }),
    );
    const res = await host.connect("cmp_acme", tile());
    expect(res).toMatchObject({ ok: false, retry: true });
  });

  it("refuses to connect a key or admin-only tile", async () => {
    const install = vi.fn();
    const host = createYourAppsHost(deps({ install }));
    expect((await host.connect("c", tile({ action: "needs-key" }))).ok).toBe(false);
    expect((await host.connect("c", tile({ action: "admin-only" }))).ok).toBe(false);
    expect(install).not.toHaveBeenCalled();
  });

  it("sets up from docs: a verified no-auth server installs with the receipt", async () => {
    const discoverDocs = vi.fn(async () => ok({ ok: true, discoveryReceiptId: "r1", discovery: { authMode: "none", verification: "verified" } }));
    const install = vi.fn(async () => ok({ connection: { id: "c-z" }, installation: { id: "i-z" } }));
    const host = createYourAppsHost(deps({ discoverDocs, install }));
    const res = await host.setup("cmp_acme", tile({ domain: "zoom.us", name: "Zoom", action: "setup", docsUrl: "https://developers.zoom.us/docs/mcp/" }));
    expect(discoverDocs).toHaveBeenCalledWith({ companyUid: "cmp_acme", docsUrl: "https://developers.zoom.us/docs/mcp/" });
    expect(install).toHaveBeenCalledWith({ companyUid: "cmp_acme", discoveryReceiptId: "r1" });
    expect(res).toEqual({ ok: true, connectionId: "c-z", installationId: "i-z" });
  });

  it("sets up from docs: an OAuth server signs in with the receipt", async () => {
    let reads = 0;
    const startOAuth = vi.fn(async () => ok({ authorizationUrl: "https://vercel.com/oauth" } as never));
    const host = createYourAppsHost(
      deps({
        discoverDocs: async () => ok({ ok: true, discoveryReceiptId: "r2", discovery: { authMode: "oauth", verification: "pending-auth" } }),
        startOAuth,
        listConnections: async () => {
          reads += 1;
          return ok({ connections: reads < 2 ? [] : [{ id: "c-v", provider: "factory:vercel", status: "connected", installation: { domain: "mcp.vercel.com" } }] });
        },
      }),
    );
    const res = await host.setup("cmp_acme", tile({ domain: "vercel.com", name: "Vercel", action: "setup", docsUrl: "https://vercel.com/docs/mcp/vercel-mcp" }));
    expect(startOAuth).toHaveBeenCalledWith({ companyUid: "cmp_acme", discoveryReceiptId: "r2" });
    expect(res).toMatchObject({ ok: true, connectionId: "c-v" });
  });

  it("ends as can't connect yet on 404, 409, 422, a key-only server or a CLI-only answer", async () => {
    const z = tile({ domain: "zoom.us", name: "Zoom", action: "setup", docsUrl: "https://developers.zoom.us/docs/mcp/" });
    for (const answer of [fail(404), fail(409), fail(422), ok({ ok: true, discoveryReceiptId: "r", discovery: { authMode: "bearer", verification: "pending-auth" } }), ok({ ok: true, cliDetection: {} })]) {
      const host = createYourAppsHost(deps({ discoverDocs: async () => answer }));
      expect(await host.setup("c", z)).toEqual({ ok: false, reason: CANT_CONNECT_YET("Zoom"), retry: false, unsupported: true });
    }
    const noDocs = createYourAppsHost(deps({ discoverDocs: vi.fn() }));
    expect((await noDocs.setup("c", { ...z, docsUrl: null })).ok).toBe(false);
  });

  it("a transient docs failure can be retried", async () => {
    const host = createYourAppsHost(deps({ discoverDocs: async () => fail(503) }));
    const res = await host.setup("c", tile({ action: "setup", docsUrl: "https://x.example/d" }));
    expect(res).toMatchObject({ ok: false, retry: true });
  });

  it("undoes by installation id", async () => {
    const uninstall = vi.fn(async () => ok({ ok: true }));
    const host = createYourAppsHost(deps({ uninstall }));
    expect(await host.undo("cmp_acme", "inst-aws")).toEqual({ ok: true, connectionId: null, installationId: "inst-aws" });
    expect(uninstall).toHaveBeenCalledWith({ companyUid: "cmp_acme", installationId: "inst-aws" });
    const failing = createYourAppsHost(deps({ uninstall: async () => fail(500) }));
    expect((await failing.undo("c", "i")).ok).toBe(false);
  });

  it("a dry walk pretends and calls nothing", async () => {
    const install = vi.fn();
    const host = createYourAppsHost(deps({ dry: true, delayMs: 1, install }));
    expect((await host.autoConnect("c", "e", "n")).ok).toBe(true);
    expect((await host.connect("c", tile())).ok).toBe(true);
    expect(install).not.toHaveBeenCalled();
  });

  it("detect answers null when the host has no scan or it fails", async () => {
    expect(await createYourAppsHost(deps()).detect()).toBeNull();
    expect(await createYourAppsHost(deps({ detectWorkApps: async () => fail(500) })).detect()).toBeNull();
  });
});
