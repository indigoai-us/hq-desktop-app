// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ProjectFilesBody from "./ProjectFilesBody.svelte";

// Every adapter call resolves to an empty ok result; this test only needs the
// New file sheet to open and close.
function emptyApi(): unknown {
  return new Proxy(
    {},
    { get: () => async () => ({ ok: true, value: [] }) },
  );
}
const adapter = new Proxy({}, { get: () => emptyApi() });

describe("ProjectFilesBody New file sheet (QA-008)", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  it("closes on Escape", async () => {
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(ProjectFilesBody, {
      target,
      props: { adapter: adapter as never, vaultRoot: "/hq/companies/indigo/projects/demo" },
    });
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    (target.querySelector("[data-testid='new-file-open']") as HTMLButtonElement).click();
    flushSync();
    expect(target.querySelector("[data-testid='sheet-new-file']")).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    flushSync();
    expect(target.querySelector("[data-testid='sheet-new-file']")).toBeNull();
  });
});
