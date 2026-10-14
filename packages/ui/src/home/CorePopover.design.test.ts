// @vitest-environment happy-dom
//
// Design contract for the Core popover layout (PR #772 port):
// - version rows stack: status right-aligned on the first line, actions on a
//   second line flush with the label, and the panel never scrolls sideways;
// - Packs starts collapsed as a plain menu row (no grey box) reading
//   "Packs · N installed", and version and NEW share one right-hand meta;
//   the console-rail beta's Browse packs / Open marketplace pair stays the
//   last group of the open box;
// - every row is 30px minimum, and Restore is the same primary text action
//   as Install (accent ink, at the button standard's 500 weight).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CorePopover from "./CorePopover.svelte";
import { CORE_POPOVER_FIXTURE_PACKS } from "./core-popover-model";
import { resetUpdateStore } from "../settings/update-store.svelte";

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "CorePopover.svelte"),
  "utf8",
);
const css = src.slice(src.indexOf("<style>"));

/** Body of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`rule not found: ${selector}`);
  return m[1];
}

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

function makeAdapter(overrides: { checkCoreState?: () => Promise<unknown> } = {}) {
  return {
    kind: "desktop",
    isAvailable: () => true,
    packages: {
      listPackagesCached: async () => ok(null),
      listPackages: async () => ok({ packs: { installed: [] } }),
    },
    updates: {
      getVersions: async () => ok({ core: "15.0.118" }),
      checkCoreState: overrides.checkCoreState ?? (async () => ok(null)),
      checkForUpdates: async () => ok(null),
      checkCliUpdate: async () => ok(null),
      installUpdate: async () => ok(undefined),
      getDownloadedUpdate: async () => ok(null),
    },
  } as never;
}

function mountPopover(adapter: unknown, extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CorePopover, {
    target: host,
    props: {
      adapter: adapter as never,
      appVersion: "0.10.407",
      onclose: vi.fn(),
      ...extra,
    },
  });
  flushSync();
  return host;
}

const q = <T extends Element = HTMLElement>(id: string) =>
  host.querySelector<T>(`[data-testid="${id}"]`);

describe("CorePopover design: Packs", () => {
  it("starts collapsed as a plain row labelled Packs with an 'N installed' count", () => {
    mountPopover(makeAdapter(), { useFixtures: true });
    const section = q("core-popover-packs")!;
    const toggle = q("core-popover-packs-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // No grey box around a closed Packs row.
    expect(section.classList.contains("open")).toBe(false);
    expect(q("core-popover-pack-list")).toBeNull();
    expect(q("core-popover-open-marketplace")).toBeNull();
    expect(toggle.querySelector(".core-packs-label")?.textContent?.trim()).toBe(
      "Packs",
    );
    expect(q("core-popover-packs-count")?.textContent?.trim()).toBe(
      `${CORE_POPOVER_FIXTURE_PACKS.length} installed`,
    );
    // The caret is a Phosphor icon, not a typed `›`.
    expect(toggle.querySelector('svg[data-rail-icon="caret-right"]')).not.toBeNull();
    expect(toggle.textContent).not.toContain("›");
  });

  it("opens into the boxed list with one right-hand meta and the pack actions last", () => {
    mountPopover(makeAdapter(), { useFixtures: true });
    q("core-popover-packs-toggle")!.click();
    flushSync();
    expect(q("core-popover-packs")!.classList.contains("open")).toBe(true);

    const withNew = CORE_POPOVER_FIXTURE_PACKS.findIndex((p) => p.isNew);
    const rows = host.querySelectorAll('[data-testid="core-popover-pack-row"]');
    if (withNew >= 0) {
      const meta = rows[withNew]!.querySelector(
        '[data-testid="core-popover-pack-meta"]',
      )!;
      // Version and NEW live in the same meta, version first.
      expect(meta.querySelector('[data-testid="core-popover-pack-new"]')).not.toBeNull();
      expect(meta.classList.contains("new")).toBe(true);
    }
    for (const row of rows) {
      const metas = row.querySelectorAll('[data-testid="core-popover-pack-meta"]');
      expect(metas.length).toBeLessThanOrEqual(1);
    }

    const market = q<HTMLButtonElement>("core-popover-open-marketplace")!;
    const browse = q<HTMLButtonElement>("core-popover-browse-packs")!;
    expect(market.querySelector("svg[data-rail-icon]")).not.toBeNull();
    // The pack actions are the last group of the open section.
    const actions = q("core-popover-packs")!.lastElementChild!;
    expect(actions.classList.contains("core-pack-actions")).toBe(true);
    expect(actions.contains(market)).toBe(true);
    expect(actions.contains(browse)).toBe(true);
  });

  it("only paints the grey box when open", () => {
    expect(rule(".core-packs")).not.toMatch(/background:/);
    expect(rule(".core-packs.open")).toMatch(
      /background:\s*var\(--v4-raised, var\(--raised\)\)/,
    );
  });
});

describe("CorePopover design: version rows", () => {
  it("stacks status on the first line and actions on a second line", async () => {
    mountPopover(makeAdapter());
    await vi.waitFor(() => {
      flushSync();
      expect(q("core-popover-core-check")).not.toBeNull();
    });
    for (const id of ["core-popover-core-row", "core-popover-app-row"]) {
      const row = q(id)!;
      expect(row.classList.contains("core-row-stacked")).toBe(true);
      const head = row.querySelector(".core-row-head")!;
      expect(head.querySelector(".core-row-label")).not.toBeNull();
      expect(head.querySelector(".core-pill")).not.toBeNull();
      // Actions never share the status line.
      expect(head.querySelector("button.core-text-btn")).toBeNull();
    }
    const coreActions = q("core-popover-core-row")!.querySelector(
      ".core-row-actions",
    )!;
    expect(coreActions.querySelector('[data-testid="core-popover-core-check"]')).not.toBeNull();

    expect(rule(".core-row-stacked")).toMatch(/flex-direction:\s*column/);
    expect(rule(".core-row-head")).toMatch(/justify-content:\s*space-between/);
  });

  it("drops the empty actions line when a row has nothing to do", () => {
    mountPopover(makeAdapter(), { useFixtures: true });
    for (const id of ["core-popover-core-row", "core-popover-app-row"]) {
      expect(q(id)!.querySelector(".core-row-actions")).toBeNull();
    }
  });

  it("never scrolls sideways and keeps every row at a 30px minimum", () => {
    const panel = rule(".core-popover");
    expect(panel).toMatch(/overflow-x:\s*hidden/);
    expect(panel).toMatch(/overflow-y:\s*auto/);
    expect(panel).not.toMatch(/overflow:\s*auto/);
    expect(rule(".core-row")).toMatch(/min-height:\s*30px/);
    expect(rule(".core-packs-toggle")).toMatch(/min-height:\s*30px/);
  });

  it("styles Restore like Install: a primary text action in accent ink", async () => {
    mountPopover(
      makeAdapter({
        checkCoreState: async () =>
          ok({
            localVersion: "15.0.118",
            versionBehind: true,
            driftReport: { count: 0 },
          }),
      }),
    );
    await vi.waitFor(() => {
      flushSync();
      expect(q("core-popover-core-restore")).not.toBeNull();
    });
    const restore = q("core-popover-core-restore")!;
    expect(restore.classList.contains("core-text-btn")).toBe(true);
    expect(restore.classList.contains("accent")).toBe(true);
    expect(restore.classList.contains("core-btn")).toBe(false);
    const accent = rule(".core-text-btn.accent");
    expect(accent).toMatch(/color:\s*var\(--ice-ink\)/);
    // Install and Restore share the rule; no heavier than the 500 standard.
    expect(accent).not.toMatch(/font-weight:\s*[6-9]00/);
  });
});
