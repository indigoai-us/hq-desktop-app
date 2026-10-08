// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { ImagePreviewCache } from "./image-preview-cache";
import MessageAttachments from "./MessageAttachments.svelte";
import type { FileAttachmentModel } from "./channelMessageModels";
import * as attachmentPreview from "./attachment-preview";

function item(
  overrides: Partial<FileAttachmentModel> = {},
): FileAttachmentModel {
  return {
    id: "att-1",
    vaultPath: "chat/attachments/chan/ch-1/att-1-photo.png",
    name: "photo.png",
    contentType: "image/png",
    sizeBytes: 100,
    sizeLabel: "100 B",
    kind: "image",
    caption: "FILES · 100 B",
    previewUrl: null,
    companyUid: "",
    ...overrides,
  } as FileAttachmentModel;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function mountStrip(props: {
  attachments: FileAttachmentModel[];
  previewCache?: ImagePreviewCache | null;
  vaultCompanyUid?: string;
  onopen?: (a: FileAttachmentModel) => void;
  resolveUrl?: (a: FileAttachmentModel) => Promise<string | null>;
  onreleaseurl?: (url: string) => void;
}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MessageAttachments, { target: host, props });
  flushSync();
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("MessageAttachments inline images", () => {
  it("resolves bytes for a received image even when companyUid is empty (host resolver owns the fallback)", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/photo.png");
    mountStrip({ attachments: [item({ companyUid: "" })], resolveUrl });
    await settle();
    expect(resolveUrl).toHaveBeenCalledTimes(1);
    const img = host.querySelector<HTMLImageElement>(
      "[data-testid='attachment-thumb'] img",
    );
    expect(img?.src).toBe("https://signed.example/photo.png");
  });

  it("renders multiple images as thumbs in one wrapping strip", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/p.png");
    mountStrip({
      attachments: [
        item({ id: "a1", vaultPath: "v/a1.png", name: "a1.png" }),
        item({ id: "a2", vaultPath: "v/a2.png", name: "a2.png" }),
      ],
      resolveUrl,
    });
    await settle();
    const strips = host.querySelectorAll("[data-testid='message-attachments']");
    expect(strips.length).toBe(1);
    expect(
      host.querySelectorAll("[data-testid='attachment-thumb']").length,
    ).toBe(2);
  });

  it("keeps non-image attachments as file cards", () => {
    mountStrip({
      attachments: [
        item({
          id: "doc",
          vaultPath: "v/spec.pdf",
          name: "spec.pdf",
          contentType: "application/pdf",
          kind: "file",
        }),
      ],
    });
    expect(host.querySelector("[data-testid='attachment-card']")).toBeTruthy();
    expect(host.querySelector("[data-testid='attachment-thumb']")).toBeNull();
  });

  it("clicking a thumb opens the host viewer", async () => {
    const onopen = vi.fn();
    const resolveUrl = vi.fn(async () => "https://signed.example/photo.png");
    mountStrip({ attachments: [item()], onopen, resolveUrl });
    await settle();
    host
      .querySelector<HTMLButtonElement>("[data-testid='attachment-thumb']")
      ?.click();
    expect(onopen).toHaveBeenCalledTimes(1);
  });

  it("releases resolved desktop bytes when the strip unmounts", async () => {
    const onreleaseurl = vi.fn();
    mountStrip({
      attachments: [item()],
      resolveUrl: async () => "blob:desktop-photo",
      onreleaseurl,
    });
    await settle();
    await unmount(component!);
    component = null;
    expect(onreleaseurl).toHaveBeenCalledWith("blob:desktop-photo");
  });
});


describe("cached inline image rendering", () => {
  function cache(load = vi.fn(async () => new Blob(["png"], { type: "image/png" }))) {
    return new ImagePreviewCache({
      account: "alice", load,
      prepare: async (blob) => ({ blob, width: 320, height: 220 }),
      createUrl: () => "blob:cached-preview",
      revokeUrl: vi.fn(),
    });
  }
  it("renders a warm image synchronously on remount, with no placeholder", async () => {
    const load = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    const previewCache = cache(load);
    await previewCache.warm("company", item().vaultPath);
    mountStrip({ attachments: [item()], previewCache, vaultCompanyUid: "company" });
    // No tick/settle: the image must exist in the initial render.
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:cached-preview");
    expect(host.textContent).not.toContain("Loading image");
    await unmount(component!);
    component = null;
    host.remove();
    mountStrip({ attachments: [item()], previewCache, vaultCompanyUid: "company" });
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:cached-preview");
    expect(load).toHaveBeenCalledTimes(1);
  });
  it("replaces a cold placeholder in the same frame and can retry a failure", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    const previewCache = cache(load);
    mountStrip({ attachments: [item()], previewCache, vaultCompanyUid: "company" });
    const frame = host.querySelector("[data-testid=attachment-thumb]");
    expect(frame?.textContent).toContain("Loading image");
    expect(frame?.textContent).not.toContain("photo.png");
    await vi.waitFor(() => expect(frame?.textContent).toContain("Retry"));
    (frame as HTMLButtonElement).click();
    await vi.waitFor(() => expect(frame?.querySelector("img")).not.toBeNull());
    expect(host.querySelector("[data-testid=attachment-thumb]")).toBe(frame);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

function pdf(overrides: Partial<FileAttachmentModel> = {}): FileAttachmentModel {
  return item({
    id: "att-pdf",
    name: "titlebar-spec.pdf",
    contentType: "application/pdf",
    kind: "file",
    sizeLabel: "48 KB",
    vaultPath: "chat/attachments/chan/ch-1/att-pdf-spec.pdf",
    ...overrides,
  });
}

describe("MessageAttachments document cards", () => {
  // Owner decision 2026-10-08: a document card opens the lightbox preview,
  // the same path an image takes. A one-click download (caption "Saving…")
  // shipped briefly and surprised people used to previewing files; Download
  // lives in the lightbox bar instead.
  it("opens the preview on click instead of downloading", async () => {
    const download = vi
      .spyOn(attachmentPreview, "downloadAttachment")
      .mockResolvedValue(undefined);
    const onopen = vi.fn();
    const resolveUrl = vi.fn(async () => "blob:spec-pdf");
    const doc = pdf();
    mountStrip({ attachments: [doc], onopen, resolveUrl });

    const card = host.querySelector<HTMLButtonElement>(
      "[data-testid=attachment-card]",
    )!;
    expect(card.getAttribute("aria-label")).toBe("Open titlebar-spec.pdf");
    card.click();
    await settle();

    expect(onopen).toHaveBeenCalledTimes(1);
    expect(onopen).toHaveBeenCalledWith(doc);
    expect(download).not.toHaveBeenCalled();
    // Zero network from the strip: the lightbox resolves the file.
    expect(resolveUrl).not.toHaveBeenCalled();
    expect(card.disabled).toBe(false);
    expect(card.getAttribute("aria-busy")).toBeNull();
    expect(
      host.querySelector("[data-testid=attachment-card-meta]")?.textContent?.trim(),
    ).toBe("48 KB");
  });

  it("opens the preview from the keyboard too (Enter / Space on a native button)", () => {
    const onopen = vi.fn();
    const doc = pdf({ name: "notes.md", contentType: "text/markdown" });
    mountStrip({ attachments: [doc], onopen });
    const card = host.querySelector<HTMLElement>("[data-testid=attachment-card]")!;
    // A real <button type="button">: the browser turns Enter and Space into
    // the click this test dispatches, so no key handler can drift from it.
    expect(card.tagName).toBe("BUTTON");
    expect(card.getAttribute("type")).toBe("button");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onopen).toHaveBeenCalledWith(doc);
  });

  it("captions the size, never a download state", () => {
    mountStrip({ attachments: [pdf()] });
    const card = host.querySelector("[data-testid=attachment-card]")!;
    expect(card.querySelector("[data-testid=attachment-card-meta]")?.textContent?.trim()).toBe("48 KB");
    expect(card.textContent).not.toContain("Saving");
    expect(card.textContent).not.toContain("download");
  });

  it("wears the doc-card shell with no Download affordance or nested button", () => {
    mountStrip({ attachments: [pdf()] });
    const card = host.querySelector("[data-testid=attachment-card]")!;
    expect(card.classList.contains("doc-card")).toBe(true);
    // A hover-only Download glyph would now promise something the click
    // does not do.
    expect(card.querySelector(".doc-card-actions")).toBeNull();
    expect(host.textContent).not.toContain("Download");
    expect(card.querySelector("button")).toBeNull();
    expect(card.querySelector(".doc-card-icon")?.textContent?.trim()).toBe("PDF");
  });
});

describe("MessageAttachments single image", () => {
  const css = (
    readFileSync(join(import.meta.dirname, "MessageAttachments.svelte"), "utf8")
      .split("<style>")[1] ?? ""
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`no rule for ${selector}`);
    return match[1];
  };

  // A lone image used to sit letterboxed in a fixed 320x220 box: a portrait
  // shot had dead bands down both sides. It hugs its artwork now, capped.
  it("hugs its artwork up to 320 wide by 220 tall instead of a fixed box", () => {
    const tile = rule(".att-thumb.is-single");
    expect(tile).toMatch(/width:\s*auto;/);
    expect(tile).toMatch(/height:\s*auto;/);
    expect(tile).toMatch(/max-width:\s*min\(320px, 100%\);/);
    expect(tile).not.toMatch(/(?:^|;)\s*height:\s*220px/);

    const img = rule(".att-thumb.is-single img");
    expect(img).toMatch(/width:\s*auto;/);
    expect(img).toMatch(/height:\s*auto;/);
    expect(img).toMatch(/max-width:\s*100%;/);
    expect(img).toMatch(/max-height:\s*220px;/);
  });

  it("marks only a lone image as single", async () => {
    mountStrip({ attachments: [item()], resolveUrl: async () => "blob:p" });
    await settle();
    expect(
      host.querySelector("[data-testid=attachment-thumb]")?.classList.contains("is-single"),
    ).toBe(true);
  });
});
