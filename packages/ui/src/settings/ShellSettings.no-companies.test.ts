// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ShellSettings from "./ShellSettings.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

const companies = [
  { slug: "acme", displayName: "Acme", kind: "company", state: "synced", role: "owner" },
] as never;

async function render(initialSection: "companies" | null): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ShellSettings, { target: host, props: { companies, initialSection } });
  await tick();
}

// Companies are reached from the rail tiles and the More companies popover.
describe("ShellSettings without a companies list", () => {
  it("has no Companies section in the settings nav", async () => {
    await render(null);
    const nav = host.querySelector('[data-testid="settings-nav"]');
    expect(nav?.querySelector('[data-testid="settings-nav-profile"]')).not.toBeNull();
    expect(nav?.querySelector('[data-testid="settings-nav-companies"]')).toBeNull();
    expect(nav?.textContent).not.toMatch(/companies/i);
  });

  it("lands an old companies deep link on Profile", async () => {
    await render("companies");
    expect(
      host.querySelector('[data-testid="settings-nav-profile"]')?.getAttribute("aria-current"),
    ).toBe("page");
    expect(host.querySelector('[data-testid="settings-company-row"]')).toBeNull();
  });
});
