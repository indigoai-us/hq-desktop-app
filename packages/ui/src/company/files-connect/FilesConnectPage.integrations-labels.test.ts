// @vitest-environment happy-dom
// QA-108: the Connected list and inspector showed raw factory tags
// ("factory:auth:required", "factory:auth:none", "factory:remote_mcp") because
// a connection's scopes were printed as its description. Every machine value in
// the hq-pro /v1/integrations/admin response, plus unknown ones, must reach the
// DOM as plain copy or not at all.
import { ok } from "@hq/platform";
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

const STATUSES = ["connected", "needs-reauth", "needs-attention", "error", "degraded", "paused_by_admin"];
const SCOPES = [
  "factory:auth:required",
  "factory:auth:none",
  "factory:remote_mcp",
  "factory:cli:vercel",
  "factory:app",
  "factory:other",
  "factory:linear",
  "factory:brand_new_kind",
  "channels:read",
  "chat:write",
  "offline_access",
];
const WRITE_POLICIES = ["confirm", "allowlist", "deny", "auto_approve"];
const INSTALLATIONS = [null, { kind: "workspace" }, { kind: "user_token", teamId: "T1" }];

function connection(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `conn_${i}`,
    provider: ["slack", "linear", "notion", "remote_mcp_server"][i % 4],
    status: STATUSES[i % STATUSES.length],
    scopes: SCOPES,
    createdBy: "prs_a",
    createdByName: "Ada",
    createdByEmail: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    access: { mode: "company_wide" },
    writePolicy: WRITE_POLICIES[i % WRITE_POLICIES.length],
    writePolicyUpdatedAt: null,
    writeAllowlist: ["chat:write"],
    installation: INSTALLATIONS[i % INSTALLATIONS.length],
    ...overrides,
  };
}

const SURFACE = {
  companyUid: "cmp_x",
  viewer: { personUid: "prs_x", role: "member", canManageGovernance: false, canManageIntegrations: false },
  connections: Array.from({ length: 8 }, (_, i) => connection(i)),
  audit: [],
};

/** A colon-joined machine token ("factory:auth:none") or a snake_case word. */
const MACHINE = /\b[a-z0-9-]+:[a-z0-9_:-]+\b|\b[a-z0-9]+_[a-z0-9_]+\b/i;

describe("QA-108 Integrations show plain labels", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  const settle = async () => {
    flushSync();
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
    flushSync();
  };

  it("maps the factory tags to plain copy and drops raw scopes", () => {
    const rows = companyIntegrationRows({
      connections: [
        connection(0, { scopes: ["factory:auth:required", "factory:remote_mcp"] }),
        connection(1, { scopes: ["factory:auth:none"] }),
        connection(2, { scopes: ["channels:read", "factory:brand_new_kind"] }),
      ],
    });
    expect(rows.map((r) => r.detail)).toEqual([
      "Sign-in required, Remote connection",
      "No sign-in needed",
      "Connected by Ada",
    ]);
    for (const row of rows) expect(row.detail).not.toMatch(MACHINE);
  });

  it("no row or inspector text carries a machine token", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(FilesConnectPage, {
      target,
      props: {
        page: "integrations",
        slug: "acme",
        files: null,
        shell: null,
        settings: null,
        companyUid: "cmp_acme",
        adapter: { company: { listIntegrations: vi.fn(async () => ok(SURFACE)) } } as never,
      },
    });
    await settle();
    // One row per app (four providers); every connection shows under its app.
    const rows = [...target.querySelectorAll<HTMLButtonElement>("button.row")];
    expect(rows.length).toBe(4);
    let connections = 0;
    for (const row of rows) {
      row.click();
      flushSync();
      expect(row.textContent ?? "", "row").not.toMatch(MACHINE);
      expect(target.querySelector("aside.pane")?.textContent ?? "", "inspector").not.toMatch(MACHINE);
      connections += target.querySelectorAll("[data-testid='integration-connection']").length;
    }
    expect(connections).toBe(SURFACE.connections.length);
  });

  it("never shows a factory: prefix or install hash, and groups an app's connections", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const surface = {
      ...SURFACE,
      connections: [
        connection(0, { id: "c_lin_1", provider: "factory:linear", status: "connected", installation: null }),
        connection(1, { id: "c_lin_2", provider: "factory:linear", status: "error", installation: null, errorReason: "upstream_503" }),
        connection(2, {
          id: "c_ph",
          provider: "factory:remote_mcp_posthog_com_e755da2a91c4",
          status: "connected",
          installation: null,
        }),
        connection(3, {
          id: "c_named",
          provider: "factory:remote_mcp_acme_io_0a1b2c3d4e",
          status: "needs-reauth",
          installation: { displayName: "Acme CRM", domain: "mcp.acme.io" },
        }),
      ],
    };
    component = mount(FilesConnectPage, {
      target,
      props: {
        page: "integrations",
        slug: "acme",
        files: null,
        shell: null,
        settings: null,
        companyUid: "cmp_acme",
        adapter: { company: { listIntegrations: vi.fn(async () => ok(surface)) } } as never,
      },
    });
    await settle();
    const names = [...target.querySelectorAll("button.row .nm")].map((n) => n.textContent);
    expect(names).toEqual(["Linear", "PostHog", "Acme CRM"]);
    expect(target.textContent).not.toMatch(/factory/i);
    expect(target.textContent).not.toMatch(/e755|0a1b2c/i);
    const linear = target.querySelector<HTMLButtonElement>("button.row[data-app='linear.app']")!;
    expect(linear.textContent).toContain("2 connections · Work");
    expect(linear.querySelector("[data-testid='integration-app-status']")?.textContent).toBe("Needs attention");
    linear.click();
    flushSync();
    const pane = target.querySelector("aside.pane")!;
    expect(pane.querySelectorAll("[data-testid='integration-connection']")).toHaveLength(2);
    expect(pane.querySelector("[data-testid='integration-reason']")?.textContent).toBe("The app is temporarily unavailable.");
    // Bundled brand marks only: a real mark for Linear and PostHog, the glyph for Acme. No <img>.
    expect(target.querySelector("img")).toBeNull();
    const logos = [...target.querySelectorAll("button.row [data-testid='connection-card-logo']")].map((l) => l.getAttribute("data-logo"));
    expect(logos).toEqual(["mark", "mark", "generic"]);
    const acme = target.querySelector<HTMLButtonElement>("button.row[data-app='acme.io']")!;
    expect(acme.textContent).toContain("acme.io");
    expect(acme.querySelector("[data-testid='integration-app-status']")?.textContent).toBe("Needs attention");
  });
});
