// @vitest-environment happy-dom
/**
 * OWNER-007 / OWNER-008 guard: every labelled console-rail button carries an
 * icon and uses the shared pill proportions; summary lines use the meta-line
 * style.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, unmount, createRawSnippet } from "svelte";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import RailButton from "./RailButton.svelte";
import RailIcon from "./RailIcon.svelte";
import ListEmptyState from "../ListEmptyState.svelte";
import { BRAND_ICONS, LINE_ICONS, iconForLabel } from "./rail-icons";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(resolve(SRC, rel), "utf8");

/** Console-rail surfaces: page-header actions, sheet footers, empty states, settings actions. */
export const CONSOLE_RAIL_FILES = [
  "activity/ActivityView.svelte",
  "telemetry/TelemetryView.svelte",
  "goals/GoalsView.svelte",
  "goals/NewGoalSheet.svelte",
  "projects/NewProjectSheet.svelte",
  "projects/TaskViewPane.svelte",
  "projects/ProjectDetailView.svelte",
  "atlas/AtlasInspector.svelte",
  "atlas/AtlasView.svelte",
  "atlas/AtlasMap.svelte",
  "library/PersonalDeploymentsPage.svelte",
  "library/PersonalLibraryPage.svelte",
  "company/TeamPage.svelte",
  "company/BotsPage.svelte",
  "company/CompanySettingsPage.svelte",
  "company/brain/BrainPage.svelte",
  "company/files-connect/FilesConnectPage.svelte",
  "company/files-connect/DeployAccessForm.svelte",
  "outpost/OutpostPage.svelte",
  "personal/PersonalRailPage.svelte",
  "common/LiveNowCard.svelte",
  "common/ListEmptyState.svelte",
  "home/V4TitleBar.svelte",
];

const mounted: Array<ReturnType<typeof mount>> = [];
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = "";
});

function label(text: string) {
  return createRawSnippet(() => ({ render: () => `<span>${text}</span>` }));
}

describe("labelled console-rail buttons carry an icon", () => {
  it.each(CONSOLE_RAIL_FILES)("%s has no ad-hoc text-only .btn buttons", (rel) => {
    const src = read(rel);
    const adHoc = src.match(/<button\b[^>]*\bclass=["'{][^"'}]*(?<![\w-])btn(?![\w-])[^>]*>/gu) ?? [];
    expect(adHoc, `ad-hoc .btn buttons in ${rel} must use RailButton`).toEqual([]);
  });

  it.each(CONSOLE_RAIL_FILES)("%s gives every RailButton an icon", (rel) => {
    const src = read(rel);
    for (const tag of src.match(/<RailButton\b[\s\S]*?>/gu) ?? []) {
      expect(tag, `RailButton without icon in ${rel}`).toMatch(/\bicon=/u);
    }
  });

  it.each(CONSOLE_RAIL_FILES)("%s renders an icon inside every raw data-rail-btn button", (rel) => {
    const src = read(rel);
    const raw = src.match(/<button\b[^>]*\bdata-rail-btn\b[\s\S]*?<\/button>/gu) ?? [];
    for (const button of raw) {
      expect(button, `raw labelled button without icon in ${rel}`).toMatch(/<(RailIcon|svg|CompanyIcon|img)\b/u);
    }
  });

  it("maps the owner's named actions to an icon from the registry", () => {
    const names = [
      "Export", "New policy", "New worker", "New project", "New objective", "New channel",
      "New bot", "New file", "Add integration", "Vault", "Check again", "Change…", "Cancel",
      "Create project", "Clear search", "Clear filters", "Save", "Open in Claude Code",
      "Open in Codex", "Grok Build",
    ];
    for (const name of names) {
      const icon = iconForLabel(name);
      expect(icon, name).not.toBeNull();
      expect(icon! in LINE_ICONS || icon! in BRAND_ICONS, name).toBe(true);
    }
    expect(iconForLabel("Open in Claude Code")).toBe("claude-code");
    expect(iconForLabel("Open in Codex")).toBe("codex");
    expect(iconForLabel("Grok Build")).toBe("grok");
  });

  it("renders the empty-state Clear search action with an icon", () => {
    mounted.push(mount(ListEmptyState, { target: document.body, props: { query: "zz", total: 3, shown: 0, noun: ["item", "items"], onclear: () => {} } }));
    const clear = document.querySelector('[data-testid="list-empty-state-clear"]')!;
    expect(clear).not.toBeNull();
    {
      expect(clear.hasAttribute("data-rail-btn")).toBe(true);
      expect(clear.querySelector("svg[data-rail-icon]")).not.toBeNull();
      expect(clear.textContent?.trim()).toMatch(/Clear (search|filters)/u);
    }
  });
});

describe("RailButton size contract (titlebar pill standard)", () => {
  // Height, padding, gap, radius and type come from button-standard.css and are
  // asserted against the titlebar pill in button-height.guard.test.ts.
  it("reads the one button standard and keeps a 14px filled Phosphor icon, 500 label", () => {
    mounted.push(mount(RailButton, { target: document.body, props: { icon: "download", children: label("Export") } }));
    const button = document.querySelector<HTMLButtonElement>("[data-rail-btn]")!;
    expect(button).not.toBeNull();
    expect(getComputedStyle(button).fontWeight).toBe("500");
    const css = read("common/button/RailButton.svelte");
    expect(css).toMatch(/height: var\(--hq-btn-h\);/u);
    expect(css).toMatch(/padding: 0 var\(--hq-btn-pad-inline\);/u);
    expect(css).toMatch(/gap: var\(--hq-btn-gap\);/u);
    expect(css).toMatch(/border-radius: var\(--hq-btn-radius\);/u);
    expect(css).toMatch(/font-size: var\(--hq-btn-font-size\);/u);
    const svg = button.querySelector("svg[data-rail-icon='download']")!;
    expect(svg.getAttribute("width")).toBe("14");
    expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
    const path = svg.querySelector("path")!;
    expect(path.getAttribute("fill")).toBe("currentColor");
    expect(path.hasAttribute("stroke")).toBe(false);
    expect(path.hasAttribute("stroke-width")).toBe(false);
    expect(button.textContent?.trim()).toBe("Export");
  });

  it("primary has no size of its own", () => {
    mounted.push(mount(RailButton, { target: document.body, props: { icon: "plus", variant: "primary", children: label("New policy") } }));
    expect(document.querySelector("[data-rail-btn]")!.classList.contains("primary")).toBe(true);
    expect(read("common/button/RailButton.svelte")).not.toMatch(/\.rail-btn\.primary \{[^}]*(height|padding)/u);
  });
});

describe("meta line and info pill (OWNER-008)", () => {
  const css = read("common/button/rail-type.css");
  const block = (sel: string) => css.match(new RegExp(`\\${sel} \\{([^}]*)\\}`, "u"))?.[1] ?? "";

  it("meta line is 11px/400, 14px line-height, --t3, 6px dot", () => {
    const meta = block(".meta-line");
    expect(meta).toMatch(/font-size: 11px/u);
    expect(meta).toMatch(/font-weight: 400/u);
    expect(meta).toMatch(/line-height: 14px/u);
    expect(meta).toMatch(/var\(--t3/u);
    expect(css).toMatch(/\.meta-dot \{[^}]*width: 6px[^}]*height: 6px/u);
  });

  it("info pill is fully rounded at the 11px meta size", () => {
    const pill = block(".info-pill");
    expect(pill).toMatch(/border-radius: 999px/u);
    expect(pill).toMatch(/font-size: 11px/u);
  });
});

/**
 * Line icons are Phosphor Icons, regular weight (MIT), copied from
 * @phosphor-icons/core assets/regular: filled outline glyphs in a 256 grid.
 */
describe("Phosphor regular line icons", () => {
  const names = Object.keys(LINE_ICONS) as Array<keyof typeof LINE_ICONS>;

  it("every line icon is a non-empty Phosphor path on the 256 grid", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const d = LINE_ICONS[name];
      // Absolute move into the 256 grid, closed outline (Phosphor regular paths
      // are filled shapes, so every one ends with Z).
      expect(d, name).toMatch(/^M[\d.,\sa-zA-Z-]+Z$/u);
      const coords = (d.match(/-?\d+(?:\.\d+)?/gu) ?? []).map(Number);
      expect(Math.max(...coords), name).toBeGreaterThan(16);
      expect(Math.max(...coords), name).toBeLessThanOrEqual(256);
    }
    // Spot-pin known Phosphor sources so a swap back to hand-drawn paths fails.
    expect(LINE_ICONS.plus).toBe(
      "M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z",
    );
    expect(LINE_ICONS.check).toBe(
      "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z",
    );
    expect(LINE_ICONS.save).toBe(LINE_ICONS.check);
  });

  it("renders every line icon as a filled currentColor path in a 0 0 256 256 viewBox", () => {
    for (const name of names) {
      const target = document.createElement("div");
      document.body.appendChild(target);
      mounted.push(mount(RailIcon, { target, props: { name } }));
      const svg = target.querySelector(`svg.rail-icon[data-rail-icon="${name}"]`)!;
      expect(svg, name).not.toBeNull();
      expect(svg.getAttribute("width")).toBe("14");
      expect(svg.getAttribute("height")).toBe("14");
      expect(svg.getAttribute("viewBox")).toBe("0 0 256 256");
      expect(svg.getAttribute("aria-hidden")).toBe("true");
      const paths = svg.querySelectorAll("path");
      expect(paths.length, name).toBe(1);
      expect(paths[0].getAttribute("d")).toBe(LINE_ICONS[name]);
      expect(paths[0].getAttribute("fill")).toBe("currentColor");
      expect(paths[0].hasAttribute("stroke")).toBe(false);
    }
  });

  it("keeps the MIT notice next to the registry", () => {
    const src = read("common/button/rail-icons.ts");
    expect(src).toMatch(/Phosphor Icons/u);
    expect(src).toMatch(/MIT License/u);
    expect(src).toMatch(/Copyright \(c\) 2023 Phosphor Icons/u);
  });
});

describe("official brand marks (OWNER-013)", () => {
  it("resolves the three launch names to the registered marks", () => {
    expect(iconForLabel("Open in Claude Code")).toBe("claude-code");
    expect(iconForLabel("Open in Codex")).toBe("codex");
    expect(iconForLabel("Grok Build")).toBe("grok");
    // Claude Spark and OpenAI Blossom are the vendors' published single paths.
    expect(BRAND_ICONS["claude-code"]).toMatchObject({ viewBox: "0 0 94 94", fill: "clay" });
    expect(BRAND_ICONS["claude-code"].d.startsWith("M18.7657 62.4437L37.1822 52.1167")).toBe(true);
    expect(BRAND_ICONS.codex).toMatchObject({ viewBox: "176 176 364 364", fill: "mono" });
    expect(BRAND_ICONS.codex.d.startsWith("M508.749 317.399C516.777 287.314")).toBe(true);
    expect(BRAND_ICONS.grok).toMatchObject({ viewBox: "0 0 16 16", fill: "current" });
  });

  it("renders each mark at 14px with its own viewBox and colour treatment", () => {
    for (const name of ["claude-code", "codex", "grok"] as const) {
      const target = document.createElement("div");
      document.body.appendChild(target);
      mounted.push(mount(RailIcon, { target, props: { name } }));
      const svg = target.querySelector(`svg[data-rail-icon="${name}"]`)!;
      expect(svg.getAttribute("width")).toBe("14");
      expect(svg.getAttribute("viewBox")).toBe(BRAND_ICONS[name].viewBox);
      expect(svg.querySelector("path")!.getAttribute("class")).toContain(`brand-${BRAND_ICONS[name].fill}`);
    }
  });

  it("Launch menu avatars use the brand marks, not letter badges", () => {
    const bar = read("home/V4TitleBar.svelte");
    expect(bar).toMatch(/mark: "claude-code"/u);
    expect(bar).toMatch(/mark: "codex"/u);
    expect(bar).toMatch(/mark: "grok"/u);
    expect(bar).not.toMatch(/mark: "(CC|CX|GB)"/u);
    expect(bar).toMatch(/<RailIcon name=\{item\.mark\} \/>/u);
  });
});
