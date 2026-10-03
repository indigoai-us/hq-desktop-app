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
    const rows = [...target.querySelectorAll<HTMLButtonElement>("button.row")];
    expect(rows.length).toBe(SURFACE.connections.length);
    for (const row of rows) {
      row.click();
      flushSync();
      expect(row.textContent ?? "", "row").not.toMatch(MACHINE);
      expect(target.querySelector("aside.pane")?.textContent ?? "", "inspector").not.toMatch(MACHINE);
    }
  });
});
