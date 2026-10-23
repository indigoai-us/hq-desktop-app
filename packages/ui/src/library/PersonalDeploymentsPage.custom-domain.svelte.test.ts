// @vitest-environment happy-dom

// US-007: the global Deployments page offers the company Custom domain sheet
// on company rows, the same component as Company › Deployments. Personal rows
// and hosts without the domain routes do not offer it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import PersonalDeploymentsPage from "./PersonalDeploymentsPage.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

const app = (id: string, name: string, minutesAgo: number) => ({
  id,
  name,
  subdomain: name,
  url: `https://${name}.indigo-hq.com`,
  status: "active",
  active: true,
  accessMode: "public",
  createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
});

function render(props: Record<string, unknown> = {}) {
  const listDeployApps = async (scope: string) =>
    ({
      ok: true,
      value: scope === "personal" ? { apps: [app("p1", "my-notes", 30)] } : { apps: [app("app_1", "domain-demo", 5)] },
    }) as never;
  const deployDomainRequest = vi.fn(async () => ({ ok: true, value: { status: 200, body: { appId: "app_1", domains: [] } } }) as never);
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PersonalDeploymentsPage, {
    target: host,
    props: {
      accountId: `us-007-${Math.random()}`,
      listDeployApps,
      companies: [{ slug: "domain-demo-test", displayName: "Domain Demo (test)", kind: "company", state: "synced", cloudUid: "cmp_demo", role: "owner" }],
      deployDomainRequest,
      loadDomainPrices: async () => ({ standardUsd: 20, premiumUsd: 500 }),
      ...props,
    } as never,
  });
  flushSync();
  return { host, deployDomainRequest };
}

const rows = () => [...(host?.querySelectorAll("[data-testid='deploy-row']") ?? [])] as HTMLButtonElement[];
const pick = (name: string) => rows().find((r) => r.textContent?.includes(name))!;

describe("PersonalDeploymentsPage custom domain (US-007)", () => {
  it("opens the company Custom domain sheet from a company row", async () => {
    const { deployDomainRequest } = render();
    await expect.poll(() => rows().length).toBe(2);
    pick("domain-demo").click();
    flushSync();
    const button = host!.querySelector("[data-testid='deploy-custom-domain']") as HTMLButtonElement;
    expect(button?.textContent).toContain("Custom domain");
    button.click();
    flushSync();
    expect(host!.querySelector("[data-testid='sheet-deploy-domain']")).not.toBeNull();
    await expect.poll(() => host!.querySelector("[data-testid='custom-domain-input']")).not.toBeNull();
    expect(deployDomainRequest).toHaveBeenCalledWith("domain-demo-test", "GET", "/api/apps/app_1/domains", undefined);
    expect(host!.querySelector("[data-testid='custom-domain-price']")?.textContent).toContain("$20/month");
  });

  it("does not offer it on a personal row", async () => {
    render();
    await expect.poll(() => rows().length).toBe(2);
    pick("my-notes").click();
    flushSync();
    expect(host!.querySelector("[data-testid='deploy-custom-domain']")).toBeNull();
  });

  it("shows members the status-only sheet", async () => {
    render({ companies: [{ slug: "domain-demo-test", displayName: "Domain Demo (test)", kind: "company", state: "synced", cloudUid: "cmp_demo", role: "member" }] });
    await expect.poll(() => rows().length).toBe(2);
    pick("domain-demo").click();
    flushSync();
    (host!.querySelector("[data-testid='deploy-custom-domain']") as HTMLButtonElement).click();
    flushSync();
    await expect.poll(() => host!.querySelector("[data-testid='custom-domain-member-empty']")).not.toBeNull();
    expect(host!.querySelector("[data-testid='custom-domain-input']")).toBeNull();
  });

  it("shows and visits the live custom domain instead of the default address", async () => {
    const openExternal = vi.fn();
    const deployDomainRequest = vi.fn(async () =>
      ({ ok: true, value: { status: 200, body: { appId: "app_1", domains: [{ domain: "yousufkalim.com", validationState: "validated" }] } } }) as never,
    );
    render({ deployDomainRequest, openExternal });
    await expect.poll(() => rows().length).toBe(2);
    pick("domain-demo").click();
    flushSync();
    await expect.poll(() => host!.querySelector("[data-testid='deploy-url']")?.textContent).toBe("https://yousufkalim.com");
    (host!.querySelector("[data-testid='deploy-visit']") as HTMLButtonElement).click();
    expect(openExternal).toHaveBeenCalledWith("https://yousufkalim.com");

    // A personal row has no custom domain and keeps its own address.
    pick("my-notes").click();
    flushSync();
    await expect.poll(() => host!.querySelector("[data-testid='deploy-url']")?.textContent).toBe("https://my-notes.indigo-hq.com");
  });

  it("hides it on a host without the domain routes", async () => {
    render({ deployDomainRequest: null });
    await expect.poll(() => rows().length).toBe(2);
    pick("domain-demo").click();
    flushSync();
    expect(host!.querySelector("[data-testid='deploy-custom-domain']")).toBeNull();
  });
});
