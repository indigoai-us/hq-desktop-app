// @vitest-environment happy-dom

// Owner feedback (2026-10-08): "the icon in each icon btn is not placed at the
// center". The leading-icon gap (rail-type.css) only applies when the icon has
// a label beside it; an icon alone in its button is marked data-solo.
import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import RailIcon from "./RailIcon.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

function iconIn(button: HTMLButtonElement): SVGSVGElement {
  document.body.appendChild(button);
  component = mount(RailIcon, { target: button, props: { name: "x" } });
  flushSync();
  return button.querySelector("svg.rail-icon") as SVGSVGElement;
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("RailIcon in an icon-only button", () => {
  it("is marked solo when it is the button's only content", () => {
    expect(iconIn(document.createElement("button")).hasAttribute("data-solo")).toBe(true);
  });

  it("is not solo when a text label follows it", () => {
    const button = document.createElement("button");
    const svg = iconIn(button);
    button.append(" Close");
    return settle().then(() => expect(svg.hasAttribute("data-solo")).toBe(false));
  });

  it("stays solo beside an absolutely positioned tooltip", () => {
    const button = document.createElement("button");
    const tip = document.createElement("span");
    tip.textContent = "Close";
    tip.style.position = "absolute";
    button.appendChild(tip);
    expect(iconIn(button).hasAttribute("data-solo")).toBe(true);
  });

  it("is marked gapped in a flex button that sets its own gap, so the gap isn't doubled", () => {
    const button = document.createElement("button");
    button.style.display = "inline-flex";
    button.style.columnGap = "6px";
    const svg = iconIn(button);
    expect(svg.hasAttribute("data-gapped")).toBe(true);
  });

  it("is not gapped in a plain button that relies on the shared margin", () => {
    const button = document.createElement("button");
    button.append("Refresh");
    expect(iconIn(button).hasAttribute("data-gapped")).toBe(false);
  });

  it("drops the leading gap for solo icons", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "rail-type.css"), "utf8");
    expect(css).toMatch(/svg\.rail-icon:first-child:not\(\[data-solo\]\):not\(\[data-gapped\]\) \{[^}]*margin-inline-end: 6px/u);
  });
});
