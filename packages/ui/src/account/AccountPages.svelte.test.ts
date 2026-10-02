// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import AccountPages from "./AccountPages.svelte";
import { markDownloaded, resetUpdateStore } from "../settings/update-store.svelte.js";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  resetUpdateStore();
});

describe("AccountPages (US-035)", () => {
  it("shows the update card with Restart to update when a package is staged", async () => {
    markDownloaded("9.9.9");
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AccountPages, {
      target: host,
      props: {
        page: "settings",
        name: "Ada Lovelace",
        email: "ada@example.com",
        roles: [],
      },
    });
    await tick();
    expect(host.querySelector('[data-testid="update-card"]')?.textContent).toContain("Restart to update");
    expect(host.querySelector('[data-testid="update-ready-chip"]')).not.toBeNull();
    host.remove();
  });

  it("opens the invoice pane with Download PDF and Open in Stripe", async () => {
    const opened: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AccountPages, {
      target: host,
      props: {
        page: "billing",
        name: "Ada",
        roles: [],
        openExternal: (url: string) => opened.push(url),
      },
    });
    await tick();
    // QA-049: no inspector column is reserved until an invoice is open.
    expect(host.querySelector('[data-testid="invoice-pane"]')).toBeNull();
    expect(host.querySelector('[data-testid="billing-split"]')?.classList.contains("open")).toBe(false);
    host.querySelector<HTMLElement>('[data-testid="invoice-row"]')?.click();
    await tick();
    expect(host.querySelector('[data-testid="invoice-pane"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="billing-split"]')?.classList.contains("open")).toBe(true);
    host.querySelector<HTMLButtonElement>('[data-testid="invoice-pdf"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-testid="invoice-stripe"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-testid="manage-payment"]')?.click();
    expect(opened.some((url) => url.includes(".pdf"))).toBe(true);
    expect(opened.some((url) => url.includes("billing.stripe.com") && !url.includes(".pdf"))).toBe(true);
    host.remove();
  });

  it("deletes the account only after confirmation and then signs out", async () => {
    let signedOut = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AccountPages, {
      target: host,
      props: {
        page: "profile",
        name: "Ada",
        roles: [],
        onsignout: () => {
          signedOut += 1;
        },
      },
    });
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="delete-account"]')?.click();
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="delete-confirm"]')?.click();
    expect(signedOut).toBe(0);
    const input = host.querySelector<HTMLInputElement>('[data-testid="delete-phrase"]');
    input!.value = "delete";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="delete-confirm"]')?.click();
    await tick();
    expect(signedOut).toBe(1);
    host.remove();
  });
});
