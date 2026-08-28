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
  resolveUrl?: (a: FileAttachmentModel) => Promise<string | null>;
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
});
