// @vitest-environment happy-dom
//
// PACKS list must show human display names (not raw slugs like
// `hq-pack-client-service`) while keeping the slug discoverable via title.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import { CORE_POPOVER_FIXTURE_PACKS } from "./core-popover-model";
import { packDisplayName } from "./pack-display-name";
import { resetUpdateStore } from "../settings/update-store.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  resetUpdateStore();
});

type Result = { ok: true; value: unknown };
const ok = (value: unknown): Result => ({ ok: true, value });

function makeAdapter(overrides: {
  listPackagesCached?: () => Promise<unknown>;
  listPackages?: () => Promise<unknown>;
} = {}) {
  return {
    kind: "desktop",
    isAvailable: () => true,
    packages: {
      listPackagesCached:
        overrides.listPackagesCached ?? (async () => ok(null)),
      listPackages:
        overrides.listPackages ??
        (async () => ok({ packs: { installed: [] } })),
    },
    updates: {
      getVersions: async () => ok({ core: "15.0.118" }),
      checkCoreState: async () => ok(null),
      checkForUpdates: async () => ok(null),
      checkCliUpdate: async () => ok(null),
      installUpdate: async () => ok(undefined),
    },
  } as never;
}

function mountPopover(
  adapter: unknown,
  extra: Record<string, unknown> = {},
): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CorePopover, {
    target: host,
    props: {
      adapter: adapter as never,
      appVersion: "0.10.170",
      onclose: vi.fn(),
      ...extra,
    },
  });
  flushSync();
  return host;
}

function packRows(): HTMLElement[] {
  return [
    ...host.querySelectorAll<HTMLElement>(
      '[data-testid="core-popover-pack-row"]',
    ),
  ];
}

describe("CorePopover PACKS display names", () => {
  it("renders fixture packs as human names with the slug in title", () => {
    mountPopover(makeAdapter(), { useFixtures: true });
    const rows = packRows();
    expect(rows).toHaveLength(CORE_POPOVER_FIXTURE_PACKS.length);
    for (const [i, pack] of CORE_POPOVER_FIXTURE_PACKS.entries()) {
      const nameEl = rows[i]!.querySelector(".core-pack-name");
      expect(nameEl?.textContent).toBe(packDisplayName(pack));
      expect(nameEl?.getAttribute("title")).toBe(pack.name);
      expect(nameEl?.textContent).not.toBe("");
      if (pack.version) {
        expect(rows[i]!.textContent).toContain(`v${pack.version}`);
      }
    }
    expect(rows[0]!.querySelector(".core-pack-name")?.textContent).toBe(
      "Engineering",
    );
    expect(rows[1]!.querySelector(".core-pack-name")?.textContent).toBe(
      "Impeccable Design",
    );
    expect(rows[2]!.querySelector(".core-pack-name")?.textContent).toBe(
      "gStack",
    );
    expect(rows[3]!.querySelector(".core-pack-name")?.textContent).toBe(
      "Matt Pocock Skills",
    );
  });

  it("renders cached-shape slugs as human names and keeps the slug on title", async () => {
    const installed = [
      { name: "hq-pack-client-service", version: "1.4.0" },
      { name: "hq-pack-crm", version: "0.3.0" },
      { name: "gstack", version: "2.1.0" },
    ];
    mountPopover(
      makeAdapter({
        listPackagesCached: async () => ok({ packs: { installed } }),
        listPackages: async () => ok({ packs: { installed } }),
      }),
    );
    await vi.waitFor(() => {
      flushSync();
      expect(packRows()).toHaveLength(3);
    });
    const rows = packRows();
    const expected = [
      ["Client Service", "hq-pack-client-service", "v1.4.0"],
      ["CRM", "hq-pack-crm", "v0.3.0"],
      ["gStack", "gstack", "v2.1.0"],
    ] as const;
    for (const [i, [label, slug, version]] of expected.entries()) {
      const nameEl = rows[i]!.querySelector(".core-pack-name");
      expect(nameEl?.textContent).toBe(label);
      expect(nameEl?.getAttribute("title")).toBe(slug);
      expect(nameEl?.textContent).not.toBe("");
      expect(rows[i]!.textContent).toContain(version);
    }
  });
});
