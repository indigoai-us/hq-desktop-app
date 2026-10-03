// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import ShellSettings from "./ShellSettings.svelte";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const tokensCss = readFileSync(here("../chat/chat-tokens.css"), "utf8");
const settingsSource = readFileSync(here("./ShellSettings.svelte"), "utf8");
const setupCardSource = readFileSync(here("./SetupIncompleteCard.svelte"), "utf8");

let shell: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  shell?.remove();
  document.documentElement.removeAttribute("data-force-theme");
});

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("}", start));
}

// QA-103: Settings mounted in Light kept light nav text after switching to Dark.
describe("ShellSettings live theme switch", () => {
  // happy-dom does not re-resolve root attribute selectors after the first
  // style read, so the cascade itself is not observable here. The live-token
  // contract is: no captured inline colour on the labels, and the rule reads
  // var(--t2) with no colour transition (asserted below).
  it("nav labels carry no captured colour across a live theme switch", async () => {
    document.documentElement.setAttribute("data-force-theme", "light");
    shell = document.createElement("div");
    shell.className = "chat-shell";
    document.body.appendChild(shell);
    component = mount(ShellSettings, { target: shell, props: {} });
    await tick();

    document.documentElement.setAttribute("data-force-theme", "dark");
    await tick();

    const items = shell.querySelectorAll<HTMLElement>(".ss-nav-item");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.style.color).toBe("");
      expect(item.closest(".chat-shell")).toBe(shell);
    }
    expect(cssRule(settingsSource, ".ss-nav-item")).toMatch(/\bcolor: var\(--t2\);/);
    expect(tokensCss).toMatch(
      /:root\[data-force-theme="dark"\] \.chat-shell \{[^}]*--t2: rgba\(255, 255, 255, 0\.56\);/,
    );
  });

  it("nav items and setup buttons never transition their text color", () => {
    for (const rule of [
      cssRule(settingsSource, ".ss-nav-item"),
      cssRule(setupCardSource, ".setup-btn"),
    ]) {
      const transition = rule.slice(rule.indexOf("transition:"));
      expect(transition).not.toMatch(/(^|[\s,:])color\s/);
      expect(rule).toMatch(/color: var\(--/);
    }
  });
});
