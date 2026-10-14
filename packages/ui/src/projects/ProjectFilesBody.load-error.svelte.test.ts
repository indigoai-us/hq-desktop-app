// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectFilesBody from "./ProjectFilesBody.svelte";

// AUDIT-3-17: a failed folder read in Choose folder says so and offers Try
// again; it is not shown as a vault with no folders.
const ROOT = "companies/acme/projects/demo";

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe("ProjectFilesBody Choose folder failed read (AUDIT-3-17)", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows Try again instead of an empty folder list and loads on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const files = new Proxy({
      listDir: async () =>
        fail
          ? { ok: false, message: "HTTP 500 Internal Server Error" }
          : { ok: true, value: [{ name: "notes", path: `${ROOT}/notes`, isDir: true, hasChildren: false }] },
    } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : async () => ({ ok: true, value: [] })) });
    const adapter = new Proxy({}, { get: (_t, k) => (k === "files" ? files : k === "isAvailable" ? () => false : new Proxy({}, { get: () => async () => ({ ok: true, value: [] }) })) });
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(ProjectFilesBody, { target, props: { adapter: adapter as never, vaultRoot: ROOT } });
    await settle();
    (target.querySelector("[data-testid='new-file-open']") as HTMLButtonElement).click();
    await settle();
    [...target.querySelectorAll("button")].find((b) => b.textContent === "Change")!.click();
    await settle();
    expect(target.querySelector("[data-testid='folder-load-error']")?.textContent).toContain("Couldn't read the folders here.");
    expect(target.textContent).not.toContain("500");
    fail = false;
    (target.querySelector("[data-testid='folder-retry']") as HTMLButtonElement).click();
    await settle();
    expect(target.querySelector("[data-testid='folder-load-error']")).toBeNull();
    expect(target.querySelectorAll("[data-testid='folder-choice']")).toHaveLength(1);
  });
});
