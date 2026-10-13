// @vitest-environment happy-dom
// OWNER-R20/R21: one Settings list (Profile, Billing, Companies first, then
// HQ); the Companies screen shows the real role (none when unknown, never a
// dash) and a row opens that company; old account routes redirect into
// Settings; pronouns are gone.
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
  it("lists Profile, Public profile, Billing and Companies first, then General, Appearance, Notifications, Sync, Meetings, Updates", () => {
    mountSettings({});
    const nav = [...host.querySelectorAll('[data-testid^="settings-nav-"]')].map((el) => el.getAttribute("data-testid")!.slice("settings-nav-".length));
    expect(nav.slice(0, 10)).toEqual(["profile", "public-profile", "billing", "companies", "general", "appearance", "notifications", "sync", "meetings", "updates"]);
  });

  it("Billing renders inside Settings and Manage payment opens the API-minted portal", async () => {
    const openExternal = vi.fn();
    const portal = "https://billing.stripe.com/p/session/test_x";
    const createBillingPortalSession = vi.fn(async () => ({ ok: true, value: { url: portal } }));
    host = document.createElement("div");
    document.body.appendChild(host);
    const adapter = {
      isAvailable: () => true,
      identity: { getProfile: async () => ({ ok: true, value: { profile: { displayName: "Ada", email: "ada@example.com" } } }) },
      sessions: {},
      company: { createBillingPortalSession },
    } as unknown as PlatformAdapter;
    component = mount(ShellSettings, {
      target: host,
      props: {
        profile: null,
        adapter,
        initialSection: "billing",
        openExternal,
        profileCompanies: [{ uid: "cmp_a", label: "Acme", role: "Owner" }],
        selectedCompanyUid: "cmp_a",
      } as never,
    });
    flushSync();
    expect(host.querySelector('[data-testid="settings-billing-pane"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="manage-payment"]')!.click();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(portal));
    expect(createBillingPortalSession).toHaveBeenCalledWith("cmp_a");
  });

  it("old Profile, Billing and account Settings routes redirect into Settings", () => {
    expect(canonicalizeDestination({ kind: "extra", page: "account-profile" } as never)).toEqual({ kind: "settings", section: "profile" });
    expect(canonicalizeDestination({ kind: "extra", page: "account-billing" } as never)).toEqual({ kind: "settings", section: "billing" });
    expect(canonicalizeDestination({ kind: "extra", page: "account-settings" } as never)).toEqual({ kind: "settings", section: "profile" });
  });
});

describe("Companies screen roles (OWNER-R20)", () => {
  const companies = [
    { slug: "acme", displayName: "Acme", kind: "company", state: "synced", cloudUid: "cmp_a", role: "owner" },
    { slug: "boring", displayName: "Boring Ecom", kind: "company", state: "synced", cloudUid: "cmp_b", role: "member" },
    { slug: "cobalt", displayName: "Cobalt", kind: "company", state: "synced", cloudUid: "cmp_c", role: null },
  ];

  it("shows the real role, none when unknown (never a dash), and a row opens that company", async () => {
    const oncompany = vi.fn();
    mountSettings({
      initialSection: "companies",
      oncompany,
      companies,
      profileCompanies: [
        { uid: "cmp_a", label: "Acme", role: "Owner" },
        { uid: "cmp_b", label: "Boring Ecom", role: "Member" },
        { uid: "cmp_c", label: "Cobalt", role: null },
      ],
    });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="settings-companies-pane"]')).not.toBeNull());
    const rows = [...host.querySelectorAll<HTMLElement>('[data-testid="settings-company-row"]')];
    expect(rows.map((r) => r.querySelector('[data-testid="settings-company-role"]')?.textContent ?? "")).toEqual(["Owner", "Member", ""]);
    expect(host.querySelector('[data-testid="settings-companies-pane"]')!.textContent).not.toMatch(/—|HQ Workforce/);
    rows[1]!.querySelector<HTMLButtonElement>(".co-id")!.click();
    expect(oncompany).toHaveBeenCalledWith("cmp_b");
  });

  it("Profile no longer lists companies", async () => {
    mountSettings({ companies, profileCompanies: [{ uid: "cmp_a", label: "Acme", role: "Owner" }] });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="settings-profile-pane"]')).not.toBeNull());
    expect(host.querySelector('[data-testid="settings-profile-companies"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-company-row"]')).toBeNull();
  });

  it("has no pronouns field, and an older saved profile drops pronouns", () => {
    localStorage.setItem("hq.account.pages.v1", JSON.stringify({ displayName: "Ada", pronouns: "she/her", invoices: [], companies: [], shortcuts: [] }));
    expect(readAccountCache()).not.toHaveProperty("pronouns");
    mountSettings({});
    expect(host.textContent).not.toMatch(/pronoun/i);
  });
});
