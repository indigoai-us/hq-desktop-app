// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyApi } from "@hq/platform";
import PersonalRailHost from "./PersonalRailHost.svelte";
import { configureCompanyApi } from "../company/company-store.svelte.js";
import { clearPersonalRailCache } from "../personal/personal-rail-model.js";

// OWNER-R32: personal Secrets in the main window, with no company pane mounted.
describe("OWNER-R32 PersonalRailHost personal secrets", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    configureCompanyApi(null);
    clearPersonalRailCache();
  });

  async function settleUntil(check: () => boolean): Promise<void> {
    for (let i = 0; i < 50 && !check(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      flushSync();
    }
  }

  it("lists personal secrets without a company pane having configured the store", async () => {
    configureCompanyApi(null);
    const getSecrets = vi.fn(async () => ({
      ok: true as const,
      value: [{ name: "PERSONAL_TEST_KEY", scope: "Personal", kind: "standard" }],
    }));
    const companyApi = { getSecrets } as unknown as CompanyApi;
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(PersonalRailHost, { target, props: { page: "secrets", companyApi } });
    flushSync();
    await settleUntil(() => (target.textContent ?? "").includes("PERSONAL_TEST_KEY"));

    expect(getSecrets).toHaveBeenCalledWith("personal");
    expect(target.textContent).toContain("PERSONAL_TEST_KEY");
    expect(target.textContent).not.toContain("not available in this window");
  });

  it("the main window hands the company backend to the personal rail host", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "DesktopApp.svelte"), "utf8");
    const host = source.match(/<PersonalRailHost[\s\S]*?\/>/);
    expect(host?.[0]).toMatch(/companyApi=\{adapter\.company/);
  });
});

describe("OWNER-R32 company store is configured for the whole main window", () => {
  it("DesktopApp configures the company store outside the company sidepane", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "DesktopApp.svelte"), "utf8");
    const script = source.slice(0, source.indexOf("</script>"));
    expect(script).toMatch(/configureCompanyApi\(adapter\.company\)/);
  });
});
