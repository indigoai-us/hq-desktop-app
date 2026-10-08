// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LEGACY_TO_REGISTRY } from "../../../platform/src/flags.js";
import {
  INDIGO_ONLY_GATE_KEYS,
  RAIL_ATLAS_FLAG,
  isIndigoOnlySurface,
  watchIndigoOnlyGates,
  type IndigoOnlyGateKey,
} from "./indigo-only-gates.js";
import OutpostPage from "../outpost/OutpostPage.svelte";
import { clearOutpostCache, writeOutpostCache } from "../outpost/outpost-model.js";
import { fixtureOutpost } from "../outpost/outpost.fixture.js";

const INDIGO = { slug: "indigo", uid: "cmp_indigo" };
const OTHER = { slug: "acme", uid: "cmp_acme" };
const PERSONAL = null;

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("RELEASE-001 isIndigoOnlySurface", () => {
  const closedByDefault = INDIGO_ONLY_GATE_KEYS.filter((key) => key !== RAIL_ATLAS_FLAG);

  it.each(closedByDefault)("%s: Indigo sees it, another company and personal scope get the fallback", (key) => {
    expect(isIndigoOnlySurface(key, INDIGO)).toBe(true);
    expect(isIndigoOnlySurface(key, OTHER)).toBe(false);
    expect(isIndigoOnlySurface(key, PERSONAL)).toBe(false);
    expect(isIndigoOnlySurface(key, undefined)).toBe(false);
  });

  it.each(closedByDefault)("%s: keyed to the open company slug, not a lookalike", (key) => {
    expect(isIndigoOnlySurface(key, { slug: "indigo-prospects", uid: null })).toBe(false);
    expect(isIndigoOnlySurface(key, { slug: null, uid: "cmp_indigo" })).toBe(false);
    expect(isIndigoOnlySurface(key, { slug: " Indigo " })).toBe(true);
  });

  it.each(closedByDefault)("%s: a registry true opens it to everyone; false keeps it Indigo-only", (key) => {
    const on = { [key]: true } as Partial<Record<IndigoOnlyGateKey, boolean>>;
    const off = { [key]: false } as Partial<Record<IndigoOnlyGateKey, boolean>>;
    expect(isIndigoOnlySurface(key, OTHER, on)).toBe(true);
    expect(isIndigoOnlySurface(key, PERSONAL, on)).toBe(true);
    expect(isIndigoOnlySurface(key, OTHER, off)).toBe(false);
    expect(isIndigoOnlySurface(key, INDIGO, off)).toBe(true);
  });

  it("Atlas stays on for everyone by default and can be closed from the registry", () => {
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, INDIGO)).toBe(true);
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, OTHER)).toBe(true);
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, PERSONAL)).toBe(true);
    const off = { [RAIL_ATLAS_FLAG]: false };
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, INDIGO, off)).toBe(true);
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, OTHER, off)).toBe(false);
    expect(isIndigoOnlySurface(RAIL_ATLAS_FLAG, PERSONAL, off)).toBe(false);
  });

  it("every gate key is a registry row", () => {
    for (const key of INDIGO_ONLY_GATE_KEYS) expect(LEGACY_TO_REGISTRY[key]).toBe(key);
  });

  it("every gate key is listed in the console-rail design standard", () => {
    const doc = read("../../../../docs/design-standard-console-rail.md");
    const section = doc.slice(doc.indexOf("## Indigo-only gates"));
    expect(section.length).toBeGreaterThan(0);
    for (const key of INDIGO_ONLY_GATE_KEYS) expect(section).toContain(`\`${key}\``);
  });

  it("every gate key is read at a call site in the shell", () => {
    const shell = read("./DesktopApp.svelte");
    const names = ["RAIL_TELEMETRY_FLAG", "RAIL_OUTPOST_FLAG", "RAIL_DEPLOYMENTS_ACTIONS_FLAG", "RAIL_WORKFORCE_LIMITS_FLAG", "RAIL_ATLAS_FLAG"];
    expect(names).toHaveLength(INDIGO_ONLY_GATE_KEYS.length);
    for (const name of names) expect(shell).toContain(`railGate(${name})`);
  });
});

describe("RELEASE-001 watchIndigoOnlyGates", () => {
  it("keeps configured booleans and drops failed reads so the default applies", async () => {
    const seen: Array<Record<string, boolean>> = [];
    const stop = watchIndigoOnlyGates(
      {
        hasFeature: async (flag) =>
          flag === RAIL_ATLAS_FLAG ? { ok: false } : { ok: true, value: flag.includes("telemetry") },
      },
      (values) => seen.push(values),
    );
    await vi.waitFor(() => expect(seen).toHaveLength(INDIGO_ONLY_GATE_KEYS.length));
    const last = seen.at(-1)!;
    expect(last["desktop.rail-telemetry-v1"]).toBe(true);
    expect(last["desktop.rail-outpost-v1"]).toBe(false);
    expect(RAIL_ATLAS_FLAG in last).toBe(false);
    stop();
  });

  it("does nothing without an identity reader", () => {
    const onChange = vi.fn();
    watchIndigoOnlyGates(null, onChange)();
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("RELEASE-001 fallbacks are finished states", () => {
  let component: ReturnType<typeof mount> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  function mountOutpost(full: boolean): HTMLElement {
    clearOutpostCache("personal");
    writeOutpostCache("personal", fixtureOutpost());
    const target = document.createElement("div");
    document.body.appendChild(target);
    component = mount(OutpostPage, { target, props: { refresh: async () => fixtureOutpost(), full } });
    flushSync();
    return target;
  }

  it("Outpost fallback keeps the status card and hides jobs and runs", () => {
    const target = mountOutpost(false);
    // OWNER-R19: with Overview the only section, the sub-nav is dropped.
    expect(target.querySelectorAll("nav button")).toHaveLength(0);
    expect(target.querySelector("[data-testid='outpost-online']")).not.toBeNull();
    expect(target.querySelector("[data-testid='outpost-open-console']")).not.toBeNull();
    expect(target.querySelector("[data-testid='new-job']")).toBeNull();
    expect(target.querySelector("[data-testid='outpost-runs']")).toBeNull();
  });

  it("Outpost full version keeps the read-only Scheduled jobs and Runs for Indigo", () => {
    const target = mountOutpost(true);
    const tabs = [...target.querySelectorAll("nav button")].map((b) => b.textContent?.trim());
    expect(tabs).toEqual(["Overview", "Scheduled jobs", "Runs"]);
    expect(target.querySelector("[data-testid='outpost-runs']")).not.toBeNull();
    expect(target.querySelector("[data-testid='new-job']")).toBeNull();
  });

});
