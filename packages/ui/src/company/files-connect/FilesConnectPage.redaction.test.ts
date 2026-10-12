// @vitest-environment happy-dom
// US-005: a "Hidden from AI" row under each connection in the existing
// connected-app detail pane.
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";
import type { RedactionPresetId, RedactionPresetsApi, RedactionSettings } from "./redaction-presets";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => []),
    loadDeployments: vi.fn(async () => []),
  },
}));

type Role = "owner" | "admin" | "member";

const SURFACE = (role: Role) => ({
  companyUid: "cmp_acme",
  viewer: { personUid: "prs_x", role, canManageGovernance: role !== "member", canManageIntegrations: role !== "member" },
  connections: [
    { id: "conn_1", provider: "slack", status: "connected", scopes: [], createdBy: "prs_a", createdByName: "Ada" },
    { id: "conn_2", provider: "slack", status: "connected", scopes: [], createdBy: "prs_b", createdByName: "Bo" },
  ],
  audit: [],
});

/** A stand-in for the US-004 API that keeps what was PUT, like the server. */
function serverApi(initial: Record<string, Partial<Record<RedactionPresetId, boolean>>> = {}) {
  const store = new Map(Object.entries(initial));
  const answer = (conn: string): RedactionSettings =>
    ({ presets: Object.entries(store.get(conn) ?? {}).map(([id, enabled]) => ({ id, enabled })) }) as never;
  const api = {
    load: vi.fn(async (_uid: string, conn: string) => answer(conn)),
    set: vi.fn(async (_uid: string, conn: string, id: RedactionPresetId, enabled: boolean) => {
      store.set(conn, { ...(store.get(conn) ?? {}), [id]: enabled });
      return answer(conn);
    }),
  };
  return api;
}

const settle = async () => {
  flushSync();
  for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

describe("US-005 Hidden from AI row", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  function mountWith(role: Role, api: RedactionPresetsApi | null) {
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
        adapter: { company: { listIntegrations: vi.fn(async () => ok(SURFACE(role))) } } as never,
        redactionPresets: api,
      },
    });
    return target;
  }

  const rowFor = (t: HTMLElement, conn: string) =>
    t.querySelector<HTMLElement>(`[data-testid='redaction-row'][data-connection='${conn}']`)!;
  const toggle = (row: HTMLElement, preset: RedactionPresetId) =>
    row.querySelector<HTMLButtonElement>(`[data-preset='${preset}'] [data-testid='redaction-toggle']`)!;

  it("is not shown until the host provides the presets API", async () => {
    const target = mountWith("owner", null);
    await settle();
    expect(target.querySelector("[data-testid='integration-app-detail']")).not.toBeNull();
    expect(target.querySelector("[data-testid='redaction-row']")).toBeNull();
  });

  it("puts a row with four switches under each connection, all on by default", async () => {
    const api = serverApi();
    const target = mountWith("owner", api);
    await settle();
    const conns = [...target.querySelectorAll("[data-testid='integration-app-detail'] [data-testid='integration-connection']")];
    expect(conns).toHaveLength(2);
    for (const [i, conn] of conns.entries()) {
      const row = conn.querySelector<HTMLElement>("[data-testid='redaction-row']")!;
      expect(row.dataset.connection).toBe(`conn_${i + 1}`);
      expect(row.querySelector("h3")?.textContent).toBe("Hidden from AI");
      const labels = [...row.querySelectorAll("[data-testid='redaction-preset'] .label")].map((l) => l.textContent);
      expect(labels).toEqual(["Personal IDs", "Salary and HR", "Legal matters", "Bank and card numbers"]);
      const sw = [...row.querySelectorAll<HTMLButtonElement>("[data-testid='redaction-toggle']")];
      expect(sw.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "true"]);
      expect(sw.every((b) => !b.disabled)).toBe(true);
    }
    expect(api.load).toHaveBeenCalledTimes(2);
    expect(api.load).toHaveBeenCalledWith("cmp_acme", "conn_1");
    expect(api.load).toHaveBeenCalledWith("cmp_acme", "conn_2");
    // No new screen, sheet or dialog.
    expect(target.querySelector("[role='dialog']")).toBeNull();
  });

  it("E2E: an admin turns legal off, the PUT fires, and it stays off after reload", async () => {
    const api = serverApi();
    let target = mountWith("admin", api);
    await settle();
    toggle(rowFor(target, "conn_1"), "legal").click();
    await settle();
    expect(api.set).toHaveBeenCalledTimes(1);
    expect(api.set).toHaveBeenCalledWith("cmp_acme", "conn_1", "legal", false);
    expect(toggle(rowFor(target, "conn_1"), "legal").getAttribute("aria-checked")).toBe("false");
    // Only that connection changed.
    expect(toggle(rowFor(target, "conn_2"), "legal").getAttribute("aria-checked")).toBe("true");

    await unmount(component!);
    document.body.innerHTML = "";
    target = mountWith("admin", api);
    await settle();
    expect(toggle(rowFor(target, "conn_1"), "legal").getAttribute("aria-checked")).toBe("false");
    expect(toggle(rowFor(target, "conn_1"), "financial").getAttribute("aria-checked")).toBe("true");
  });

  it("E2E: a member sees the switches disabled and cannot change them", async () => {
    const api = serverApi({ conn_1: { legal: false } });
    const target = mountWith("member", api);
    await settle();
    const row = rowFor(target, "conn_1");
    const sw = [...row.querySelectorAll<HTMLButtonElement>("[data-testid='redaction-toggle']")];
    expect(sw).toHaveLength(4);
    expect(sw.every((b) => b.disabled)).toBe(true);
    expect(toggle(row, "legal").getAttribute("aria-checked")).toBe("false");
    expect(row.querySelector(".hint")?.textContent).toContain("Only owners and admins can change this.");
    toggle(row, "hr-pay").click();
    await settle();
    expect(api.set).not.toHaveBeenCalled();
  });

  it("shows the pending state at once and settles on the saved value", async () => {
    let resolveSave: (v: RedactionSettings) => void = () => {};
    const api = {
      load: vi.fn(async () => ({ presets: [] })),
      set: vi.fn(() => new Promise<RedactionSettings>((r) => (resolveSave = r))),
    };
    const target = mountWith("owner", api);
    await settle();
    toggle(rowFor(target, "conn_1"), "hr-pay").click();
    flushSync();
    const sw = toggle(rowFor(target, "conn_1"), "hr-pay");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(sw.disabled).toBe(true);
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-pending']")?.textContent).toBe("Saving…");

    resolveSave({ presets: [{ id: "hr-pay", label: "Salary and HR", enabled: false }] });
    await settle();
    expect(rowFor(target, "conn_1").querySelector("[data-testid='redaction-pending']")).toBeNull();
    expect(toggle(rowFor(target, "conn_1"), "hr-pay").getAttribute("aria-checked")).toBe("false");
    expect(toggle(rowFor(target, "conn_1"), "hr-pay").disabled).toBe(false);
  });

  it("puts the switch back with a plain line when the save fails", async () => {
    const api = {
      load: vi.fn(async () => ({ presets: [] })),
      set: vi.fn(async () => {
        throw new Error("500 internal: secret server text");
      }),
    };
    const target = mountWith("owner", api);
    await settle();
    toggle(rowFor(target, "conn_1"), "personal-ids").click();
    await settle();
    expect(toggle(rowFor(target, "conn_1"), "personal-ids").getAttribute("aria-checked")).toBe("true");
    const err = rowFor(target, "conn_1").querySelector("[data-testid='redaction-save-error']");
    expect(err?.textContent).toBe("Couldn't save that change. Try again.");
    expect(target.textContent).not.toContain("secret server text");
  });

  it("offers Try again when the presets cannot be read", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue({ presets: [] });
    const api = { load, set: vi.fn(async () => ({ presets: [] })) };
    const target = mountWith("owner", api);
    await settle();
    const row = rowFor(target, "conn_1");
    expect(row.querySelector("[data-testid='redaction-load-error']")).not.toBeNull();
    (row.querySelector("[data-testid='redaction-retry']") as HTMLButtonElement).click();
    await settle();
    expect(rowFor(target, "conn_1").querySelectorAll("[data-testid='redaction-toggle']")).toHaveLength(4);
  });
});
