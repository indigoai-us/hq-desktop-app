// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PersonalLibraryPage from "./PersonalLibraryPage.svelte";
import PersonalDeploymentsPage from "./PersonalDeploymentsPage.svelte";

describe("US-031 personal library and deployments", () => {
  let component: Record<string, unknown> | null = null;
  let host: HTMLDivElement;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("shows the selected shared file in the preview column", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalLibraryPage, { target: host, props: {} });
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="library-shared-tab"]')!.click();
    flushSync();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="library-shared-row"]')];
    expect(rows.length).toBeGreaterThan(1);
    rows[1]!.click();
    flushSync();
    expect(host.querySelector('[data-testid="library-preview-name"]')?.textContent).toContain("dunning-reconcile");
    expect(host.querySelector('[data-testid="library-file-preview"]')?.textContent).toContain("dunning-reconcile");
    expect(host.querySelector('[data-testid="library-your-access"]')?.textContent).toContain("write");
  });

  it("preview shows one action row and Share opens the share sheet", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalLibraryPage, { target: host, props: {} });
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="library-shared-tab"]')!.click();
    flushSync();
    host.querySelectorAll<HTMLButtonElement>('[data-testid="library-shared-row"]')[0]!.click();
    flushSync();
    expect(host.querySelectorAll('[data-testid="library-preview-actions"]').length).toBe(1);
    const labels = [...host.querySelectorAll('[data-testid="library-preview"] button')].map((b) => b.textContent?.trim());
    expect(labels.filter((l) => l === "Copy path").length).toBe(1);
    host.querySelector<HTMLButtonElement>('[data-testid="library-preview-share"]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid="file-share-sheet"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="file-share-unavailable"]')?.textContent).toContain("Only the owner");
  });

  it("renders real hq-deploy rows from every scope, not the fixture", async () => {
    localStorage.clear();
    const calls: string[] = [];
    const apps = Array.from({ length: 250 }, (_, i) => ({
      id: `a${i}`,
      name: `real-app-${i}`,
      subdomain: `real-app-${i}`,
      url: `https://real-app-${i}.indigo-hq.com`,
      status: "active",
      active: true,
      accessMode: "company",
      ownerId: i === 0 ? "me" : "other",
      views30d: i === 0 ? null : i,
      lastVisitAt: null,
    }));
    const listDeployApps = async (scope: string) => {
      calls.push(scope);
      if (scope === "broken-co") return { ok: false as const, reason: "error" as const, message: "boom" };
      if (scope === "personal") {
        return { ok: true as const, value: { callerSub: "me", apps: [{ id: "p1", name: "mine", subdomain: "mine", url: "https://mine.indigo-hq.com", status: "building", active: true, ownerId: "me", views30d: 3 }] } };
      }
      return { ok: true as const, value: { callerSub: "me", apps } };
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, {
      target: host,
      props: {
        accountId: "acct-real",
        listDeployApps,
        companies: [
          { slug: "indigo", displayName: "Indigo", kind: "company", state: "synced" },
          { slug: "broken-co", displayName: "Broken Co", kind: "company", state: "synced" },
          { slug: "local-co", displayName: "Local", kind: "company", state: "local-only" },
        ],
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="deploy-skeleton"]')).not.toBeNull();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="deploy-count"]')?.textContent).toBe("251 apps"));
    expect(calls.sort()).toEqual(["broken-co", "indigo", "personal"]);
    expect(host.textContent).not.toContain("hq-desktop-console-rail-storyboard");
    expect(host.querySelectorAll('[data-testid="deploy-row"]').length).toBe(200);
    expect(host.querySelector('[data-testid="deploy-failed-scopes"]')?.textContent).toContain("Broken Co");
    const first = [...host.querySelectorAll<HTMLButtonElement>('[data-testid="deploy-row"]')].find((row) =>
      row.textContent?.includes("real-app-0"),
    )!;
    expect(first.textContent).toContain("—");
    expect(first.textContent).not.toMatch(/\b0\b/);
  });

  it("paints the cached list first and says redeploy is not wired", async () => {
    localStorage.clear();
    const rows = [{ id: "personal:c1", name: "cached-app", url: "https://cached-app.indigo-hq.com", host: ".indigo-hq.com", project: "", detail: "", scope: "personal", scopeLabel: "Personal", scopeMark: "PE", status: "building", access: "Public", views30d: 4, lastVisit: "", step: 2, liveVersion: "v1", nextVersion: "v2", byYou: true, byBot: false, log: [] }];
    localStorage.setItem("hq.personal-deployments.v2:acct-cache", JSON.stringify({ rows }));
    let release: (() => void) | null = null;
    const listDeployApps = () =>
      new Promise<{ ok: true; value: { apps: unknown[] } }>((resolve) => {
        release = () => resolve({ ok: true, value: { apps: [] } });
      });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(PersonalDeploymentsPage, { target: host, props: { accountId: "acct-cache", listDeployApps } });
    flushSync();
    expect(host.querySelector('[data-testid="deploy-skeleton"]')).toBeNull();
    expect(host.querySelector('[data-testid="deploy-row"]')?.textContent).toContain("cached-app");
    expect(host.querySelector('[data-testid="deploy-live-until-swap"]')?.textContent).toContain("v1");
    host.querySelector<HTMLButtonElement>('[data-testid="deploy-redeploy"]')!.click();
    flushSync();
    expect(host.querySelector('[data-testid="deploy-redeploy-notice"]')?.textContent).toContain("isn't wired up yet");
    release!();
  });
});
