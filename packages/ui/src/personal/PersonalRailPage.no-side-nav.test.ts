// @vitest-environment happy-dom
// OWNER-R36: personal Connections and Secrets have no left side nav. A side
// list that held one entry ("Personal") is gone; one that held only filters of
// the same list became header pills in the Deployments pattern.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalRailPage from "./PersonalRailPage.svelte";
import { clearPersonalRailCache } from "./personal-rail-model.js";
import { clearIntegrationsCache } from "./personal-integrations.js";
import { chooseDropdown, dropdownOptions, dropdownValue } from "../test-support/dropdown.js";

vi.mock("../company/company-store.svelte.js", () => ({
  companyStore: {
    revision: 0,
    loadSecrets: vi.fn(async () => [
      { name: "GITHUB_TOKEN", scope: "Personal", kind: "standard", rotatedAt: new Date().toISOString() },
      { name: "OPENAI_API_KEY", scope: "Personal", kind: "proxy", rotatedAt: new Date().toISOString() },
      { name: "OLD_TOKEN", scope: "Personal", kind: "standard" },
    ]),
    loadDeployments: vi.fn(async () => []),
  },
}));

const GOOGLE_BODY = {
  accounts: [{ accountId: "g1", email: "me@example.com", scope: "", connectedAt: "2026-09-30T12:00:00Z", capabilities: ["gmail"] }],
};
const SLACK_BODY = {
  accounts: [
    { accountId: "s1", teamId: "T1", slackUserId: "U1", teamName: "Acme", teamDomain: "acme", slackUserDisplay: "Me", companyUid: "cmp_a", capabilities: [], connectedAt: "2026-09-29T12:00:00Z", status: "active" },
  ],
};

function integrationsApi() {
  return {
    listMyGoogleAccounts: vi.fn(async () => ({ ok: true as const, value: GOOGLE_BODY })),
    listMySlackAccounts: vi.fn(async () => ({ ok: true as const, value: SLACK_BODY })),
  };
}

let component: Record<string, unknown> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  clearPersonalRailCache();
  clearIntegrationsCache();
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
}

function mountPage(page: "secrets" | "connections", extra: Record<string, unknown> = {}): HTMLElement {
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(PersonalRailPage, { target, props: { page, ...extra } });
  flushSync();
  return target;
}

const secretNames = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-testid='personal-secrets-list'] button.srow .nm")].map((el) => el.textContent);

describe("OWNER-R36 personal pages without a side nav", () => {
  it("Connections: no side nav, the count beside the title, Open console in the header", async () => {
    const opened: string[] = [];
    const root = mountPage("connections", { integrationsApi: integrationsApi(), openExternal: (url: string) => opened.push(url) });
    await settle();
    expect(root.querySelector("aside.pane")).toBeNull();
    expect(root.querySelector("[data-testid='connections-personal-nav']")).toBeNull();
    expect(root.querySelectorAll("[data-testid^='integration-row-']")).toHaveLength(2);
    const header = root.querySelector("header.toolbar") as HTMLElement;
    expect(header.querySelector("[data-testid='personal-integrations-count']")?.textContent).toBe("Connections · 2");
    const open = header.querySelector("[data-testid='connections-open-console']") as HTMLButtonElement;
    expect(open.textContent?.trim()).toBe("Open console");
    open.click();
    expect(opened).toEqual(["https://hq.computer/personal/integrations"]);
    expect(root.textContent).not.toContain("Manage connections in the web console");
    // The right detail pane stays.
    expect(root.querySelector("[data-testid='integration-inspector']")).not.toBeNull();
  });

  it("Secrets: no side nav and no lone Personal scope; filters are header pills that combine", async () => {
    const root = mountPage("secrets", { fixtures: true });
    await settle();
    expect(root.querySelector("aside.pane")).toBeNull();
    expect(root.querySelector("[data-testid='scope-personal']")).toBeNull();
    expect(root.querySelector("[data-testid='personal-secrets-list'] .sec")).toBeNull();
    expect(await dropdownValue(root, "secrets-mode-pill")).toBe("all");
    expect((await dropdownOptions(root, "secrets-mode-pill")).map((o) => o.label)).toEqual(["All modes", "Standard", "Proxy-only"]);
    const all = secretNames(root).length;

    await chooseDropdown(root, "secrets-mode-pill", "standard");
    expect(secretNames(root)).toEqual(["GITHUB_TOKEN", "SCREENPIPE_TOKEN", "VERCEL_TOKEN"]);
    (root.querySelector("[data-testid='secrets-stale-pill']") as HTMLButtonElement).click();
    flushSync();
    expect(secretNames(root)).toEqual(["SCREENPIPE_TOKEN", "VERCEL_TOKEN"]);
    expect(root.querySelector("[data-testid='personal-secrets-count']")?.textContent).toBe("Secrets · 2");

    (root.querySelector("[data-testid='secrets-clear-filters']") as HTMLButtonElement).click();
    flushSync();
    expect(secretNames(root)).toHaveLength(all);
    expect(root.querySelector("[data-testid='secrets-clear-filters']")).toBeNull();
  });
});
