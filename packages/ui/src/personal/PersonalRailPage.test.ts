// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalRailPage from "./PersonalRailPage.svelte";

vi.mock("../company/company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => [
      { name: "GITHUB_TOKEN", scope: "Personal", value: "ghp_do_not_render", kind: "standard" },
      { name: "ATTIO_API_KEY", scope: "Company", value: "sk-company-do-not-render", kind: "standard" },
    ]),
    loadDeployments: vi.fn(async () => []),
  },
}));

describe("US-033 PersonalRailPage", () => {
  let component: Record<string, unknown> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
  });

  function mountPage(page: "secrets" | "connections") {
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(PersonalRailPage, { target, props: { page } });
    flushSync();
    return target;
  }

  it("opens on personal-scope secrets and never renders a value", async () => {
    const target = mountPage("secrets");
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    const list = target.querySelector("[data-testid='personal-secrets-list']");
    expect(list?.textContent).toContain("GITHUB_TOKEN");
    expect(list?.textContent).not.toContain("ATTIO_API_KEY");
    expect(target.textContent).not.toContain("ghp_do_not_render");
    expect(target.textContent).not.toContain("sk-company");
    const share = target.querySelector("[data-testid='share-secret']") as HTMLButtonElement;
    share.click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-share-secret']")).not.toBeNull();
    expect(target.querySelector("[data-testid='share-no-value']")?.textContent).toContain("No secret value");
    expect(target.textContent).toContain("read");
    expect(target.textContent).toContain("write");
  });

  it("shows Allowed, Ask first, and Never on the Agents and MCP tab", () => {
    const target = mountPage("connections");
    const tab = target.querySelector("[data-testid='agents-mcp']") as HTMLButtonElement;
    tab.click();
    flushSync();
    const policy = target.querySelector("[data-testid='policy-github']");
    expect(policy?.textContent).toContain("Allowed");
    expect(policy?.textContent).toContain("Ask first");
    expect(policy?.textContent).toContain("Never");
    const ask = [...(policy?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Never");
    ask?.click();
    flushSync();
    expect(policy?.querySelector("[aria-pressed='true']")?.textContent).toBe("Never");
  });
});
