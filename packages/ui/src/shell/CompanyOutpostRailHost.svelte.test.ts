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

  function mountHost(readPricing: () => Promise<AdapterResult<Json>>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(CompanyOutpostRailHost, {
      target,
      props: {
        companyUid: "cmp_1",
        companyLabel: "Indigo",
        role: "member",
        readPricing,
        api: {
          listCompanyOutposts: async () => ({ ok: true as const, value: { outposts: [] } }),
        },
      },
    });
    flushSync();
    return target;
  }

  it("shows the shared loader while pricing has not returned", () => {
    const target = mountHost(() => new Promise(() => {}));
    expect(target.querySelector(".read-loader")).not.toBeNull();
    expect(target.querySelector("[data-testid='company-outpost']")).toBeNull();
    expect(target.textContent ?? "").not.toBe("");
  });

  async function settledList(target: HTMLElement) {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      flushSync();
      if (target.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready") === "true") return;
    }
  }

  it("opens the list when pricing fails or throws", async () => {
    const failed = mountHost(async () => ({ ok: false, reason: "error", message: "pricing unavailable" }));
    await settledList(failed);
    expect(failed.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready")).toBe("true");
    expect(failed.querySelector("[data-testid='empty-outposts']")).not.toBeNull();
    expect(failed.querySelector(".read-loader")).toBeNull();

    await unmount(component!);
    component = null;
    const thrown = mountHost(async () => {
      throw new Error("forbidden");
    });
    await settledList(thrown);
    expect(thrown.querySelector("[data-testid='company-outpost']")?.getAttribute("data-ready")).toBe("true");
    expect(thrown.querySelector(".read-loader")).toBeNull();
  });
});
