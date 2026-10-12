// @vitest-environment happy-dom
// US-005: the "Hidden from AI" row in the connected-app detail pane.
import { ok } from "@hq/platform";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import FilesConnectPage from "./FilesConnectPage.svelte";
import type { RedactionPresetsApi, RedactionSettings } from "./redaction-presets";

vi.mock("../company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => []),
    loadDeployments: vi.fn(async () => []),
  },
}));

const SURFACE = (role: "owner" | "admin" | "member") => ({
  companyUid: "cmp_acme",
  viewer: { personUid: "prs_x", role, canManageGovernance: role !== "member", canManageIntegrations: role !== "member" },
  connections: [
    { id: "conn_1", provider: "slack", status: "connected", scopes: [], createdBy: "prs_a", createdByName: "Ada" },
  ],
  audit: [],
});

const PRESETS: RedactionSettings = {
  presets: [
    { id: "emails", label: "Email addresses", enabled: true },
    { id: "phone_numbers", label: "Phone numbers", enabled: false },
    { id: "payment_cards", label: "Payment card numbers", enabled: true },
    { id: "government_ids", label: "Government ID numbers", enabled: false },
  ],
};

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

  function mountWith(role: "owner" | "admin" | "member", api: RedactionPresetsApi | null) {
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

  const toggles = (t: HTMLElement) => [...t.querySelectorAll<HTMLButtonElement>("[data-testid='redaction-toggle']")];

  it("is not shown until the host provides the presets API", async () => {
    const target = mountWith("owner", null);
    await settle();
    expect(target.querySelector("[data-testid='integration-app-detail']")).not.toBeNull();
    expect(target.querySelector("[data-testid='redaction-row']")).toBeNull();
  });

  it("shows four switches inside the existing detail pane for an owner", async () => {
    const api = { load: vi.fn(async () => PRESETS), set: vi.fn(async () => PRESETS) };
    const target = mountWith("owner", api);
    await settle();
    const detail = target.querySelector("[data-testid='integration-app-detail']")!;
    const row = detail.querySelector("[data-testid='redaction-row']")!;
    expect(row.querySelector("h3")?.textContent).toBe("Hidden from AI");
    expect(api.load).toHaveBeenCalledWith("cmp_acme", { key: "slack.com", connectionIds: ["conn_1"] });
    expect(api.load).toHaveBeenCalledTimes(1);
    const sw = toggles(target);
    expect(sw).toHaveLength(4);
    expect(sw.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "true", "false"]);
    expect(sw.every((b) => !b.disabled)).toBe(true);
    // No new screen, sheet or dialog.
    expect(target.querySelector("[role='dialog']")).toBeNull();
  });

  it("is read-only for a member", async () => {
    const api = { load: vi.fn(async () => PRESETS), set: vi.fn(async () => PRESETS) };
    const target = mountWith("member", api);
    await settle();
    const sw = toggles(target);
    expect(sw).toHaveLength(4);
    expect(sw.every((b) => b.disabled)).toBe(true);
    expect(target.querySelector("[data-testid='redaction-row'] .hint")?.textContent).toContain(
      "Only owners and admins can change this.",
    );
    sw[1]!.click();
    await settle();
    expect(api.set).not.toHaveBeenCalled();
  });

  it("shows the pending state at once and settles on the saved value", async () => {
    let resolveSave: (v: RedactionSettings) => void = () => {};
    const api = {
      load: vi.fn(async () => PRESETS),
      set: vi.fn(() => new Promise<RedactionSettings>((r) => (resolveSave = r))),
    };
    const target = mountWith("admin", api);
    await settle();
    toggles(target)[1]!.click();
    flushSync();
    const sw = toggles(target)[1]!;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.getAttribute("aria-busy")).toBe("true");
    expect(sw.disabled).toBe(true);
    expect(target.querySelector("[data-testid='redaction-pending']")?.textContent).toBe("Saving…");
    expect(api.set).toHaveBeenCalledWith("cmp_acme", { key: "slack.com", connectionIds: ["conn_1"] }, "phone_numbers", true);

    resolveSave({ presets: PRESETS.presets.map((p) => (p.id === "phone_numbers" ? { ...p, enabled: true } : p)) });
    await settle();
    expect(target.querySelector("[data-testid='redaction-pending']")).toBeNull();
    expect(toggles(target)[1]!.getAttribute("aria-checked")).toBe("true");
    expect(toggles(target)[1]!.disabled).toBe(false);
  });

  it("puts the switch back with a plain line when the save fails", async () => {
    const api = {
      load: vi.fn(async () => PRESETS),
      set: vi.fn(async () => {
        throw new Error("500 internal: secret server text");
      }),
    };
    const target = mountWith("owner", api);
    await settle();
    toggles(target)[0]!.click();
    await settle();
    expect(toggles(target)[0]!.getAttribute("aria-checked")).toBe("true");
    const err = target.querySelector("[data-testid='redaction-save-error']");
    expect(err?.textContent).toBe("Couldn't save that change. Try again.");
    expect(target.textContent).not.toContain("secret server text");
  });

  it("offers Try again when the presets cannot be read", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(PRESETS);
    const api = { load, set: vi.fn(async () => PRESETS) };
    const target = mountWith("owner", api);
    await settle();
    expect(target.querySelector("[data-testid='redaction-load-error']")).not.toBeNull();
    (target.querySelector("[data-testid='redaction-retry']") as HTMLButtonElement).click();
    await settle();
    expect(toggles(target)).toHaveLength(4);
  });
});
