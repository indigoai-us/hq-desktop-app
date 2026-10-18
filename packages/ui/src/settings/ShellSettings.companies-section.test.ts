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

// Owner-approved 2026-10-11: Companies is its own Settings screen again, and
// the Companies and roles list moved off Profile into it.
describe("ShellSettings Companies section", () => {
  it("lists Companies in the settings nav", async () => {
    await render(null);
    const nav = host.querySelector('[data-testid="settings-nav"]');
    expect(nav?.querySelector('[data-testid="settings-nav-companies"]')?.textContent).toMatch(
      /Companies/,
    );
  });

  it("lands a companies deep link on the Companies screen", async () => {
    await render("companies");
    expect(
      host.querySelector('[data-testid="settings-nav-companies"]')?.getAttribute("aria-current"),
    ).toBe("page");
    expect(host.querySelectorAll('[data-testid="settings-company-row"]').length).toBe(1);
  });
});
