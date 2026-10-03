// @vitest-environment happy-dom
/**
 * Contrast compensation for the Files sidebar.
 *
 * The perf pass removed this panel's backdrop-filter (the native glass view
 * behind the transparent window already blurs). The wash layered on
 * --v4-sidebar pays for the lost contrast. happy-dom does not compute scoped
 * styles, so these assertions read the stylesheet the mounted panel injects.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";
import type { FilesApi } from "@hq/platform";

import FilesModeSidebar from "./FilesModeSidebar.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

async function injected(): Promise<string> {
  host = document.createElement("div");
  document.body.appendChild(host);
  const files = {
    listDir: async () => ({ ok: false as const, error: { code: "unavailable", message: "stub" } }),
  } as unknown as FilesApi;
  component = mount(FilesModeSidebar, {
    target: host,
    props: {
      files,
      companies: [],
      activeSlug: null,
      selectedPath: null,
      accessReady: false,
    },
  });
  await tick();
  expect(host.querySelector(".files-sidebar")).not.toBeNull();
  return [...document.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .filter((css) => css.includes("files-sidebar"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function mainRule(css: string): string {
  const match = css.match(/\.files-sidebar\.svelte-[\w-]+\s*\{([^}]*)\}/);
  expect(match, "mounted Files sidebar has no panel rule").not.toBeNull();
  return match![1];
}

describe("FilesModeSidebar background", () => {
  it("still has no backdrop-filter on the panel itself", async () => {
    const panel = mainRule(await injected());
    expect(panel).not.toMatch(/(-webkit-)?backdrop-filter:\s*(?!none)/);
  });

  it("layers a wash over --v4-sidebar so the lost blur is paid for", async () => {
    const panel = mainRule(await injected());
    expect(panel).toMatch(
      /background:\s*linear-gradient\(\s*var\(--fs-panel-wash\),\s*var\(--fs-panel-wash\)\s*\),\s*var\(--v4-sidebar/,
    );
  });

  it("defines the wash for light and dark, at the chat rail's magnitude", async () => {
    const css = await injected();
    const alphas = [...css.matchAll(/--fs-panel-wash:\s*rgb\([^)]*\/\s*([\d.]+)\)/g)].map(
      (match) => Number(match[1]),
    );
    expect(alphas.length).toBeGreaterThanOrEqual(3);
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0.08);
      expect(alpha).toBeLessThanOrEqual(0.14);
    }
    expect(css).toMatch(/prefers-color-scheme:\s*dark[\s\S]*?--fs-panel-wash/);
    expect(css).toMatch(/data-force-theme="light"[\s\S]*?--fs-panel-wash/);
    expect(css).toMatch(/data-force-theme="dark"[\s\S]*?--fs-panel-wash/);
  });
});
