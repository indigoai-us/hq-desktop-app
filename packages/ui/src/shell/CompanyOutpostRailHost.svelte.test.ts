// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterResult, Json } from "@hq/platform";
import CompanyOutpostRailHost from "./CompanyOutpostRailHost.svelte";

describe("Company Outpost rail host", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  function mountHost(listCompanyOutposts: () => Promise<AdapterResult<Json>>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyOutpostRailHost, {
      target,
      props: {
        companyUid: "cmp_1",
        role: "member",
        api: { listCompanyOutposts },
      },
    });
    flushSync();
    return target;
  }

  async function settledList(target: HTMLElement) {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      flushSync();
      if (target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready") === "true") return;
    }
  }

  it("shows the shared loader while the list has not returned", () => {
    const target = mountHost(() => new Promise(() => {}));
    expect(target.querySelector(".read-loader")).not.toBeNull();
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready")).toBe("false");
    expect(target.querySelector("[data-testid='empty-outposts']")).toBeNull();
  });

  it("opens the list once the list returns, with no billing text", async () => {
    const target = mountHost(async () => ({ ok: true as const, value: { outposts: [], price: { monthlyUsd: 80, payer: "company" } } }));
    await settledList(target);
    expect(target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready")).toBe("true");
    expect(target.querySelector("[data-testid='empty-outposts']")).not.toBeNull();
    expect(target.querySelector(".read-loader")).toBeNull();
    expect(target.textContent ?? "").not.toMatch(/billing|billed|charge|payment|payer|USD|\$\d/i);
  });
});
