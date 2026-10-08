// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProjectFilesBody from "./ProjectFilesBody.svelte";
import { NEW_FILE_LOCAL_NOTICE } from "./project-files.js";

const ROOT = "companies/indigo/projects/demo";

// Unlisted adapter calls resolve to an empty ok result.
function api(overrides: Record<string, unknown>): unknown {
  return new Proxy(overrides, {
    get: (target, key) => (key in target ? target[key as string] : async () => ({ ok: true, value: [] })),
  });
}

function makeAdapter(cloudSync: boolean) {
  const written = new Map<string, string>();
  const createFile = vi.fn(async (path: string, contents: string) => {
    written.set(path, contents);
    return { ok: true, value: { path, cloudSync } };
  });
  const files = api({
    createFile,
    getFileContent: async (path: string) =>
      written.has(path) ? { ok: true, value: written.get(path) } : { ok: false, message: "not found" },
  });
  const adapter = new Proxy({}, {
    get: (_t, key) => (key === "files" ? files : key === "isAvailable" ? () => false : api({})),
  });
  return { adapter, createFile, written };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  flushSync();
}

describe("ProjectFilesBody New file Create (QA-072)", () => {
  let component: Record<string, unknown> | null = null;
  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    document.body.innerHTML = "";
  });

  async function openForm(adapter: unknown): Promise<HTMLElement> {
    const target = document.createElement("div");
    document.body.append(target);
    component = mount(ProjectFilesBody, {
      target,
      props: { adapter: adapter as never, vaultRoot: ROOT },
    });
    await settle();
    (target.querySelector("[data-testid='new-file-open']") as HTMLButtonElement).click();
    flushSync();
    const input = target.querySelector("[data-testid='new-file-name']") as HTMLInputElement;
    input.value = "welcome-v2.md";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    return target;
  }

  it("says in plain words where the file goes", async () => {
    const { adapter } = makeAdapter(true);
    const target = await openForm(adapter);
    const help = target.querySelector("[data-testid='new-file-help']")?.textContent ?? "";
    expect(help).toBe("Creates welcome-v2.md in demo. It syncs to the company vault.");
    expect(help).not.toMatch(/presign|path|clipboard/i);
  });

  it("writes the file, shows Creating…, and opens it", async () => {
    const { adapter, createFile, written } = makeAdapter(true);
    const target = await openForm(adapter);
    const button = target.querySelector("[data-testid='new-file-create']") as HTMLButtonElement;
    button.click();
    flushSync();
    expect(button.textContent).toBe("Creating…");
    expect(button.disabled).toBe(true);
    await settle();
    expect(createFile).toHaveBeenCalledTimes(1);
    expect(createFile.mock.calls[0]?.[0]).toBe(`${ROOT}/welcome-v2.md`);
    expect(written.has(`${ROOT}/welcome-v2.md`)).toBe(true);
    expect(target.querySelector("[data-testid='sheet-new-file']")).toBeNull();
    expect(target.querySelector("[data-testid='project-files-empty']")).toBeNull();
    expect(target.querySelector("[data-testid='new-file-notice']")).toBeNull();
  });

  it("creates locally and says so when cloud sync is unavailable", async () => {
    const { adapter, written } = makeAdapter(false);
    const target = await openForm(adapter);
    (target.querySelector("[data-testid='new-file-create']") as HTMLButtonElement).click();
    await settle();
    expect(written.has(`${ROOT}/welcome-v2.md`)).toBe(true);
    expect(target.querySelector("[data-testid='new-file-notice']")?.textContent).toBe(
      NEW_FILE_LOCAL_NOTICE,
    );
    expect(NEW_FILE_LOCAL_NOTICE).toBe(
      "Saved on this computer. It syncs to the cloud when sync is next connected.",
    );
  });
});
