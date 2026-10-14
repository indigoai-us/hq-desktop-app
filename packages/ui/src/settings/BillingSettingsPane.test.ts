// @vitest-environment happy-dom
// Settings → Billing → Manage payment mints a Stripe portal session through
// hq-pro for the chosen company. Regression for the hard-coded
// billing.stripe.com/p/login/hq link that 404'd for every user.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BillingSettingsPane from "./BillingSettingsPane.svelte";

const PORTAL = "https://billing.stripe.com/p/session/test_YWNjdF8x";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountPane(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BillingSettingsPane, { target: host, props: props as never });
  flushSync();
}

const button = () => host.querySelector<HTMLButtonElement>('[data-testid="manage-payment"]');
const hint = () => host.querySelector('[data-testid="manage-payment-hint"]')?.textContent ?? null;

describe("Settings Billing pane: Manage payment", () => {
  it("opens the portal URL returned by the API for the selected company", async () => {
    const createBillingPortalSession = vi.fn(async () => ({ ok: true as const, value: { url: PORTAL } }));
    const openExternal = vi.fn();
    mountPane({
      openExternal,
      company: { createBillingPortalSession },
      companies: [
        { uid: "cmp_a", label: "Acme", role: "Owner" },
        { uid: "cmp_b", label: "Boring", role: "Owner" },
      ],
      selectedCompanyUid: "cmp_b",
    });
    button()!.click();
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(PORTAL));
    expect(createBillingPortalSession).toHaveBeenCalledWith("cmp_b");
    expect(openExternal).not.toHaveBeenCalledWith("https://billing.stripe.com/p/login/hq");
  });

  it("shows a pending state on click and blocks a second request", async () => {
    let resolve!: (v: { ok: true; value: { url: string } }) => void;
    const createBillingPortalSession = vi.fn(() => new Promise<{ ok: true; value: { url: string } }>((r) => (resolve = r)));
    const openExternal = vi.fn();
    mountPane({ openExternal, company: { createBillingPortalSession }, companies: [{ uid: "cmp_a", label: "Acme", role: "Owner" }] });
    button()!.click();
    flushSync();
    expect(button()!.disabled).toBe(true);
    expect(button()!.getAttribute("aria-busy")).toBe("true");
    expect(button()!.textContent).toContain("Opening Stripe");
    button()!.click();
    expect(createBillingPortalSession).toHaveBeenCalledTimes(1);
    resolve({ ok: true, value: { url: PORTAL } });
    await vi.waitFor(() => expect(button()!.disabled).toBe(false));
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it("a failure shows a quiet heal path, no raw error, and the same button retries", async () => {
    vi.useFakeTimers();
    try {
      const createBillingPortalSession = vi
        .fn()
        .mockResolvedValue({ ok: false, reason: "error", code: "http-500", message: "POST /v1/billing/portal failed {\"error\":\"boom\"}" });
      const openExternal = vi.fn();
      mountPane({ openExternal, company: { createBillingPortalSession }, companies: [{ uid: "cmp_a", label: "Acme", role: "Owner" }] });
      button()!.click();
      await vi.runAllTimersAsync();
      flushSync();
      expect(createBillingPortalSession).toHaveBeenCalledTimes(3);
      expect(hint()).toBe("Stripe didn't open. Tap to retry.");
      expect(host.textContent).not.toMatch(/boom|HTTP|v1\/billing/);
      expect(button()!.disabled).toBe(false);
      expect(button()!.textContent).toContain("Try again");

      createBillingPortalSession.mockResolvedValue({ ok: true, value: { url: PORTAL } });
      button()!.click();
      await vi.runAllTimersAsync();
      flushSync();
      expect(openExternal).toHaveBeenCalledWith(PORTAL);
      expect(hint()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a known non-owner gets an owner handoff and no billing call", () => {
    const createBillingPortalSession = vi.fn();
    mountPane({ openExternal: vi.fn(), company: { createBillingPortalSession }, companies: [{ uid: "cmp_a", label: "Acme", role: "Member" }] });
    expect(button()).toBeNull();
    expect(hint()).toBe("Only an owner of Acme can manage payment. Ask an owner to open it.");
    expect(createBillingPortalSession).not.toHaveBeenCalled();
  });

  it("with no company there is no Manage payment button and no invoice rows", () => {
    mountPane({ openExternal: vi.fn(), company: { createBillingPortalSession: vi.fn() }, companies: [] });
    expect(button()).toBeNull();
    expect(host.textContent).not.toMatch(/IN-2026|\$791/);
  });
});
