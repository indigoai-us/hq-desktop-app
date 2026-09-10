// @vitest-environment happy-dom

/**
 * `extraPages` — the generic host-destination extension point.
 *
 * A vendored local divergence (see `packages/VENDORED.md`): Sync mounts its own
 * Sessions surface inside this shell, and the shell must gain destinations
 * WITHOUT learning what they are. So the contract proved here is deliberately
 * page-agnostic — a palette row, a mounted component, a deep-link param, and a
 * loud failure for an id no host registered.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import DesktopApp from "./DesktopApp.svelte";
import ExtraPageProbe from "./ExtraPageProbe.test.svelte";
import { createFixtureChatSidebarApi } from "./fixtures.js";
import { createEmptyNotificationsApi } from "./mesh-overlay.js";
import {
  dispatchEmbeddedNavigation,
  type EmbeddedNavigationTarget,
} from "./embedded-navigation.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

function webAdapter(): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    capabilities: {},
    messaging: {
      listContacts: async () => ok({ contacts: [] }),
      fetchChannel: async () => ok(null),
      fetchDm: async () => ok(null),
    },
  } as unknown as PlatformAdapter;
}

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
});

const probePages = {
  probe: {
    label: "Probe",
    detail: "A host-registered destination",
    component: ExtraPageProbe,
  },
};

async function mountShell(
  extraPages?: Record<string, (typeof probePages)["probe"]>,
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(DesktopApp, {
    target: host,
    props: {
      adapter: webAdapter(),
      sidebarApi: createFixtureChatSidebarApi(),
      notificationsApi: createEmptyNotificationsApi(),
      self: {
        uid: "prs_test",
        displayName: "Stefan Johnson",
        email: "stefan@example.com",
      },
      coreFixtures: false,
      ...(extraPages ? { extraPages } : {}),
    },
  });
  // The shell registers its ⌘K/global key listener from `onMount`, which Svelte
  // flushes after the current task — a bare `tick()` returns before it exists.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await tick();
}

/** ⌘K — the shell's own palette toggle, so the test uses the real path. */
async function openPalette(): Promise<void> {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
  );
  await tick();
}

async function navigateEmbedded(
  target: EmbeddedNavigationTarget,
): Promise<void> {
  dispatchEmbeddedNavigation(target);
  await tick();
}

describe("DesktopApp extraPages", () => {
  it("adds one palette row per registered page", async () => {
    await mountShell(probePages);
    await openPalette();

    const row = host.querySelector<HTMLButtonElement>("#command-go-probe");
    expect(row).toBeTruthy();
    expect(row?.textContent).toContain("Probe");
    expect(row?.textContent).toContain("A host-registered destination");
  });

  it("mounts the registered component when its palette row is activated", async () => {
    await mountShell(probePages);
    await openPalette();

    expect(host.querySelector('[data-testid="extra-page-probe"]')).toBeNull();

    host.querySelector<HTMLButtonElement>("#command-go-probe")?.click();
    await tick();
    await tick();

    const page = host.querySelector('[data-testid="extra-page-probe"]');
    expect(page).toBeTruthy();
    // Full-bleed in the main column, and the palette closed behind it.
    expect(
      host.querySelector('[data-testid="extra-page-host"]')?.getAttribute("data-page"),
    ).toBe("probe");
    expect(host.querySelector('[data-testid="command-palette"]')).toBeNull();
    // No param came from the palette: the page gets its own empty state.
    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("none");
  });

  it("routes an embedded-navigation extra target and forwards its param", async () => {
    await mountShell(probePages);

    await navigateEmbedded({ kind: "extra", page: "probe", param: "abc" });

    expect(host.querySelector('[data-testid="extra-page-probe"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("abc");
    expect(
      host.querySelector('[data-testid="embedded-navigation-error"]'),
    ).toBeNull();
  });

  it("remounts the page when a later deep link changes only the param", async () => {
    await mountShell(probePages);

    await navigateEmbedded({ kind: "extra", page: "probe", param: "abc" });
    const first = host.querySelector('[data-testid="extra-page-probe"]');

    await navigateEmbedded({ kind: "extra", page: "probe", param: "xyz" });
    const second = host.querySelector('[data-testid="extra-page-probe"]');

    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("xyz");
  });

  it("lets the page select its own param through onnavigate", async () => {
    await mountShell(probePages);
    await navigateEmbedded({ kind: "extra", page: "probe", param: null });

    host
      .querySelector<HTMLButtonElement>('[data-testid="extra-page-probe-navigate"]')
      ?.click();
    await tick();
    await tick();

    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("chosen-by-page");
  });

  it("replaces the current extra destination so Back skips the previous param", async () => {
    await mountShell(probePages);
    await navigateEmbedded({ kind: "extra", page: "probe", param: "keep" });
    await navigateEmbedded({ kind: "extra", page: "probe", param: "draft" });

    host
      .querySelector<HTMLButtonElement>('[data-testid="extra-page-probe-replace"]')
      ?.click();
    await tick();
    await tick();

    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("replaced-by-page");

    host.querySelector<HTMLButtonElement>('[data-testid="titlebar-back"]')?.click();
    await tick();
    await tick();

    expect(
      host.querySelector('[data-testid="extra-page-probe-param"]')?.textContent,
    ).toBe("keep");
  });

  it("reports an unregistered page id instead of painting a blank column", async () => {
    await mountShell(probePages);

    await navigateEmbedded({ kind: "extra", page: "nope", param: null });

    const error = host.querySelector('[data-testid="embedded-navigation-error"]');
    expect(error).toBeTruthy();
    expect(error?.textContent).toContain("Unknown destination: nope");
    expect(host.querySelector('[data-testid="extra-page-host"]')).toBeNull();
    expect(host.querySelector('[data-testid="extra-page-probe"]')).toBeNull();
  });

  it("changes nothing when the host registers no extra pages", async () => {
    await mountShell();
    await openPalette();

    expect(host.querySelector("#command-go-probe")).toBeNull();
    // The shipped rows are untouched.
    expect(host.querySelector("#command-go-settings")).toBeTruthy();
    expect(host.querySelector("#command-go-library")).toBeTruthy();

    await navigateEmbedded({ kind: "extra", page: "probe", param: null });
    expect(host.querySelector('[data-testid="extra-page-host"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="embedded-navigation-error"]')?.textContent,
    ).toContain("Unknown destination: probe");
  });
});
