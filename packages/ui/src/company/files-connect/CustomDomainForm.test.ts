// @vitest-environment happy-dom
import { ok } from "@hq/platform";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CustomDomainForm from "./CustomDomainForm.svelte";

/** Answers one hq-deploy domain call as the host does: `{ status, body }`. */
type Handler = (method: string, path: string, body?: unknown) => { status: number; body: unknown };

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

function render(handler: Handler, props: Record<string, unknown> = {}) {
  const request = vi.fn(async (_scope: string, method: string, path: string, body?: unknown) => ok(handler(method, path, body)));
  const target = document.createElement("div");
  document.body.appendChild(target);
  const ondone = vi.fn();
  const openExternal = vi.fn();
  component = mount(CustomDomainForm, {
    target,
    props: {
      appId: "app_1",
      appName: "launch-notes",
      appUrl: "https://launch-notes.indigo-hq.com",
      retryDelays: [0, 0],
      scope: "indigo",
      request,
      canManage: true,
      loadPrices: async () => ({ standardUsd: 20, premiumUsd: 500 }),
      openExternal,
      onclose: () => {},
      ondone,
      ...props,
    },
  });
  return { target, request, ondone, openExternal };
}

const q = (t: HTMLElement, id: string) => t.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

const none = () => ({ status: 200, body: { appId: "app_1", domains: [] } });
const pending = (domain = "app.example.com") => ({
  status: 200,
  body: { appId: "app_1", domains: [{ domain, environment: "production", validationState: "pending" }] },
});

describe("US-007 CustomDomainForm", () => {
  it("shows the price from the pricing feed and adds a domain with its DNS records", async () => {
    const { target, request, ondone } = render((method) => {
      if (method === "GET") return none();
      return {
        status: 201,
        body: {
          ok: true,
          domain: { domain: "app.example.com", validationState: "pending" },
          dnsInstructions: [
            { type: "CNAME", name: "_abc.app.example.com.", value: "_xyz.acm-validations.aws." },
            { type: "CNAME", name: "app.example.com", value: "launch-notes.indigo-hq.com" },
          ],
          serving: false,
        },
      };
    });
    await settle();
    expect(q(target, "custom-domain-price")?.textContent).toContain("$20/month");

    type(q(target, "custom-domain-input") as HTMLInputElement, "https://App.Example.com/");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();

    expect(request).toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains", { domain: "app.example.com" });
    expect(q(target, "custom-domain-status")?.textContent).toBe("Waiting for DNS");
    expect(q(target, "custom-domain-record-ownership")?.textContent).toContain("_xyz.acm-validations.aws");
    expect(q(target, "custom-domain-record-routing")?.textContent).toContain("launch-notes.indigo-hq.com");
    expect(q(target, "custom-domain-apex")).toBeNull();
    expect(ondone).toHaveBeenCalledWith(expect.stringContaining("app.example.com added"));
  });

  it("gives ALIAS / flattening guidance for a bare domain", async () => {
    const { target } = render(() => pending("example.com"));
    await settle();
    const apex = q(target, "custom-domain-apex");
    expect(apex?.textContent).toContain("root domain");
    expect(apex?.textContent).toContain("ALIAS");
    expect(apex?.textContent).toContain("www.example.com");
    // The routing record is rebuilt from the app host when the list carries none.
    expect(q(target, "custom-domain-record-routing")?.textContent).toContain("launch-notes.indigo-hq.com");
  });

  it("refreshes status and reports a live domain", async () => {
    const { target, request } = render((method, path) => {
      if (method === "GET") return pending();
      expect(path).toBe("/api/apps/app_1/domains/app.example.com/refresh");
      return { status: 200, body: { ok: true, validationState: "validated", certStatus: "ISSUED", serving: true } };
    });
    await settle();
    (q(target, "custom-domain-refresh") as HTMLButtonElement).click();
    await settle();
    expect(request).toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains/app.example.com/refresh", undefined);
    expect(q(target, "custom-domain-status")?.textContent).toBe("Live");
    expect(q(target, "custom-domain-dns")).toBeNull();
    expect(q(target, "custom-domain-notice")?.textContent).toContain("is live");
  });

  it("removes only after confirmation", async () => {
    const { target, request, ondone } = render((method) => {
      if (method === "GET") return pending();
      return { status: 200, body: { ok: true, domain: "app.example.com", remaining: 0 } };
    });
    await settle();
    (q(target, "custom-domain-remove") as HTMLButtonElement).click();
    flushSync();
    expect(request).not.toHaveBeenCalledWith("indigo", "DELETE", expect.anything(), undefined);
    expect(q(target, "custom-domain-confirm")?.textContent).toContain("Remove app.example.com?");
    expect(q(target, "custom-domain-confirm")?.textContent).toContain("$20/month charge stops");

    (q(target, "custom-domain-remove-confirm") as HTMLButtonElement).click();
    await settle();
    expect(request).toHaveBeenCalledWith("indigo", "DELETE", "/api/apps/app_1/domains/app.example.com", undefined);
    expect(q(target, "custom-domain-row")).toBeNull();
    expect(q(target, "custom-domain-input")).not.toBeNull();
    expect(ondone).toHaveBeenCalledWith("app.example.com removed from launch-notes.");
  });

  it("asks for a card and opens the Stripe page the server offered", async () => {
    const billingUrl = "https://billing.stripe.com/p/session/test_123";
    const { target, openExternal } = render((method) =>
      method === "GET"
        ? none()
        : { status: 402, body: { error: { status: 402, code: "PAYMENT_METHOD_REQUIRED", message: "A payment method is required", billingUrl } } },
    );
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();

    const refusal = q(target, "custom-domain-refusal-card");
    expect(refusal?.textContent).toContain("Add a card");
    expect(refusal?.textContent).toContain("$20/month");
    // A normal step in the flow: a neutral status, not a red alert.
    expect(refusal?.getAttribute("role")).toBe("status");
    expect(refusal?.classList.contains("note")).toBe(true);
    expect(target.querySelector("[role='alert']")).toBeNull();
    (q(target, "custom-domain-add-card") as HTMLButtonElement).click();
    await settle();
    expect(openExternal).toHaveBeenCalledWith(billingUrl);
    expect(q(target, "custom-domain-notice")?.textContent).toContain("add the domain again");
  });

  it("labels Set up billing as Opening… while the card page is minted", async () => {
    let release: (url: string) => void = () => {};
    const cardEntryUrl = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const { target } = render(
      (method) => (method === "GET" ? none() : { status: 402, body: { error: { code: "PAYMENT_METHOD_REQUIRED" } } }),
      { cardEntryUrl },
    );
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();
    expect(q(target, "custom-domain-add-card")?.textContent).toContain("Set up billing");
    (q(target, "custom-domain-add-card") as HTMLButtonElement).click();
    await settle();
    expect(q(target, "custom-domain-add-card")?.textContent).toContain("Opening…");
    release("https://checkout.stripe.com/c/pay/cs_test_2");
    await settle();
    expect(q(target, "custom-domain-add-card")?.textContent).toContain("Set up billing");
  });

  it("retries a failed list read by itself before offering Try again", async () => {
    let calls = 0;
    const { target } = render(() => {
      calls += 1;
      return calls === 1 ? { status: 503, body: { error: { code: "SERVICE_UNAVAILABLE" } } } : pending();
    });
    for (let i = 0; i < 4; i += 1) await settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(calls).toBe(2);
    expect(q(target, "custom-domain-error")).toBeNull();
    expect(q(target, "custom-domain-status")?.textContent).toBe("Waiting for DNS");
  });

  it("shows a read that keeps failing as a neutral note with Try again", async () => {
    const { target } = render(() => ({ status: 503, body: {} }));
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
    }
    const note = q(target, "custom-domain-error");
    expect(note?.getAttribute("role")).toBe("status");
    expect(q(target, "custom-domain-retry")).not.toBeNull();
  });

  it("copies a DNS value with an icon button", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { target } = render(() => pending());
    await settle();
    const button = target.querySelector("[data-testid='custom-domain-record-routing'] [data-testid='custom-domain-copy']") as HTMLButtonElement;
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Copy target");
    button.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("launch-notes.indigo-hq.com");
    expect(button.getAttribute("aria-label")).toBe("Copied");
  });

  it("falls back to a fresh card-entry page when the refusal carries none", async () => {
    const cardEntryUrl = vi.fn(async () => "https://checkout.stripe.com/c/pay/cs_test_1");
    const { target, openExternal } = render(
      (method) => (method === "GET" ? none() : { status: 402, body: { error: { code: "PAYMENT_METHOD_REQUIRED", billingUrl: "https://evil.example/steal" } } }),
      { cardEntryUrl },
    );
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();
    (q(target, "custom-domain-add-card") as HTMLButtonElement).click();
    await settle();
    expect(cardEntryUrl).toHaveBeenCalled();
    expect(openExternal).toHaveBeenCalledWith("https://checkout.stripe.com/c/pay/cs_test_1");
  });

  it("explains a reserved hostname before and after the network", async () => {
    const { target, request } = render((method) =>
      method === "GET" ? none() : { status: 400, body: { error: { code: "DOMAIN_RESERVED", message: "domain is reserved" } } },
    );
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "mine.hq.work");
    expect(q(target, "custom-domain-input-problem")?.textContent).toContain("belongs to HQ");
    expect((q(target, "custom-domain-add") as HTMLButtonElement).disabled).toBe(true);

    // A reserved name the client list misses is still explained from the server code.
    type(q(target, "custom-domain-input") as HTMLInputElement, "x.reserved-by-server.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();
    expect(request).toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains", { domain: "x.reserved-by-server.com" });
    expect(q(target, "custom-domain-refusal-reserved")?.textContent).toContain("belongs to HQ");
  });

  it("says plainly when the company is not eligible", async () => {
    const { target } = render((method) =>
      method === "GET" ? none() : { status: 403, body: { error: { code: "DOMAIN_NOT_ENTITLED", message: "x" } } },
    );
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();
    expect(q(target, "custom-domain-refusal-not-eligible")?.textContent).toContain("not available for this company");
  });

  it("shows members status only", async () => {
    const { target } = render(() => pending(), { canManage: false });
    await settle();
    expect(q(target, "custom-domain-status")?.textContent).toBe("Waiting for DNS");
    expect(q(target, "custom-domain-dns")).toBeNull();
    expect(q(target, "custom-domain-refresh")).toBeNull();
    expect(q(target, "custom-domain-remove")).toBeNull();
    expect(q(target, "custom-domain-input")).toBeNull();
    expect(q(target, "custom-domain-add")).toBeNull();
    expect(q(target, "custom-domain-member-note")?.textContent).toContain("owner or admin");
  });

  it("tells a member with no domain who can add one, and the price", async () => {
    const { target } = render(() => none(), { canManage: false });
    await settle();
    expect(q(target, "custom-domain-member-empty")?.textContent).toContain("owner or admin can add one for $20/month");
    expect(q(target, "custom-domain-input")).toBeNull();
  });
});
