// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import CommandPalette from "./CommandPalette.svelte";

let component: ReturnType<typeof mount> | null = null;
const originalUserAgent = navigator.userAgent;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: originalUserAgent,
  });
});

it("renders Ctrl+K for Windows visitors", () => {
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
  });
  const target = document.createElement("div");
  document.body.appendChild(target);
  component = mount(CommandPalette, {
    target,
    props: { commands: [], onclose: () => {} },
  });
  flushSync();
  expect(target.querySelector(".command-glyph")?.textContent).toBe("Ctrl+K");
});
