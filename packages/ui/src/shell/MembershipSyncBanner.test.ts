// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import MembershipSyncBanner from "./MembershipSyncBanner.svelte";
import type { Workspace } from "../chat/workspaces.js";

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "cloud-only",
    cloudUid: "cmp_acme",
    bucketName: "hq-acme",
    hasLocalFolder: false,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe("membership sync banner", () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("names the company and offers a Sync now action", () => {
    host = document.createElement("div");
    document.body.append(host);
    const onsync = vi.fn();
    const ondismiss = vi.fn();
    component = mount(MembershipSyncBanner, {
      target: host,
      props: {
        memberships: [workspace({})],
        onsync,
        ondismiss,
      },
    });
    flushSync();

    expect(host.textContent).toContain("Added to Acme");
    expect(host.textContent).toContain("Sync to pull it onto this machine.");

    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
      .click();
    expect(onsync).toHaveBeenCalledTimes(1);

    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-dismiss"]')!
      .click();
    expect(ondismiss).toHaveBeenCalledWith(["acme"]);
  });

  it("dismisses every membership it speaks for, not just the named one", () => {
    // The copy aggregates ("Added to Acme + 2 more"), so dismissing only the
    // first slug re-renders the banner for the second and reads as the button
    // being ignored — the user has to click Dismiss once per company.
    host = document.createElement("div");
    document.body.append(host);
    const ondismiss = vi.fn();
    component = mount(MembershipSyncBanner, {
      target: host,
      props: {
        memberships: [
          workspace({ slug: "acme", displayName: "Acme" }),
          workspace({ slug: "globex", displayName: "Globex" }),
          workspace({ slug: "initech", displayName: "Initech" }),
        ],
        ondismiss,
      },
    });
    flushSync();

    expect(host.textContent).toContain("Added to Acme + 2 more");
    host
      .querySelector<HTMLButtonElement>('[data-testid="membership-sync-dismiss"]')!
      .click();
    expect(ondismiss).toHaveBeenCalledWith(["acme", "globex", "initech"]);
  });

  it("shows a failure message and offers a retry instead of a silent no-op", () => {
    host = document.createElement("div");
    document.body.append(host);
    component = mount(MembershipSyncBanner, {
      target: host,
      props: {
        memberships: [workspace({})],
        error: "Your HQ session needs a quick refresh.",
      },
    });
    flushSync();

    const error = host.querySelector('[data-testid="membership-sync-error"]');
    expect(error?.textContent).toContain("needs a quick refresh");
    // Screen readers must hear a failure that arrives after mount.
    expect(error?.closest('[role="alert"]')).toBeTruthy();
    expect(
      host
        .querySelector<HTMLButtonElement>('[data-testid="membership-sync-now"]')!
        .textContent?.trim(),
    ).toBe("Try again");
  });

  it("labels the banner as a region rather than announcing it as a status", () => {
    // role="status" makes the whole banner — buttons included — a live region.
    host = document.createElement("div");
    document.body.append(host);
    component = mount(MembershipSyncBanner, {
      target: host,
      props: { memberships: [workspace({})] },
    });
    flushSync();

    const banner = host.querySelector('[data-testid="membership-sync-banner"]')!;
    expect(banner.getAttribute("role")).toBe("region");
    expect(banner.getAttribute("aria-label")).toBeTruthy();
  });

  it("pluralizes copy and disables the action while syncing", () => {
    host = document.createElement("div");
    document.body.append(host);
    component = mount(MembershipSyncBanner, {
      target: host,
      props: {
        memberships: [
          workspace({ slug: "acme", displayName: "Acme" }),
          workspace({ slug: "globex", displayName: "Globex" }),
        ],
        syncing: true,
      },
    });
    flushSync();

    expect(host.textContent).toContain("Added to Acme + 1 more");
    expect(host.textContent).toContain("Sync to pull them onto this machine.");
    const syncButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="membership-sync-now"]',
    )!;
    expect(syncButton.disabled).toBe(true);
    expect(syncButton.textContent?.trim()).toBe("Syncing…");
  });

  it("renders nothing when there are no memberships to pull", () => {
    host = document.createElement("div");
    document.body.append(host);
    component = mount(MembershipSyncBanner, {
      target: host,
      props: { memberships: [] },
    });
    flushSync();

    expect(host.querySelector('[data-testid="membership-sync-banner"]')).toBeNull();
  });
});
