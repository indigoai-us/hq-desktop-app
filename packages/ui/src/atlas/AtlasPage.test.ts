// @vitest-environment happy-dom
/**
 * Atlas screenshot-state coverage (US-016 AC4).
 *
 * The sync desktop-alt visual suite is source-contract / happy-dom (no
 * Playwright toHaveScreenshot in this worktree). These mounts assert the three
 * required states under the same conditions as mission-control.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount, type Component } from "svelte";
import AtlasPage from "./AtlasPage.svelte";
import {
  ATLAS_EMPTY_LIVE,
  ATLAS_MIXED_LIVE,
  ATLAS_ONE_ACTOR_LIVE,
} from "./atlas-model.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(here, "AtlasPage.svelte"), "utf8");

describe("AtlasPage screenshot states", () => {
  const roots: Array<ReturnType<typeof mount>> = [];

  afterEach(() => {
    while (roots.length) {
      const app = roots.pop();
      if (app) unmount(app);
    }
    document.body.innerHTML = "";
  });

  function render(props: Record<string, unknown>) {
    const target = document.createElement("div");
    document.body.appendChild(target);
    const app = mount(AtlasPage as unknown as Component, {
      target,
      props: {
        companyUid: "cmp_indigo",
        companyLabel: "Indigo",
        featureEnabled: true,
        headerVariant: "embedded",
        ...props,
      },
    });
    roots.push(app);
    flushSync();
    return target;
  }

  it("empty company state", () => {
    const root = render({ live: ATLAS_EMPTY_LIVE });
    expect(root.querySelector('[data-testid="atlas-empty"]')).toBeTruthy();
    expect(root.querySelector('[data-testid="atlas-body"]')).toBeNull();
    expect(root.textContent).toContain("No one is online");
  });

  it("one live actor state", () => {
    const root = render({ live: ATLAS_ONE_ACTOR_LIVE });
    expect(root.querySelector('[data-testid="atlas-empty"]')).toBeNull();
    const actors = root.querySelectorAll('[data-testid="atlas-actor"]');
    expect(actors).toHaveLength(1);
    expect(actors[0]?.getAttribute("data-actor-uid")).toBe("prs_corey");
    expect(root.querySelector('[data-testid="atlas-task"]')?.textContent).toBe(
      "US-016",
    );
    expect(
      root.querySelector('[data-testid="atlas-harness"]')?.textContent,
    ).toBe("claude-code");
  });

  it("mixed humans and agents across projects", () => {
    const root = render({ live: ATLAS_MIXED_LIVE });
    const projects = [
      ...root.querySelectorAll('[data-testid="atlas-project"]'),
    ].map((el) => el.getAttribute("data-project-id"));
    expect(projects.sort()).toEqual(["hq-desktop", "work-mesh-live"]);
    const types = [
      ...root.querySelectorAll('[data-testid="atlas-actor"]'),
    ].map((el) => el.getAttribute("data-actor-type"));
    expect(types).toContain("human");
    expect(types).toContain("agent");
    expect(root.querySelector('[data-testid="atlas-unassigned"]')).toBeTruthy();
    expect(
      root
        .querySelector('[data-testid="atlas-offline-count"]')
        ?.textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 person offline");
  });

  it("offers Move to another company when canMigrate is set", () => {
    const seen: string[] = [];
    const root = render({
      live: ATLAS_ONE_ACTOR_LIVE,
      canMigrate: true,
      migrateDestinations: [{ uid: "cmp_other", label: "Other" }],
      onmigratesession: (sessionId: string) => {
        seen.push(sessionId);
      },
    });
    const btn = root.querySelector<HTMLButtonElement>(
      '[data-testid="atlas-session-migrate"]',
    );
    expect(btn).toBeTruthy();
    btn!.click();
    flushSync();
    expect(seen).toEqual(["sess_corey_1"]);
  });

  it("hides Move when canMigrate is false", () => {
    const root = render({
      live: ATLAS_ONE_ACTOR_LIVE,
      canMigrate: false,
      migrateDestinations: [{ uid: "cmp_other", label: "Other" }],
      onmigratesession: () => {},
    });
    expect(root.querySelector('[data-testid="atlas-session-migrate"]')).toBeNull();
  });

  it("drops a stopped actor when presence store reports offline", () => {
    const presenceByActor = new Map([["prs_stefan", "offline" as const]]);
    const root = render({ live: ATLAS_MIXED_LIVE, presenceByActor });
    const onlineUids = [
      ...root.querySelectorAll('[data-testid="atlas-actor"][data-online="true"]'),
    ].map((el) => el.getAttribute("data-actor-uid"));
    expect(onlineUids).not.toContain("prs_stefan");
    const desktop = root.querySelector(
      '[data-testid="atlas-project"][data-project-id="hq-desktop"]',
    );
    expect(
      desktop?.querySelector('[data-testid="atlas-project-offline"]')
        ?.textContent,
    ).toMatch(/1 offline/);
  });

  it("uses Desktop V4 tokens and a 360px layout width (screenshot contract)", () => {
    expect(pageSource).toContain("max-width: 360px");
    expect(pageSource).toContain("var(--v4-text-1");
    expect(pageSource).toContain("var(--v4-hairline");
    expect(pageSource).toContain("var(--v4-ok");
    expect(pageSource).toContain("var(--v4-space-4");
    // No polling loop after open.
    expect(pageSource).not.toMatch(/setInterval\s*\(/);
  });
});
