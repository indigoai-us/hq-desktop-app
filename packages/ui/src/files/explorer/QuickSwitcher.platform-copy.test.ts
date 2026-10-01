// @vitest-environment happy-dom

import { afterEach, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import QuickSwitcher from "./QuickSwitcher.svelte";

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;
const originalUserAgent = navigator.userAgent;

afterEach(async () => {
  Object.defineProperty(navigator, "userAgent", { value: originalUserAgent, configurable: true });
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

it("renders Windows shortcut labels in the file switcher", async () => {
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", configurable: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(QuickSwitcher, {
    target: host,
    props: {
      vault: { id: "personal", kind: "personal", label: "Personal", root: "", slug: null },
      search: async () => [],
      onopen: () => {},
      onclose: () => {},
    },
  });
  flushSync();
  await tick();
  expect(host.textContent).toContain("Ctrl+O");
  expect(host.textContent).toContain("Ctrl+↩ new tab");
});
