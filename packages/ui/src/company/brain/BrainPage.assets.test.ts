// @vitest-environment happy-dom
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyncPlatformAdapter, ok, type PlatformAdapter } from "@hq/platform";
import BrainPage from "./BrainPage.svelte";

let component: ReturnType<typeof mount> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

async function renderAssets(withAdapter = true, useNativeAdapter = false) {
  const slug = `asset-co-${Math.random().toString(36).slice(2)}`;
  const root = `companies/${slug}/knowledge`;
  const folder = `${root}/marketing/email/inboxphil-research`;
  const paths = ["notes.md", "inboxphil-flow-chart.png", "inboxphil-flow-chart.html", "brief.pdf", "draft.docx"].map((name) => `${folder}/${name}`);
  const bodies: Record<string, string> = {
    [paths[0]!]: "# Research notes\nThe note stays readable.",
    [paths[2]!]: '<html><script>window.shouldNeverRun = true</script><h1>Flow</h1></html>',
  };
  const files = {
    listDir: vi.fn(async (dir: string) => {
      const prefix = `${dir}/`;
      const entries = new Map<string, boolean>();
      for (const path of paths) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        entries.set(rest.split("/")[0]!, rest.includes("/"));
      }
      return ok([...entries].map(([name, isDir]) => ({ name, path: `${prefix}${name}`, isDir, hasChildren: isDir })));
    }),
    getFileContent: vi.fn(async (path: string) => path in bodies ? ok(bodies[path]!) : { ok: false as const, reason: "error" as const, message: "Binary file cannot be read as text" }),
    getAuthorizedPreview: vi.fn(async (path: string) => ok({ mimeType: path.endsWith(".pdf") ? "application/pdf" : "image/png", dataBase64: "YWJj" })),
    revealInFinder: vi.fn(async () => ok(undefined)),
  };
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === "list_hq_dir") {
      const result = await files.listDir(String(args?.relPath));
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }
    if (command === "get_company_file_content") {
      const result = await files.getFileContent(String(args?.path));
      if (!result.ok) throw new Error(result.message);
      return result.value;
    }
    if (command === "reveal_authorized_file") return undefined;
    throw new Error(`Unexpected native command: ${command}`);
  });
  const adapter = useNativeAdapter
    ? createSyncPlatformAdapter({ invoke })
    : { files, isAvailable: (cap: string) => cap === "localFiles" } as unknown as PlatformAdapter;
  component = mount(BrainPage, { target: document.body, props: {
    page: "knowledge", slug, files: (useNativeAdapter ? adapter.files : files) as never, library: null, shell: null, settings: null,
    adapter: withAdapter ? adapter : null,
  } });
  await vi.waitFor(() => expect(document.querySelector("[data-testid='brain-page']")?.getAttribute("data-phase")).toBe("ready"));
  flushSync();
  const search = document.querySelector<HTMLInputElement>("input.search")!;
  search.value = "inboxphil-research";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  const select = async (name: string) => {
    await vi.waitFor(() => expect([...document.querySelectorAll("[data-testid='vault-tree-row']")].some((row) => row.querySelector(".vt-name")?.textContent === name)).toBe(true));
    const row = [...document.querySelectorAll<HTMLButtonElement>("[data-testid='vault-tree-row']")].find((row) => row.querySelector(".vt-name")?.textContent === name)!;
    row.click(); flushSync();
  };
  return { root, folder, paths, files, invoke, select, search };
}

describe("Knowledge assets (feedback ca1862ba)", () => {
  it("discovers nested markdown, images, HTML, PDF and DOCX without eagerly reading assets", async () => {
    const { root, paths, files } = await renderAssets();
    await vi.waitFor(() => expect(document.querySelector("[data-testid='brain-knowledge-count']")?.textContent).toBe("5 files"));
    const tree = document.querySelector("[data-testid='brain-knowledge-tree']")!;
    await vi.waitFor(() => {
      for (const path of paths.slice(1)) expect(tree.textContent).toContain(path.split("/").pop());
    });
    expect(files.getFileContent.mock.calls.map(([path]) => path)).toEqual([paths[0]]);
    expect(files.getAuthorizedPreview).not.toHaveBeenCalled();
    expect(files.listDir.mock.calls.every(([path]) => path.startsWith(root) || path === root.replace(/knowledge$/, "policies"))).toBe(true);
  });

  it("uses authorized media previews and inert HTML source, preserving markdown details", async () => {
    const { paths, files, select } = await renderAssets();
    await select("inboxphil-flow-chart.png");
    await vi.waitFor(() => expect(document.querySelector("[data-testid='file-preview-image'] img")).toBeTruthy());
    expect(files.getAuthorizedPreview).toHaveBeenLastCalledWith(paths[1]);
    await select("brief.pdf");
    await vi.waitFor(() => expect(document.querySelector("[data-testid='file-preview-pdf']")).toBeTruthy());
    expect(files.getAuthorizedPreview).toHaveBeenLastCalledWith(paths[3]);
    await select("inboxphil-flow-chart.html");
    await vi.waitFor(() => expect(document.querySelector("[data-testid='file-preview-monospace']")?.textContent).toContain("<script>"));
    expect(document.querySelector("[data-testid='file-preview-pane'] script")).toBeNull();
    expect(document.querySelector("[data-testid='file-preview-pane'] iframe")).toBeNull();
    await select("Research notes");
    expect(document.querySelector("[data-testid='brain-doc-body']")?.textContent).toContain("The note stays readable.");
  });

  it("provides an explicit reveal fallback when the host has no preview adapter", async () => {
    const { paths, files, select } = await renderAssets(false);
    await select("draft.docx");
    const fallback = document.querySelector("[data-testid='brain-asset-fallback']")!;
    expect(fallback.textContent).toContain("Preview is not available");
    [...fallback.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Show in folder"))!.click();
    await vi.waitFor(() => expect(files.revealInFinder).toHaveBeenCalledWith(paths[4]));
    expect(files.getFileContent.mock.calls.map(([path]) => path)).toEqual([paths[0]]);
  });

  it.each([true, false])("routes reveal through the actual Sync adapter (preview host: %s)", async (withPreview) => {
    const { paths, invoke, select } = await renderAssets(withPreview, true);
    await select("draft.docx");
    if (withPreview) {
      await vi.waitFor(() => expect(document.querySelector("[data-testid='file-preview-unsupported']")).toBeTruthy());
      document.querySelector<HTMLButtonElement>("[data-testid='reveal-in-finder']")!.click();
    } else {
      const fallback = document.querySelector("[data-testid='brain-asset-fallback']")!;
      [...fallback.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("Show in folder"))!.click();
    }
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("reveal_authorized_file", { path: paths[4] }));
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain("reveal_folder");
  });

  it("keeps unsupported binary files discoverable with a native reveal action", async () => {
    const { paths, files, select } = await renderAssets();
    await select("draft.docx");
    await vi.waitFor(() => expect(document.querySelector("[data-testid='file-preview-unsupported']")).toBeTruthy());
    document.querySelector<HTMLButtonElement>("[data-testid='reveal-in-finder']")!.click();
    await vi.waitFor(() => expect(files.revealInFinder).toHaveBeenCalledWith(paths[4]));
  });
});
