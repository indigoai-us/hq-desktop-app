// @vitest-environment happy-dom

/**
 * OWNER-R26: the shared ReadLoader (animated dots and rotating messages) is
 * the one loading state. No pane draws skeleton rows, shimmer blocks or grey
 * placeholder rows while it reads.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import GoalsRailHost from "../shell/GoalsRailHost.svelte";
import DeploymentsRailHost from "../shell/DeploymentsRailHost.svelte";

// The rail hosts load their views with lazy imports. Under full-suite load an
// import could resolve after this file's environment was torn down
// (EnvironmentTeardownError). Load the views up front so the hosts' imports
// resolve from the module cache while the tests run.
beforeAll(async () => {
  await import("../goals/GoalsView.svelte");
  await import("../library/PersonalDeploymentsPage.svelte");
});

const ROOT = join(__dirname, "..", "..", "..", "..");
const SOURCES = [join(ROOT, "packages/ui/src"), join(ROOT, "apps/sync/src")];

// Uses of the words that are not a visual placeholder.
const ALLOWED: Record<string, RegExp> = {
  // The toast's indeterminate progress bar.
  "packages/ui/src/shell/ToastStack.svelte": /ts-shimmer/,
  // A text line ("Connecting to the notetaker…"), not a grey block.
  "packages/ui/src/meetings/LiveTranscriptDoor.svelte": /live-transcript-skeleton/,
};

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === "node_modules") continue;
    if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
    else if (name.endsWith(".svelte")) out.push(path);
  }
  return out;
}

const PLACEHOLDER = [
  /(?:class|data-testid)=["{][^"}]*(?:skeleton|shimmer|\bskel\b|skel-|\bsk-row)/i,
  /class:(?:skeleton|shimmer)\b/i,
  /^\s*[^@{}]*\.[\w-]*(?:skeleton|shimmer|skel\b|skel-|\bsk-row)[\w-]*[^{}]*\{/im,
  /@keyframes\s+[\w-]*(?:skeleton|shimmer|skel)/i,
  /ChannelSkeleton/,
];

describe("no skeleton loading states (OWNER-R26)", () => {
  it("no component source draws skeleton, shimmer or placeholder rows", () => {
    const offenders: string[] = [];
    for (const file of SOURCES.flatMap(svelteFiles)) {
      const rel = relative(ROOT, file);
      const allowed = ALLOWED[rel];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (allowed?.test(line)) continue;
        if (PLACEHOLDER.some((re) => re.test(line))) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("the ChannelSkeleton component is gone", () => {
    expect(existsSync(join(ROOT, "packages/ui/src/shell/ChannelSkeleton.svelte"))).toBe(false);
  });

  describe("rendered loading states", () => {
    let host: HTMLDivElement | null = null;
    let component: ReturnType<typeof mount> | null = null;
    afterEach(async () => {
      if (component) await unmount(component);
      component = null;
      host?.remove();
      host = null;
    });

    const PLACEHOLDER_SELECTOR =
      "[class*='skeleton'],[class*='shimmer'],[class*='skel'],[data-testid*='skeleton'],[data-testid*='shimmer']";

    for (const [name, Pane, props] of [
      ["Goals", GoalsRailHost, { adapter: {} as PlatformAdapter, slug: "acme" }],
      ["Deployments", DeploymentsRailHost, { adapter: {} as PlatformAdapter }],
    ] as const) {
      it(`${name} shows the loader and no placeholder rows while it loads`, () => {
        host = document.createElement("div");
        document.body.append(host);
        component = mount(Pane as never, { target: host, props: props as never });
        flushSync();
        expect(host.querySelector("[role='status']"), `${name} loader`).toBeTruthy();
        expect(host.querySelectorAll(PLACEHOLDER_SELECTOR).length).toBe(0);
      });
    }
  });
});
