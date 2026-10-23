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
  const onchange = vi.fn();
  const openExternal = vi.fn();
  component = mount(CustomDomainForm, {
    target,
    props: {
      appId: "app_1",
      appName: "launch-notes",
      appUrl: "https://launch-notes.indigo-hq.com",
      retryDelays: [0, 0],
      recordDelays: [0, 0],
      scope: "indigo",
      request,
      canManage: true,
      loadPrices: async () => ({ standardUsd: 20, premiumUsd: 500 }),
      openExternal,
      onclose: () => {},
      ondone,
      onchange,
      ...props,
    },
  });
  return { target, request, ondone, onchange, openExternal };
}

/** Let the zero-delay retry timers fire between settles. */
async function settleTimers(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
  }
}

const certRecord = (domain = "app.example.com") => ({ type: "CNAME", name: `_abc.${domain}.`, value: "_xyz.acm-validations.aws." });
const refreshPending = (instructions: unknown[] = []) => ({
  status: 200,
  body: { ok: true, certStatus: "PENDING_VALIDATION", validationState: "pending", serving: false, dnsInstructions: instructions },
});

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
    expect(q(target, "custom-domain-records-partial")).toBeNull();
    // Both records came with the add reply, so no extra read.
    expect(request).not.toHaveBeenCalledWith("indigo", "POST", expect.stringContaining("/refresh"), undefined);
    expect(ondone).toHaveBeenCalledWith(expect.stringContaining("app.example.com added"));
  });

  it("shows both DNS records together when the add reply has only the routing one", async () => {
    // ACM makes the certificate record a few seconds after the request, so
    // hq-deploy's add reply often lacks it and only a later refresh carries it.
    let refreshes = 0;
    const { target } = render((method, path) => {
      if (method === "GET") return none();
      if (path.endsWith("/refresh")) {
        refreshes += 1;
        return refreshPending(refreshes < 2 ? [] : [certRecord()]);
      }
      return {
        status: 201,
        body: {
          ok: true,
          domain: { domain: "app.example.com", validationState: "pending" },
          dnsInstructions: [{ type: "CNAME", name: "app.example.com", value: "launch-notes.indigo-hq.com" }],
          serving: false,
        },
      };
    });
    await settle();
    type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
    (q(target, "custom-domain-add") as HTMLButtonElement).click();
    await settle();
    // While the certificate record is fetched, no record shows on its own.
    expect(q(target, "custom-domain-records-loading")).not.toBeNull();
    expect(q(target, "custom-domain-record-routing")).toBeNull();
    expect(q(target, "custom-domain-record-ownership")).toBeNull();

    await settleTimers();
    expect(refreshes).toBe(2);
    expect(q(target, "custom-domain-records-loading")).toBeNull();
    expect(q(target, "custom-domain-record-ownership")?.textContent).toContain("_xyz.acm-validations.aws");
    expect(q(target, "custom-domain-record-routing")?.textContent).toContain("launch-notes.indigo-hq.com");
    expect(q(target, "custom-domain-records-partial")).toBeNull();
  });

  it("reads both DNS records when the sheet opens on a pending domain", async () => {
    const { target, request } = render((method) => (method === "GET" ? pending() : refreshPending([certRecord()])));
    await settleTimers();
    expect(request).toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains/app.example.com/refresh", undefined);
    expect(q(target, "custom-domain-record-ownership")?.textContent).toContain("_xyz.acm-validations.aws");
    expect(q(target, "custom-domain-record-routing")?.textContent).toContain("launch-notes.indigo-hq.com");
  });

  it("says so when the certificate record is still not ready after the retries", async () => {
    const { target } = render((method) => (method === "GET" ? pending() : refreshPending([])));
    await settleTimers();
    expect(q(target, "custom-domain-record-routing")).not.toBeNull();
    expect(q(target, "custom-domain-records-partial")?.textContent).toContain("Check again in a minute");
  });

  it("points a rebuilt routing record at the indigo-hq.com host for an hq.work app", async () => {
    const { target } = render((method) => (method === "GET" ? pending("yousufkalim.com") : refreshPending([certRecord("yousufkalim.com")])), {
      appUrl: "https://hq-lifecycle-email-map.hq.work",
    });
    await settleTimers();
    expect(q(target, "custom-domain-record-routing")?.textContent).toContain("hq-lifecycle-email-map.indigo-hq.com");
  });

  it("lays each record out as a titled card with its purpose, Name and Value, and a copy button for each", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { target } = render((method) => (method === "GET" ? pending() : refreshPending([certRecord()])));
    await settleTimers();
    const status = q(target, "custom-domain-status");
    expect(status?.textContent).toBe("Waiting for DNS");
    expect(status?.dataset.tone).toBe("waiting");

    const cert = q(target, "custom-domain-record-ownership")!;
    const site = q(target, "custom-domain-record-routing")!;
    expect(cert.textContent).toContain("Certificate record");
    expect(cert.textContent).toContain("confirm you own app.example.com");
    expect(site.textContent).toContain("Website record");
    expect(site.textContent).toContain("Sends people who visit app.example.com to launch-notes");
    // Long values wrap once, after the random first label; the rest stays whole.
    const valueParts = [...(cert.querySelectorAll("dd")[1]?.querySelectorAll(".seg") ?? [])].map((el) => el.textContent);
    expect(valueParts).toEqual(["_xyz.", "acm-validations.aws"]);

    (site.querySelector("[data-testid='custom-domain-copy-name']") as HTMLButtonElement).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("app.example.com");
    expect(q(target, "custom-domain-name-tip")?.textContent).toContain("@");
  });

  it("shows Verifying while a check runs and once the certificate is issued", async () => {
    let release: (v: { status: number; body: unknown }) => void = () => {};
    let refreshes = 0;
    const request = vi.fn(async (_scope: string, method: string) => {
      if (method === "GET") return ok(pending());
      refreshes += 1;
      if (refreshes === 1) return ok(refreshPending([certRecord()]));
      return ok(await new Promise<{ status: number; body: unknown }>((resolve) => (release = resolve)));
    });
    const { target } = render(() => ({ status: 200, body: {} }), { request });
    await settleTimers();
    (q(target, "custom-domain-refresh") as HTMLButtonElement).click();
    await settle();
    expect(q(target, "custom-domain-status")?.textContent).toBe("Verifying");
    release({ status: 200, body: { ok: true, certStatus: "ISSUED", validationState: "pending", serving: false } });
    await settle();
    // Certificate issued, serving not attached yet: still Verifying, not Waiting for DNS.
    expect(q(target, "custom-domain-status")?.textContent).toBe("Verifying");
    expect(q(target, "custom-domain-status")?.dataset.tone).toBe("verifying");
    expect(q(target, "custom-domain-verifying")?.textContent).toContain("HQ found your records");
  });

  describe("company price", () => {
    const priceOf = async (loadCompanyPrice: () => Promise<unknown>, props: Record<string, unknown> = {}) => {
      const rendered = render(() => none(), { loadCompanyPrice, companyName: "Acme", ...props });
      await settle();
      return rendered;
    };

    it("says enterprise companies are included", async () => {
      const { target } = await priceOf(async () => ({ basis: "enterprise", monthlyPriceUsd: 0 }));
      expect(q(target, "custom-domain-price")?.textContent).toBe("Custom domains are included in Acme's enterprise plan. Nothing is charged.");
    });

    it("says comped companies and a 0 override are not charged", async () => {
      const comped = await priceOf(async () => ({ basis: "comped", monthlyPriceUsd: 0 }));
      expect(q(comped.target, "custom-domain-price")?.textContent).toBe("Acme is not charged for custom domains.");
      await unmount(component as Record<string, unknown>);
      component = null;
      document.body.innerHTML = "";
      const override = await priceOf(async () => ({ basis: "paid", monthlyPriceUsd: 0 }), { companyName: "Domain Demo (test)" });
      expect(q(override.target, "custom-domain-price")?.textContent).toBe("Domain Demo (test) is not charged for custom domains.");
    });

    it("shows a paid company its own price and the card state", async () => {
      const withCard = await priceOf(async () => ({ basis: "paid", monthlyPriceUsd: 12.5, cardOnFile: true }));
      expect(q(withCard.target, "custom-domain-price")?.textContent).toBe("It adds $12.50/month to Acme's bill. The card on file is charged; no card form is needed.");
      await unmount(component as Record<string, unknown>);
      component = null;
      document.body.innerHTML = "";
      const noCard = await priceOf(async () => ({ basis: "paid", monthlyPriceUsd: 20, cardOnFile: false }));
      expect(q(noCard.target, "custom-domain-price")?.textContent).toContain("Acme has no card on file");
    });

    it("turns add off when custom domains are not enabled", async () => {
      const { target, request } = await priceOf(async () => ({ basis: "not_enabled", monthlyPriceUsd: null }));
      expect(q(target, "custom-domain-price")?.textContent).toContain("not available for Acme");
      type(q(target, "custom-domain-input") as HTMLInputElement, "mysite.com");
      expect((q(target, "custom-domain-add") as HTMLButtonElement).disabled).toBe(true);
      expect(request).not.toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains", expect.anything());
    });

    it("keeps the catalog price when the company price route is missing or fails, never included", async () => {
      const missing = await priceOf(async () => {
        throw new Error("HTTP 404");
      });
      expect(q(missing.target, "custom-domain-price")?.textContent).toBe("$20/month for this deployment, billed to the company. Remove it any time to stop the charge.");
      expect(q(missing.target, "custom-domain-price")?.textContent).not.toMatch(/included|not charged/);
      await unmount(component as Record<string, unknown>);
      component = null;
      document.body.innerHTML = "";
      const garbled = await priceOf(async () => ({ basis: "paid" }));
      expect(q(garbled.target, "custom-domain-price")?.dataset.basis).toBe("catalog");
    });

    it("uses the company's price in the card refusal and the add reply's price on remove", async () => {
      const { target } = render(
        (method) => {
          if (method === "GET") return none();
          if (method === "POST") {
            return {
              status: 201,
              body: {
                ok: true,
                domain: { domain: "app.example.com", validationState: "pending" },
                dnsInstructions: [certRecord(), { type: "CNAME", name: "app.example.com", value: "launch-notes.indigo-hq.com" }],
                serving: false,
                billingBasis: "paid",
                monthlyPriceUsd: 7,
              },
            };
          }
          return { status: 200, body: { ok: true, remaining: 0 } };
        },
        { loadCompanyPrice: async () => ({ basis: "paid", monthlyPriceUsd: 12.5 }), companyName: "Acme" },
      );
      await settle();
      type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
      (q(target, "custom-domain-add") as HTMLButtonElement).click();
      await settle();
      (q(target, "custom-domain-remove") as HTMLButtonElement).click();
      flushSync();
      expect(q(target, "custom-domain-confirm")?.textContent).toContain("$7/month charge stops");
    });

    it("prices the card refusal with the company's own amount", async () => {
      const { target } = render(
        (method) => (method === "GET" ? none() : { status: 402, body: { error: { code: "PAYMENT_METHOD_REQUIRED" } } }),
        { loadCompanyPrice: async () => ({ basis: "paid", monthlyPriceUsd: 12.5, cardOnFile: false }), companyName: "Acme" },
      );
      await settle();
      type(q(target, "custom-domain-input") as HTMLInputElement, "app.example.com");
      (q(target, "custom-domain-add") as HTMLButtonElement).click();
      await settle();
      expect(q(target, "custom-domain-refusal-card")?.textContent).toContain("$12.50/month");
    });
  });

  it("never steers people to a subdomain", async () => {
    const empty = render(() => none());
    await settle();
    expect((q(empty.target, "custom-domain-input") as HTMLInputElement).placeholder).toBe("mysite.com");
    expect(q(empty.target, "custom-domain-price")?.textContent).not.toMatch(/subdomain/i);
    await unmount(component as Record<string, unknown>);
    component = null;
    document.body.innerHTML = "";

    // A bare domain gets the same two records and no root-domain or provider paragraph.
    const bare = render((method) => (method === "GET" ? pending("yousufkalim.com") : refreshPending([certRecord("yousufkalim.com")])));
    await settleTimers();
    expect(q(bare.target, "custom-domain-dns")?.textContent).not.toMatch(/subdomain|root domain|ALIAS|flattening/i);
    expect(q(bare.target, "custom-domain-record-routing")?.textContent).toContain("yousufkalim.com");
  });

  it("refreshes status and reports a live domain", async () => {
    let refreshes = 0;
    const { target, request, onchange } = render((method, path) => {
      if (method === "GET") return pending();
      expect(path).toBe("/api/apps/app_1/domains/app.example.com/refresh");
      refreshes += 1;
      // The first read (on open) fetches the records; the click finds it live.
      return refreshes === 1
        ? refreshPending([certRecord()])
        : { status: 200, body: { ok: true, validationState: "validated", certStatus: "ISSUED", serving: true } };
    });
    await settleTimers();
    expect(onchange).not.toHaveBeenCalled();
    (q(target, "custom-domain-refresh") as HTMLButtonElement).click();
    await settle();
    expect(request).toHaveBeenCalledWith("indigo", "POST", "/api/apps/app_1/domains/app.example.com/refresh", undefined);
    expect(q(target, "custom-domain-status")?.textContent).toBe("Live");
    expect(q(target, "custom-domain-dns")).toBeNull();
    expect(q(target, "custom-domain-notice")?.textContent).toContain("is live");
    // The deployment's address changes to the custom domain.
    expect(onchange).toHaveBeenCalledTimes(1);
  });

  it("removes only after confirmation", async () => {
    const { target, request, ondone, onchange } = render((method) => {
      if (method === "GET") return pending();
      if (method === "POST") return refreshPending([certRecord()]);
      return { status: 200, body: { ok: true, domain: "app.example.com", remaining: 0 } };
    });
    await settleTimers();
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
    expect(onchange).toHaveBeenCalledTimes(1);
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
    const { target } = render((method) => {
      if (method !== "GET") return refreshPending([certRecord()]);
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
    const { target } = render((method) => (method === "GET" ? pending() : refreshPending([certRecord()])));
    await settleTimers();
    const button =target.querySelector("[data-testid='custom-domain-record-routing'] [data-testid='custom-domain-copy']") as HTMLButtonElement;
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("Copy value");
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
