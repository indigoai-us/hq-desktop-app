// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import AttachmentPreview from "./AttachmentPreview.svelte";
import type { FileAttachmentModel } from "./channelMessageModels";

function item(
  overrides: Partial<FileAttachmentModel> = {},
): FileAttachmentModel {
  return {
    id: "att-1",
    vaultPath: "chat/att-1/photo.png",
    name: "photo.png",
    contentType: "image/png",
    sizeBytes: 100,
    sizeLabel: "100 B",
    kind: "image",
    previewUrl: null,
    companyUid: "",
    ...overrides,
  } as FileAttachmentModel;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountPreview(props: {
  item: FileAttachmentModel;
  thumbnailUrl?: string | null;
  resolveUrl?: (a: FileAttachmentModel) => Promise<string | null>;
  onreleaseurl?: (url: string) => void;
}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AttachmentPreview, { target: host, props });
  flushSync();
}

async function settle(): Promise<void> {
  // Let the resolveUrl promise chain land, then flush the rerender.
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

describe("AttachmentPreview image detail pane", () => {
  it("resolves a URL even when the record has no companyUid (host resolver owns the fallback)", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/photo.png");
    mountPreview({ item: item({ companyUid: "" }), resolveUrl });
    await settle();
    expect(resolveUrl).toHaveBeenCalled();
    const img = host.querySelector<HTMLImageElement>(".att-preview-image");
    expect(img?.src).toBe("https://signed.example/photo.png");
  });

  it("re-resolves a fresh URL when the stored previewUrl fails to load", async () => {
    const resolveUrl = vi.fn(
      async (_a: FileAttachmentModel) => "https://signed.example/fresh.png",
    );
    mountPreview({
      item: item({
        companyUid: "co-1",
        previewUrl: "blob:dead-local-preview",
      }),
      resolveUrl,
    });
    await settle();
    // previewUrl short-circuits — no resolve yet.
    expect(resolveUrl).not.toHaveBeenCalled();
    const img = host.querySelector<HTMLImageElement>(".att-preview-image");
    expect(img?.src).toContain("blob:dead-local-preview");

    img?.dispatchEvent(new Event("error"));
    flushSync();
    await settle();

    expect(resolveUrl).toHaveBeenCalled();
    // The dead previewUrl must not be handed back to the resolver.
    expect(resolveUrl.mock.calls[0]?.[0]?.previewUrl ?? null).toBeNull();
    const fresh = host.querySelector<HTMLImageElement>(".att-preview-image");
    expect(fresh?.src).toBe("https://signed.example/fresh.png");
  });

  it("shows an error state when the freshly resolved URL also fails", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/fresh.png");
    mountPreview({
      item: item({ companyUid: "co-1", previewUrl: "blob:dead" }),
      resolveUrl,
    });
    await settle();
    host
      .querySelector<HTMLImageElement>(".att-preview-image")
      ?.dispatchEvent(new Event("error"));
    flushSync();
    await settle();
    host
      .querySelector<HTMLImageElement>(".att-preview-image")
      ?.dispatchEvent(new Event("error"));
    flushSync();
    expect(host.textContent).toContain("Could not load the file");
  });

  it("shows an error state when the host cannot load desktop bytes", async () => {
    mountPreview({ item: item(), resolveUrl: async () => null });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Could not load the file");
    });
  });

  it("loads the file again from Try again after an error", async () => {
    // Owner, 2026-10-21: the error screen was a dead end. It offers Try
    // again, and a second attempt that succeeds replaces the error.
    let reachable = false;
    const resolveUrl = vi.fn(async () => (reachable ? "blob:notes" : null));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("hello again")),
    );
    mountPreview({
      item: item({ name: "notes.txt", contentType: "text/plain", kind: "file" }),
      resolveUrl,
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Could not load the file");
    });
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="attachment-retry"]');
    expect(retry?.textContent?.trim()).toBe("Try again");
    const before = resolveUrl.mock.calls.length;
    reachable = true;
    retry!.click();
    flushSync();
    await vi.waitFor(() => {
      expect(resolveUrl.mock.calls.length).toBeGreaterThan(before);
      expect(host.textContent).toContain("hello again");
    });
    expect(host.textContent).not.toContain("Could not load the file");
    vi.unstubAllGlobals();
  });

  it("names the file the way the chat card does", async () => {
    mountPreview({
      item: item({ name: "spec.pdf", contentType: "application/pdf", kind: "file" }),
      resolveUrl: async () => null,
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Could not load the file");
    });
    expect(host.querySelector(".att-preview-icon")?.classList.contains("is-document")).toBe(true);
    expect(host.querySelector(".att-preview-file-meta")?.textContent).toMatch(/^PDF/);
  });

  it("shows plain copy, never the raw error, when resolving the file throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const raw = new Error('[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}');
    mountPreview({
      item: item({ name: "notes.txt", contentType: "text/plain", kind: "file" }),
      resolveUrl: async () => {
        throw raw;
      },
    });
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Could not load the file. Try again.");
    });
    expect(host.textContent).not.toContain("boom");
    for (const el of host.querySelectorAll("[title]")) {
      expect(el.getAttribute("title")).not.toContain("boom");
    }
    expect(warn).toHaveBeenCalledWith("[attachment-preview] load failed", raw);
    warn.mockRestore();
  });

  it("releases its resolved desktop object URL on unmount", async () => {
    const onreleaseurl = vi.fn();
    mountPreview({
      item: item(),
      resolveUrl: async () => "blob:desktop-detail",
      onreleaseurl,
    });
    await settle();
    await unmount(component!);
    component = null;
    expect(onreleaseurl).toHaveBeenCalledWith("blob:desktop-detail");
  });
});


it("shows the cached thumbnail immediately but downloads only the full original", async () => {
  let finish!: (url: string) => void;
  mountPreview({
    item: item(), thumbnailUrl: "blob:thumbnail",
    resolveUrl: () => new Promise((resolve) => { finish = resolve; }),
  });
  expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:thumbnail");
  expect(host.querySelector<HTMLButtonElement>("[data-testid=attachment-download]")?.disabled).toBe(true);
  finish("blob:original");
  await settle();
  expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:original");
  expect(host.querySelector<HTMLButtonElement>("[data-testid=attachment-download]")?.disabled).toBe(false);
});

describe("AttachmentPreview folder shares", () => {
  it("never resolves, fetches or offers download for a folder share (feedback 3e124bcd)", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/folder");
    mountPreview({
      item: item({ vaultPath: "knowledge/clients/frank/", name: "frank", contentType: "", kind: "folder" }),
      resolveUrl,
    });
    await settle();
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=attachment-download]")).toBeNull();
    expect(host.querySelector("[data-testid=attachment-folder-note]")).not.toBeNull();
    expect(host.textContent).not.toContain("Could not load the file");
  });

  it("treats a glob share key as a folder even when the card says file (feedback ae977608)", async () => {
    const resolveUrl = vi.fn(async () => null);
    mountPreview({
      item: item({ vaultPath: "projects/ops-workflow-design/*", name: "ops-workflow-design", contentType: "", kind: "file" }),
      resolveUrl,
    });
    await settle();
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=attachment-download]")).toBeNull();
    expect(host.textContent).not.toContain("Could not load the file");
  });
});

// iOS #44: an image fits the window and zooms on a gesture. On desktop that
// is double-click (2x and back) and a trackpad pinch (ctrl-wheel).
describe("AttachmentPreview image zoom", () => {
  function zoomed(): boolean {
    return host.querySelector(".att-preview-stage")?.classList.contains("is-zoomed") ?? false;
  }

  it("double-click zooms in, and again fits the image back", async () => {
    mountPreview({ item: item({ previewUrl: "blob:photo" }), resolveUrl: async () => "blob:photo" });
    await settle();
    const img = host.querySelector<HTMLImageElement>(".att-preview-image")!;
    expect(zoomed()).toBe(false);
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }));
    flushSync();
    expect(zoomed()).toBe(true);
    img.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 10, clientY: 10 }));
    flushSync();
    expect(zoomed()).toBe(false);
  });

  it("a pinch (ctrl-wheel) zooms and is not left to scroll the window", async () => {
    mountPreview({ item: item({ previewUrl: "blob:photo" }), resolveUrl: async () => "blob:photo" });
    await settle();
    const stage = host.querySelector(".att-preview-stage")!;
    const pinch = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -60 });
    // happy-dom drops some wheel fields from the init dict.
    Object.defineProperty(pinch, "deltaY", { value: -60 });
    Object.defineProperty(pinch, "ctrlKey", { value: true });
    Object.defineProperty(pinch, "clientX", { value: 10 });
    Object.defineProperty(pinch, "clientY", { value: 10 });
    stage.dispatchEvent(pinch);
    flushSync();
    expect(pinch.defaultPrevented).toBe(true);
    expect(zoomed()).toBe(true);

    // A plain wheel still scrolls.
    const scroll = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40 });
    stage.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
  });
});

describe("AttachmentPreview without a preview", () => {
  it("says there is no preview instead of leaving the stage blank", async () => {
    mountPreview({
      item: item({ name: "archive.zip", contentType: "application/zip", kind: "file", vaultPath: "chat/a/archive.zip" }),
      resolveUrl: async () => "blob:zip",
    });
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="attachment-no-preview"]')?.textContent).toContain("No preview");
    });
  });
});
