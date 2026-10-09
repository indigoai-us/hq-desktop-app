import { describe, expect, it, vi } from "vitest";
import { ok } from "@hq/platform";

import { CONNECT_ABORTED, CREATE_UNAVAILABLE, createFirstRunAppsHost, createFirstRunTeamHost } from "./first-run-hosts.js";
import type { FirstRunApp } from "./app-step.js";

const ACME = { companyUid: "cmp_acme", slug: "acme", name: "Acme" };
const app = (domain: string, authClass: FirstRunApp["authClass"]): FirstRunApp => ({
  domain,
  name: domain.split(".")[0]!,
  description: "",
  entryId: authClass === "oauth" ? `cat_${domain}` : null,
  authClass,
});

describe("team host", () => {
  it("joins through the invite claim, then pins and refreshes", async () => {
    const claimInvite = vi.fn(async () => ok({ ok: true, claimedSlugs: ["acme"] }));
    const joined = vi.fn();
    const host = createFirstRunTeamHost({ claimInvite, joined, dry: false });
    expect(await host.join(ACME)).toEqual({ ok: true, choice: { kind: "company", how: "joined", company: ACME } });
    expect(claimInvite).toHaveBeenCalledWith("acme");
    expect(joined).toHaveBeenCalledWith("cmp_acme");
  });

  it("a refused claim is a plain sentence, never the server's text", async () => {
    const host = createFirstRunTeamHost({
      claimInvite: async () => ({ ok: false, reason: "error", code: "http-500", message: "stack trace here" }),
      dry: false,
    });
    expect(await host.join(ACME)).toEqual({ ok: false, reason: "Couldn't join the company. Try again." });
  });

  it("creates through the create card with a handle made from the name", async () => {
    const createCompany = vi.fn(async () => ({ ok: true as const, companyUid: "cmp_new" }));
    const host = createFirstRunTeamHost({ createCompany, dry: false });
    expect(await host.create("Pickle Works")).toEqual({
      ok: true,
      choice: { kind: "company", how: "created", company: { companyUid: "cmp_new", slug: "pickle-works", name: "Pickle Works" } },
    });
    expect(createCompany).toHaveBeenCalledWith("Pickle Works", "pickle-works");
    expect(await createFirstRunTeamHost({ dry: false }).create("Pickle Works")).toEqual({ ok: false, reason: CREATE_UNAVAILABLE });
  });

  it("a dry walk joins and creates nothing", async () => {
    const claimInvite = vi.fn();
    const createCompany = vi.fn();
    const host = createFirstRunTeamHost({ claimInvite, createCompany, dry: true, delayMs: 0 });
    expect((await host.join(ACME)).ok).toBe(true);
    expect((await host.create("Pickle Works")).ok).toBe(true);
    expect(claimInvite).not.toHaveBeenCalled();
    expect(createCompany).not.toHaveBeenCalled();
  });
});

describe("apps host", () => {
  const catalog = { ok: true, entries: [{ name: "Granola", domain: "granola.ai", authClass: "none" }, { name: "Linear", domain: "linear.app" }] };

  it("reads the catalog once per screen and marks apps already connected", async () => {
    const catalogSearch = vi.fn(async () => ok(catalog));
    const listConnections = vi.fn(async () =>
      ok({ connections: [{ id: "c1", provider: "factory:granola", status: "connected", createdAt: "2026-01-01", installation: { domain: "granola.ai" } }] }),
    );
    const host = createFirstRunAppsHost({ catalogSearch, listConnections, openUrl: vi.fn(), dry: false });
    const notes = await host.catalog("cmp_acme", "notes");
    expect(notes).toEqual({ ok: true, apps: [expect.objectContaining({ domain: "granola.ai" })], connected: ["granola.ai"] });
    expect(catalogSearch).toHaveBeenCalledWith("cmp_acme", "", 100);
  });

  it("a refused catalog read says who may connect apps, without Retry", async () => {
    const host = createFirstRunAppsHost({
      catalogSearch: async () => ({ ok: false, reason: "error", status: 403, message: "HTTP 403 INTEGRATION_FACTORY_FORBIDDEN" }),
      openUrl: vi.fn(),
      dry: false,
    });
    expect(await host.catalog("cmp_acme", "notes")).toEqual({
      ok: false,
      reason: "Only company owners and admins can browse apps to connect.",
      retry: false,
    });
  });

  it("connects a keyless app with an install", async () => {
    const install = vi.fn(async () => ok({ connection: { id: "c" } }));
    const host = createFirstRunAppsHost({ install, openUrl: vi.fn(), dry: false });
    expect(await host.connect("cmp_acme", app("granola.ai", "none"))).toEqual({ ok: true });
    expect(install).toHaveBeenCalledWith({ companyUid: "cmp_acme", domain: "granola.ai" });
  });

  it("an OAuth app opens the sign-in page and answers once a connection that was not there before shows", async () => {
    const existing = { id: "c0", status: "connected", createdAt: "2030-01-01T00:00:00Z", installation: { domain: "linear.app" } };
    const made = { id: "c1", status: "connected", createdAt: "1999-01-01T00:00:00Z", installation: { domain: "linear.app" } };
    const startOAuth = vi.fn(async () =>
      ok({ provider: "linear", displayName: "Linear", authorizationUrl: "https://linear.app/oauth", state: "s", expiresAt: "x" }),
    );
    const listConnections = vi
      .fn()
      .mockResolvedValueOnce(ok({ connections: [existing] }))
      .mockResolvedValueOnce(ok({ connections: [existing] }))
      .mockResolvedValueOnce(ok({ connections: [existing, made] }));
    const openUrl = vi.fn();
    const host = createFirstRunAppsHost({ startOAuth, listConnections, openUrl, dry: false, pollMs: 0 });
    // A server clock far behind this computer's does not matter: ids are compared.
    expect(await host.connect("cmp_acme", app("linear.app", "oauth"))).toEqual({ ok: true });
    expect(startOAuth).toHaveBeenCalledWith({ companyUid: "cmp_acme", domain: "linear.app", catalogEntryId: "cat_linear.app" });
    expect(openUrl).toHaveBeenCalledWith("https://linear.app/oauth");
    expect(listConnections).toHaveBeenCalledTimes(3);
  });

  it("a connection that was already there, or never comes, is not an answer", async () => {
    let t = 10_000;
    const listConnections = vi.fn(async () =>
      ok({ connections: [{ id: "c1", status: "connected", createdAt: "2030-01-01T00:00:00Z", installation: { domain: "linear.app" } }] }),
    );
    const host = createFirstRunAppsHost({
      startOAuth: async () => ok({ provider: "l", displayName: "L", authorizationUrl: "https://x", state: "s", expiresAt: "x" }),
      listConnections,
      openUrl: vi.fn(),
      dry: false,
      pollMs: 0,
      timeoutMs: 5,
      now: () => (t += 1),
    });
    expect(await host.connect("cmp_acme", app("linear.app", "oauth"))).toEqual({
      ok: false,
      reason: "linear did not finish connecting. Try again.",
      retry: true,
    });
  });

  it("an aborted wait stops reading the list and answers quietly", async () => {
    const abort = new AbortController();
    const listConnections = vi.fn(async () => ok({ connections: [] }));
    const host = createFirstRunAppsHost({
      startOAuth: async () => ok({ provider: "l", displayName: "L", authorizationUrl: "https://x", state: "s", expiresAt: "x" }),
      listConnections,
      openUrl: vi.fn(),
      dry: false,
      pollMs: 60_000,
    });
    const waiting = host.connect("cmp_acme", app("linear.app", "oauth"), abort.signal);
    await new Promise((r) => setTimeout(r, 0));
    abort.abort();
    expect(await waiting).toEqual(CONNECT_ABORTED);
    const reads = listConnections.mock.calls.length;
    await new Promise((r) => setTimeout(r, 5));
    expect(listConnections.mock.calls.length).toBe(reads);
  });

  it("a refused start is a plain sentence; a key app is never started here", async () => {
    const host = createFirstRunAppsHost({
      startOAuth: async () => ({ ok: false, reason: "error", status: 402 }),
      openUrl: vi.fn(),
      dry: false,
    });
    expect(await host.connect("cmp_acme", app("linear.app", "oauth"))).toEqual({
      ok: false,
      reason: "Your plan's integration limit is reached.",
      retry: false,
    });
    expect((await host.connect("cmp_acme", app("loom.com", "key"))).ok).toBe(false);
  });

  it("a dry walk still reads the catalog but connects nothing", async () => {
    const install = vi.fn();
    const startOAuth = vi.fn();
    const openUrl = vi.fn();
    const catalogSearch = vi.fn(async () => ok(catalog));
    const host = createFirstRunAppsHost({ catalogSearch, install, startOAuth, openUrl, dry: true, delayMs: 0 });
    expect((await host.catalog("cmp_acme", "projects")).ok).toBe(true);
    expect(await host.connect("cmp_acme", app("linear.app", "oauth"))).toEqual({ ok: true });
    expect(await host.connect("cmp_acme", app("granola.ai", "none"))).toEqual({ ok: true });
    expect(install).not.toHaveBeenCalled();
    expect(startOAuth).not.toHaveBeenCalled();
    expect(openUrl).not.toHaveBeenCalled();
  });
});
