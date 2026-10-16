// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import NewCompanySheet from "./NewCompanySheet.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NewCompanySheet, { target: host, props });
}

async function typeName(value: string) {
  const name = host.querySelector<HTMLInputElement>("[data-testid='new-company-name']")!;
  name.value = value;
  name.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await tick();
}

describe("New company sheet (US-037)", () => {
  it("opens step 2 and creates on the free plan", async () => {
    const oncreate = vi.fn(async () => ({ ok: true as const, companyUid: "co_hm" }));
    const oncheckout = vi.fn();
    const onfinish = vi.fn();
    render({ pinnedIds: ["co_in"], pinnedInitials: ["IN"], oncreate, oncheckout, onfinish });

    await typeName("Holler Management");
    host.querySelector<HTMLButtonElement>("[data-testid='new-company-continue']")!.click();
    await vi.waitFor(() => {
      expect(host.querySelector("[data-testid='new-company-created']")).toBeTruthy();
    });
    expect(oncheckout).not.toHaveBeenCalled();
    expect(oncreate).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "holler-management", plan: "free" }),
    );

    host.querySelector<HTMLButtonElement>("[data-testid='new-company-finish']")!.click();
    await vi.waitFor(() => expect(onfinish).toHaveBeenCalled());
    expect(onfinish.mock.calls[0]?.[0]).toMatchObject({
      companyUid: "co_hm",
      pin: true,
      pinnedIds: ["co_in", "co_hm"],
    });
  });

  it("offers no Workforce plan and never opens checkout for a new company", async () => {
    const oncreate = vi.fn(async () => ({ ok: true as const, companyUid: "co_hm" }));
    const oncheckout = vi.fn();
    render({ oncreate, oncheckout });
    await typeName("Holler Management");
    expect(host.querySelector("[data-testid='new-company-plan-workforce']")).toBeNull();
    expect(host.textContent).not.toMatch(/Workforce|checkout/i);
    expect(host.querySelector("[data-testid='new-company-plan-free']")?.textContent).toContain("$10 of usage included every month");
    host.querySelector<HTMLButtonElement>("[data-testid='new-company-continue']")!.click();
    await tick();
    await vi.waitFor(() => expect(oncreate).toHaveBeenCalledWith(expect.objectContaining({ plan: "free" })));
    expect(oncheckout).not.toHaveBeenCalled();
  });
});
