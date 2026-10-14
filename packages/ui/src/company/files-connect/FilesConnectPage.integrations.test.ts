// @vitest-environment happy-dom
// OWNER-D 2: the company Integrations tab loads the company's real connected
// apps (hq-pro GET /v1/integrations/admin), with loading, failed (Try again)
// and true-empty states. The catalog stays only under Available.
import { failure, ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";
import { companyIntegrationRows } from "./files-connect-model";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => []),
    loadDeployments: vi.fn(async () => []),
  },
}));

// Producer shape from hq-pro readAdminSurface (ids redacted).
const ADMIN_SURFACE = {
  companyUid: "cmp_x",
  viewer: { personUid: "prs_x", role: "member", canManageGovernance: false, canManageIntegrations: false },
  connections: [
    {
      id: "conn_1",
      provider: "slack",
      status: "connected",
      scopes: ["channels:read", "chat:write"],
      createdBy: "prs_a",
      createdByName: "Ada",
      createdByEmail: null,
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
      access: {},
      writePolicy: "confirm",
      writePolicyUpdatedAt: null,
      writeAllowlist: [],
      installation: null,
    },
    { id: "conn_2", provider: "linear", status: "needs-reauth", scopes: [], createdBy: "prs_b", createdByName: "Bo" },
    { id: "conn_3", provider: "notion", status: "revoked", scopes: [], createdBy: "prs_b", createdByName: "Bo" },
  ],
  audit: [],
};

describe("OWNER-D 2 company Integrations reads connected apps", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  function mountWith(
    listIntegrations: (uid: string) => Promise<unknown>,
    catalogSearch?: (uid: string, query: string, limit?: number) => Promise<unknown>,
    slug = "acme",
  ) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page: "integrations",
        slug,
        files: null,
        shell: null,
        settings: null,
        companyUid: "cmp_acme",
        adapter: { company: { listIntegrations }, ...(catalogSearch ? { integrations: { catalogSearch } } : {}) } as never,
      },
    });
    return target;
  }

  const openAvailable = (target: HTMLElement) => {
    (target.querySelector("[data-testid='integrations-available']") as HTMLButtonElement).click();
    flushSync();
  };

  const CATALOG = {
    ok: true,
    companyUid: "cmp_acme",
    entries: [
      { name: "Canva", domain: "canva.com", description: "Design tools", authClass: "oauth", entryId: "ent_canva" },
      { name: "PostHog", domain: "posthog.com", description: "Product analytics", authClass: "oauth" },
    ],
  };
  const ADMIN_VIEWER = { ...ADMIN_SURFACE, viewer: { ...ADMIN_SURFACE.viewer, role: "admin", canManageIntegrations: true } };

  const settle = async () => {
    flushSync();
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
  };

  it("parses the producer shape and leaves revoked connections out", () => {
    const rows = companyIntegrationRows(ADMIN_SURFACE);
    expect(rows.map((r) => [r.name, r.status, r.kind])).toEqual([
      ["Slack", "active", "connected"],
      ["Linear", "needs-sign-in", "connected"],
    ]);
    // QA-108: OAuth scopes are machine tokens and are not shown.
    expect(rows[0]?.detail).toBe("Connected by Ada");
    expect(rows[1]?.detail).toBe("Connected by Bo");
    expect(() => companyIntegrationRows({ grouped: {} })).toThrow();
  });

  it("shows the company's connected apps, not the catalog", async () => {
    const list = vi.fn(async () => ok(ADMIN_SURFACE));
    const target = mountWith(list);
    await settle();
    expect(list).toHaveBeenCalledWith("cmp_acme");
    const names = [...target.querySelectorAll("button.row .nm")].map((n) => n.textContent);
    expect(names).toEqual(["Slack", "Linear"]);
    expect(target.querySelector("[data-testid='integrations-count']")?.textContent).toContain("2");
  });

  it("shows the loader while the read is in flight", async () => {
    const target = mountWith(() => new Promise(() => {}));
    await settle();
    expect(target.querySelector("[data-testid='integrations-loader']")).toBeTruthy();
    expect(target.querySelector("[data-testid='integrations-empty']")).toBeNull();
    expect(target.querySelector("[data-testid='integrations-count']")).toBeNull();
  });

  it("shows the failed line with Try again, never the empty copy, and retries", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(failure("http-500", "HTTP 500 {\"error\":\"boom\"}"))
      .mockResolvedValue(ok(ADMIN_SURFACE));
    const target = mountWith(list);
    await settle();
    const empty = target.querySelector("[data-testid='integrations-empty']");
    expect(empty?.textContent).toContain("Could not load connected apps.");
    expect(target.textContent).not.toContain("No connected apps yet");
    expect(target.textContent).not.toContain("boom");
    expect(target.querySelector("[data-testid='integrations-count']")).toBeNull();
    (target.querySelector("[data-testid='integrations-retry']") as HTMLButtonElement).click();
    await settle();
    expect(target.querySelectorAll("button.row")).toHaveLength(2);
  });

  it("Available lists the factory catalog, not a fixed app list", async () => {
    const catalog = vi.fn(async () => ok(CATALOG));
    const target = mountWith(async () => ok(ADMIN_VIEWER), catalog, "catalog-list");
    await settle();
    expect(catalog).not.toHaveBeenCalled();
    openAvailable(target);
    await settle();
    expect(catalog).toHaveBeenCalledWith("cmp_acme", "", 60);
    const names = [...target.querySelectorAll("button.row .nm")].map((n) => n.textContent);
    expect(names).toEqual(["Canva", "PostHog"]);
    expect(target.textContent).not.toContain("GitHub");
    expect(target.querySelector("[data-testid='integrations-count']")?.textContent).toContain("2");
    expect(target.querySelector("aside.pane")?.textContent).toContain("Design tools");
  });

  it("retries a failed catalog read quietly, then shows one plain line with Try again", async () => {
    const catalog = vi
      .fn()
      .mockResolvedValueOnce(failure("http-500", "HTTP 500 {\"error\":\"boom\"}"))
      .mockResolvedValueOnce(failure("http-500", "HTTP 500 {\"error\":\"boom\"}"))
      .mockResolvedValue(ok(CATALOG));
    const target = mountWith(async () => ok(ADMIN_VIEWER), catalog, "catalog-retry");
    await settle();
    openAvailable(target);
    await settle();
    // First failure: no error on screen yet, the loader stays while it retries.
    expect(target.querySelector("[data-testid='integrations-loader']")).toBeTruthy();
    expect(target.textContent).not.toContain("Could not load");
    await vi.waitFor(() => expect(catalog).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await settle();
    const empty = target.querySelector("[data-testid='integrations-empty']");
    expect(empty?.textContent).toContain("Could not load apps to connect.");
    expect(target.textContent).not.toContain("boom");
    expect(target.textContent).not.toContain("HTTP 500");
    (target.querySelector("[data-testid='integrations-retry']") as HTMLButtonElement).click();
    await settle();
    expect([...target.querySelectorAll("button.row .nm")].map((n) => n.textContent)).toEqual(["Canva", "PostHog"]);
  });

  it("paints the last catalog for the company at once and still refreshes it", async () => {
    const first = vi.fn(async () => ok(CATALOG));
    const target1 = mountWith(async () => ok(ADMIN_VIEWER), first, "catalog-cache");
    await settle();
    openAvailable(target1);
    await settle();
    await unmount(component!);
    component = null;
    target1.remove();
    const second = vi.fn(async () => ok({ ...CATALOG, entries: [CATALOG.entries[0]] }));
    const target2 = mountWith(async () => ok(ADMIN_VIEWER), second, "catalog-cache");
    await settle();
    openAvailable(target2);
    expect([...target2.querySelectorAll("button.row .nm")].map((n) => n.textContent)).toEqual(["Canva", "PostHog"]);
    await settle();
    expect(second).toHaveBeenCalledTimes(1);
    expect([...target2.querySelectorAll("button.row .nm")].map((n) => n.textContent)).toEqual(["Canva"]);
  });

  it("tells a member the catalog is for owners and admins without asking the server", async () => {
    const catalog = vi.fn(async () => ok(CATALOG));
    const target = mountWith(async () => ok(ADMIN_SURFACE), catalog, "catalog-member");
    await settle();
    openAvailable(target);
    await settle();
    expect(catalog).not.toHaveBeenCalled();
    expect(target.querySelector("[data-testid='integrations-empty']")?.textContent).toContain(
      "Only company owners and admins can browse apps to connect.",
    );
    expect(target.querySelector("[data-testid='integrations-retry']")).toBeNull();
  });

  it("shows the true-empty copy when the company has no connected apps", async () => {
    const target = mountWith(async () => ok({ ...ADMIN_SURFACE, connections: [] }));
    await settle();
    expect(target.querySelector("[data-testid='integrations-empty']")?.textContent).toBe("No connected apps yet");
    expect(target.querySelector("[role='alert']")).toBeNull();
  });
});
