// @vitest-environment happy-dom
/**
 * Owner feedback (2026-10-05): the resting Uninstall button is neutral, not
 * red, and every packs-page button carries a leading icon.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";
import InstalledPacksPanel from "./InstalledPacksPanel.svelte";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "InstalledPacksPanel.svelte"),
  "utf8",
);

function tagFor(marker: string): string {
  const at = src.indexOf(marker);
  expect(at, marker).toBeGreaterThan(-1);
  const start = src.lastIndexOf("<RailButton", at);
  const startRaw = src.lastIndexOf("<button", at);
  const from = Math.max(start, startRaw);
  const end = src.indexOf(from === start ? "</RailButton>" : "</button>", at);
  return src.slice(from, end);
}

describe("InstalledPacksPanel buttons", () => {
  it("resting Uninstall is neutral and carries a trash icon", () => {
    const tag = tagFor("onclick={() => (confirmUninstall = p.name)}");
    expect(tag).toMatch(/icon="trash"/u);
    expect(tag).toMatch(/variant="secondary"/u);
    expect(tag).not.toMatch(/danger|--v4-error|red/u);
  });

  it("destructive tone stays only inside the confirm step", () => {
    const tag = tagFor("onclick={() => uninstall(p.name)}");
    expect(tag).toMatch(/variant="danger"/u);
    expect(src.match(/variant="danger"/gu)).toHaveLength(1);
  });

  it("Get started Copy renders a copy icon and a check once copied", () => {
    const tag = tagFor('data-testid="installed-get-started-copy"');
    expect(tag).toMatch(/<RailIcon name=\{copiedPack === p\.name \? "check" : "copy"\}/u);
  });

  it("no plain text-only action buttons remain", () => {
    expect(src).not.toMatch(/class="action /u);
    for (const tag of src.match(/<RailButton\b[\s\S]*?>/gu) ?? []) {
      expect(tag).toMatch(/\bicon=/u);
    }
  });
});

describe("InstalledPacksPanel rendered buttons", () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host?.remove();
  });

  it("renders Uninstall without danger styling and icons on Uninstall, Copy and Refresh", async () => {
    const pack = {
      name: "demo-pack", transport: null, hqCoreSatisfied: true, contributes: {}, links: {},
      brokenLinks: [], inCatalog: true, updateAvailable: false, initialization: { entrypoint: "demo" },
    };
    const adapter = {
      kind: "desktop",
      isAvailable: () => true,
      packages: {
        listPackages: vi.fn(async () => ok({
          packs: { hqRoot: "/hq", hqVersion: "1.0.0", installed: [pack], available: [], warnings: [] },
          registry: null, error: null,
        })),
        checkUpdates: vi.fn(async () => ok(null)),
      },
    } as unknown as PlatformAdapter;
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(InstalledPacksPanel, { target: host, props: { adapter, packagesEvents: null } });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[aria-label="Uninstall demo-pack"]')).not.toBeNull();
    });
    const uninstall = host.querySelector('[aria-label="Uninstall demo-pack"]')!;
    expect(uninstall.className).not.toMatch(/danger/u);
    expect(uninstall.querySelector('svg[data-rail-icon="trash"][aria-hidden="true"]')).not.toBeNull();
    expect(uninstall.textContent?.trim()).toBe("Uninstall");
    const copy = host.querySelector('[data-testid="installed-get-started-copy"]')!;
    expect(copy.querySelector('svg[data-rail-icon="copy"]')).not.toBeNull();
    expect(copy.textContent?.trim()).toBe("Copy");
    const refresh = host.querySelector('[data-testid="installed-refresh"]')!;
    expect(refresh.querySelector('svg[data-rail-icon="refresh"]')).not.toBeNull();
  });
});
