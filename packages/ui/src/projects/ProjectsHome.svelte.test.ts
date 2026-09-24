// @vitest-environment happy-dom

// The Projects page picks one company at a time: only companies this person
// belongs to with a folder on this Mac, the channel's company first, and a
// switch reports the new company so navigation history records it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import type { Workspace } from "../chat/workspaces.js";

vi.mock("./CompanyProjectsPage.svelte", async () => ({
  default: (await import("./CompanyProjectsPage.stub.svelte")).default,
}));

import ProjectsHome from "./ProjectsHome.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function ws(over: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_acme",
    bucketName: null,
    hasLocalFolder: true,
    localPath: "/hq/companies/acme",
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    ...over,
  } as Workspace;
}

const COMPANIES = [
  ws({ slug: "zeta", displayName: "Zeta", cloudUid: "cmp_zeta" }),
  ws({ slug: "acme", displayName: "Acme" }),
  ws({ slug: "remote", displayName: "Remote", hasLocalFolder: false }),
  ws({ slug: "pending", displayName: "Pending", membershipStatus: "pending" }),
  ws({ slug: "personal", displayName: "Personal", kind: "personal" }),
];

async function render(props: Record<string, unknown>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ProjectsHome, {
    target: host,
    props: { adapter: {} as PlatformAdapter, companies: COMPANIES, ...props } as never,
  });
  flushSync();
  await tick();
  return host;
}

const shown = (el: HTMLElement) => el.querySelector('[data-testid="projects-stub"]')?.getAttribute("data-slug");

describe("ProjectsHome", () => {
  it("shows the channel's company first and passes its cloud id to the board", async () => {
    const el = await render({ preferredSlug: "zeta" });
    expect(shown(el)).toBe("zeta");
    expect(el.querySelector('[data-testid="projects-stub"]')?.getAttribute("data-uid")).toBe("cmp_zeta");
  });

  it("falls back to the first company by name", async () => {
    const el = await render({});
    expect(shown(el)).toBe("acme");
  });

  it("offers only companies with a folder on this Mac and an active membership", async () => {
    const onslugchange = vi.fn();
    const el = await render({ onslugchange });
    el.querySelector<HTMLButtonElement>('[data-testid="projects-company-switcher"]')!.click();
    flushSync();
    const items = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
    expect(items.map((i) => i.textContent?.trim().replace(/^\w\s*/, ""))).toEqual(["Acme", "Zeta"]);
    items[1].click();
    expect(onslugchange).toHaveBeenCalledWith("zeta");
  });

  it("says so when no company has synced to this Mac", async () => {
    const el = await render({ companies: [COMPANIES[2]] });
    expect(el.querySelector('[data-testid="projects-home-empty"]')).not.toBeNull();
  });
});
