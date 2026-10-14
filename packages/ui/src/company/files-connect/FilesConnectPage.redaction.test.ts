// @vitest-environment happy-dom
// US-005: a "Hidden from AI" row under each connection in the existing
// connected-app detail pane, wired to the US-004 hq-pro contract through the
// platform adapter (`company.getRedaction` / `company.putRedaction`).
import { ok, type AdapterResult, type Json } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => []),
    loadDeployments: vi.fn(async () => []),
  },
}));

type Role = "owner" | "admin" | "member";
const ALL = ["personal-ids", "hr-pay", "legal", "financial"];

const SURFACE = (role: Role) => ({
  companyUid: "cmp_acme",
  viewer: { personUid: "prs_x", role, canManageGovernance: role !== "member", canManageIntegrations: role !== "member" },
  connections: [
    { id: "conn_1", provider: "slack", status: "connected", scopes: [], createdBy: "prs_a", createdByName: "Ada" },
    { id: "conn_2", provider: "slack", status: "connected", scopes: [], createdBy: "prs_b", createdByName: "Bo" },
  ],
  audit: [],
});

const refusal = (status: number, code: string): AdapterResult<Json> => ({
  ok: false,
  reason: "error",
  code,
  message: "server text that must not show",
  status,
});

/** A stand-in for hq-pro #4915 that keeps what was PUT. */
function hqPro(opts: { canEdit?: boolean; saved?: Record<string, string[]> } = {}) {
  const store = new Map(Object.entries(opts.saved ?? {}));
  const answer = (conn: string) =>
    ok({
      companyUid: "cmp_acme",
      connectionId: conn,
      presets: store.get(conn) ?? ALL,
      availablePresets: ALL,
      isDefault: !store.has(conn),
      updatedAt: store.has(conn) ? "2026-10-12T00:00:00Z" : null,
      updatedBy: store.has(conn) ? "prs_x" : null,
      canEdit: opts.canEdit ?? true,
    } as Json);
  return {
    getRedaction: vi.fn(async (_uid: string, conn: string) => answer(conn)),
    putRedaction: vi.fn(async (_uid: string, conn: string, presets: readonly string[]) => {
      store.set(conn, [...presets]);
      return answer(conn);
    }),
  };
}

const settle = async () => {
  flushSync();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe("US-005 Hidden from AI row on the US-004 API", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  function mountWith(role: Role, redaction: Partial<ReturnType<typeof hqPro>> | null) {
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
        adapter: { company: { listIntegrations: vi.fn(async () => ok(SURFACE(role))), ...(redaction ?? {}) } } as never,
      },
    });
    return target;
  }

  const rowFor = (t: HTMLElement, conn: string) =>
    t.querySelector<HTMLElement>(`[data-testid='redaction-row'][data-connection='${conn}']`)!;
  const toggle = (t: HTMLElement, conn: string, preset: string) =>
    rowFor(t, conn).querySelector<HTMLButtonElement>(`[data-preset='${preset}'] [data-testid='redaction-toggle']`)!;
  const checked = (t: HTMLElement, conn: string) =>
    [...rowFor(t, conn).querySelectorAll("[data-testid='redaction-toggle']")].map((b) => b.getAttribute("aria-checked"));

  it("is not shown when the host has no redaction calls", async () => {
    const target = mountWith("owner", null);
    await settle();
    expect(target.querySelector("[data-testid='integration-app-detail']")).not.toBeNull();
    expect(target.querySelector("[data-testid='redaction-row']")).toBeNull();
  });

  it("reads each connection and shows four switches as the server answers them", async () => {
    const api = hqPro();
    const target = mountWith("owner", api);
    await settle();
    const conns = [...target.querySelectorAll("[data-testid='integration-app-detail'] [data-testid='integration-connection']")];
    expect(conns.map((c) => c.querySelector<HTMLElement>("[data-testid='redaction-row']")?.dataset.connection)).toEqual([
      "conn_1",
      "conn_2",
    ]);
    const labels = [...rowFor(target, "conn_1").querySelectorAll("[data-testid='redaction-preset'] .label")].map((l) => l.textContent);
    expect(labels).toEqual(["Personal IDs", "Salary and HR", "Legal matters", "Bank and card numbers"]);
    expect(checked(target, "conn_1")).toEqual(["true", "true", "true", "true"]);
    expect(api.getRedaction).toHaveBeenCalledWith("cmp_acme", "conn_1");
    expect(api.getRedaction).toHaveBeenCalledWith("cmp_acme", "conn_2");
    expect(target.querySelector("[role='dialog']")).toBeNull();
  });

  it("success (E2E): an admin turns legal off, the PUT fires, and it stays off after reload", async () => {
    const api = hqPro();
    let target = mountWith("admin", api);
    await settle();
    toggle(target, "conn_1", "legal").click();
    await settle();
    expect(api.putRedaction).toHaveBeenCalledTimes(1);
    expect(api.putRedaction).toHaveBeenCalledWith("cmp_acme", "conn_1", ["personal-ids", "hr-pay", "financial"]);
    expect(checked(target, "conn_1")).toEqual(["true", "true", "false", "true"]);
    expect(checked(target, "conn_2")).toEqual(["true", "true", "true", "true"]);

    await unmount(component!);
    document.body.innerHTML = "";
    target = mountWith("admin", api);
    await settle();
    expect(checked(target, "conn_1")).toEqual(["true", "true", "false", "true"]);
  });

  it("E2E: a member sees the switches disabled", async () => {
    const api = hqPro({ canEdit: false, saved: { conn_1: ["personal-ids"] } });
    const target = mountWith("member", api);
    await settle();
    const sw = [...rowFor(target, "conn_1").querySelectorAll<HTMLButtonElement>("[data-testid='redaction-toggle']")];
    expect(sw).toHaveLength(4);
    expect(sw.every((b) => b.disabled)).toBe(true);
    expect(checked(target, "conn_1")).toEqual(["true", "false", "false", "false"]);
    expect(rowFor(target, "conn_1").querySelector(".hint")?.textContent).toContain("Only owners and admins can change this.");
    sw[2]!.click();
    await settle();
    expect(api.putRedaction).not.toHaveBeenCalled();
  });

  it("is read-only for an admin when the server's canEdit is false", async () => {
    const target = mountWith("admin", hqPro({ canEdit: false }));
    await settle();
    expect(toggle(target, "conn_1", "legal").disabled).toBe(true);
  });

  it("403: rolls the switch back, says only owners and admins can change it, and locks the row", async () => {
    const api = {
      ...hqPro(),
      putRedaction: vi.fn(async () => refusal(403, "REDACTION_ADMIN_REQUIRED")),
    };
    const target = mountWith("admin", api);
    await settle();
    toggle(target, "conn_1", "legal").click();
    flushSync();
    expect(toggle(target, "conn_1", "legal").getAttribute("aria-checked")).toBe("false");
    await settle();
    expect(api.putRedaction).toHaveBeenCalledTimes(1);
    expect(toggle(target, "conn_1", "legal").getAttribute("aria-checked")).toBe("true");
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-save-error']")?.textContent).toBe(
      "Only owners and admins can change this.",
    );
    expect(toggle(target, "conn_1", "financial").disabled).toBe(true);
    expect(target.textContent).not.toContain("server text that must not show");
  });

  it("rollback: a failed PUT puts the switch back with a short line and stays editable", async () => {
    const api = { ...hqPro(), putRedaction: vi.fn(async () => refusal(500, "http-500")) };
    const target = mountWith("owner", api);
    await settle();
    toggle(target, "conn_1", "hr-pay").click();
    await settle();
    expect(toggle(target, "conn_1", "hr-pay").getAttribute("aria-checked")).toBe("true");
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-save-error']")?.textContent).toBe(
      "Couldn't save that change. Try again.",
    );
    expect(toggle(target, "conn_1", "hr-pay").disabled).toBe(false);
  });

  it("shows Saving… at once while the PUT is in flight", async () => {
    let answer: (v: AdapterResult<Json>) => void = () => {};
    const api = {
      ...hqPro(),
      putRedaction: vi.fn(() => new Promise<AdapterResult<Json>>((r) => (answer = r))),
    };
    const target = mountWith("owner", api);
    await settle();
    toggle(target, "conn_1", "financial").click();
    flushSync();
    const sw = toggle(target, "conn_1", "financial");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-pending']")?.textContent).toBe("Saving…");
    answer(ok({ presets: ["personal-ids", "hr-pay", "legal"], canEdit: true } as Json));
    await settle();
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-pending']")).toBeNull();
    expect(checked(target, "conn_1")).toEqual(["true", "true", "true", "false"]);
  });

  it("hides the row when hq-pro has no redaction route yet, and explains a missing connection", async () => {
    const api = {
      getRedaction: vi.fn(async (_u: string, conn: string) =>
        conn === "conn_1" ? refusal(404, "http-404") : refusal(404, "CONNECTION_NOT_FOUND"),
      ),
      putRedaction: vi.fn(),
    };
    const target = mountWith("owner", api);
    await settle();
    expect(rowFor(target, "conn_1")).toBeNull();
    expect(rowFor(target, "conn_2").querySelector("[data-testid='redaction-load-error']")?.textContent).toContain(
      "This connection is no longer connected.",
    );
  });
});
