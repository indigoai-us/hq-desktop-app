// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { titleWhenTruncated } from "./truncation-title";

function labelNode(
  text: string,
  { scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number },
) {
  const node = document.createElement("span");
  node.textContent = text;
  Object.defineProperty(node, "scrollWidth", {
    configurable: true,
    value: scrollWidth,
  });
  Object.defineProperty(node, "clientWidth", {
    configurable: true,
    value: clientWidth,
  });
  return node;
}

describe("titleWhenTruncated", () => {
  it("sets no title when the text fits", () => {
    const node = labelNode("Indigo", { scrollWidth: 40, clientWidth: 40 });
    titleWhenTruncated(node, "Indigo");
    expect(node.hasAttribute("title")).toBe(false);
  });

  it("sets the full value as the title when the text is clipped", () => {
    const node = labelNode("jacob@getindigo.ai", {
      scrollWidth: 240,
      clientWidth: 90,
    });
    titleWhenTruncated(node, "jacob@getindigo.ai");
    expect(node.getAttribute("title")).toBe("jacob@getindigo.ai");
  });

  it("falls back to the element's own text when no value is passed", () => {
    const node = labelNode("a-very-long-channel-name", {
      scrollWidth: 300,
      clientWidth: 80,
    });
    titleWhenTruncated(node);
    expect(node.getAttribute("title")).toBe("a-very-long-channel-name");
  });

  it("re-measures on hover, so a resized rail drops a stale tooltip", () => {
    const node = labelNode("Indigo", { scrollWidth: 160, clientWidth: 40 });
    titleWhenTruncated(node, "Indigo");
    expect(node.getAttribute("title")).toBe("Indigo");

    Object.defineProperty(node, "scrollWidth", {
      configurable: true,
      value: 40,
    });
    node.dispatchEvent(new Event("mouseenter"));
    expect(node.hasAttribute("title")).toBe(false);
  });

  it("removes its listeners on destroy", () => {
    const node = labelNode("Indigo", { scrollWidth: 40, clientWidth: 40 });
    const action = titleWhenTruncated(node, "Indigo");
    action.destroy();
    Object.defineProperty(node, "scrollWidth", {
      configurable: true,
      value: 300,
    });
    node.dispatchEvent(new Event("mouseenter"));
    expect(node.hasAttribute("title")).toBe(false);
  });
});
