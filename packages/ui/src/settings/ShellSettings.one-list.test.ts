// @vitest-environment happy-dom
// OWNER-R20/R21: one Settings list (Profile and Billing first, then HQ);
// Profile shows Companies and roles with the real role (empty when unknown,
// never a dash), owners first as given, and a row opens that company; old
// account routes redirect into Settings; pronouns are gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import ShellSettings from "./ShellSettings.svelte";
import { canonicalizeDestination } from "../shell/navigation-history.js";
import { readAccountCache } from "../account/account-pages.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  localStorage.clear();
});

function mountSettings(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  const adapter = {
    isAvailable: () => true,
    identity: { getProfile: async () => ({ ok: true, value: { profile: { displayName: "Ada Lovelace", email: "ada@example.com" } } }) },
    sessions: {},
  } as unknown as PlatformAdapter;
  component = mount(ShellSettings, { target: host, props: { profile: null, adapter, ...props } as never });
  flushSync();
}

describe("one Settings list (OWNER-R21)", () => {
  it("lists Profile, Public profile and Billing first, then General, Appearance, Notifications, Sync, Meetings, Updates", () => {
    mountSettings({});
    const nav = [...host.querySelectorAll('[data-testid^="settings-nav-"]')].map((el) => el.getAttribute("data-testid")!.slice("settings-nav-".length));
    expect(nav.slice(0, 9)).toEqual(["profile", "public-profile", "billing", "general", "appearance", "notifications", "sync", "meetings", "updates"]);
  });

  it("Billing renders inside Settings with Manage payment", () => {
    const openExternal = vi.fn();
    mountSettings({ initialSection: "billing", openExternal });
    const pane = host.querySelector('[data-testid="settings-billing-pane"]');
    expect(pane).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="manage-payment"]')!.click();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("old Profile, Billing and account Settings routes redirect into Settings", () => {
    expect(canonicalizeDestination({ kind: "extra", page: "account-profile" } as never)).toEqual({ kind: "settings", section: "profile" });
    expect(canonicalizeDestination({ kind: "extra", page: "account-billing" } as never)).toEqual({ kind: "settings", section: "billing" });
    expect(canonicalizeDestination({ kind: "extra", page: "account-settings" } as never)).toEqual({ kind: "settings", section: "profile" });
  });
});

describe("Profile companies and roles (OWNER-R20)", () => {
  it("shows the real role, empty when unknown (never a dash), and a row opens that company", async () => {
    const oncompany = vi.fn();
    mountSettings({
      oncompany,
      profileCompanies: [
        { uid: "cmp_a", label: "Acme", role: "Owner" },
        { uid: "cmp_b", label: "Boring Ecom", role: "Member" },
        { uid: "cmp_c", label: "Cobalt", role: null },
      ],
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="settings-profile-companies"]')).not.toBeNull());
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="settings-profile-company"]')];
    expect(rows.map((r) => r.querySelector('[data-testid="settings-profile-company-role"]')!.textContent)).toEqual(["Owner", "Member", ""]);
    expect(host.querySelector('[data-testid="settings-profile-companies"]')!.textContent).not.toMatch(/—|HQ Workforce/);
    rows[1]!.click();
    expect(oncompany).toHaveBeenCalledWith("cmp_b");
  });

  it("has no pronouns field, and an older saved profile drops pronouns", () => {
    localStorage.setItem("hq.account.pages.v1", JSON.stringify({ displayName: "Ada", pronouns: "she/her", invoices: [], companies: [], shortcuts: [] }));
    expect(readAccountCache()).not.toHaveProperty("pronouns");
    mountSettings({});
    expect(host.textContent).not.toMatch(/pronoun/i);
  });
});
