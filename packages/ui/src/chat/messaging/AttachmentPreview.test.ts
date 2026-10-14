// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import AttachmentPreview from "./AttachmentPreview.svelte";
import type { FileAttachmentModel } from "./channelMessageModels";
import * as attachmentPreview from "./attachment-preview";

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
  vi.restoreAllMocks();
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

function pdfItem(overrides: Partial<FileAttachmentModel> = {}): FileAttachmentModel {
  return item({
    id: "att-pdf",
    vaultPath: "chat/att-pdf/titlebar-spec.pdf",
    name: "titlebar-spec.pdf",
    contentType: "application/pdf",
    kind: "file",
    sizeLabel: "48 KB",
    ...overrides,
  });
}

describe("AttachmentPreview documents", () => {
  // Owner decision 2026-10-08: a document card opens this preview, and a PDF
  // reads in place in the lightbox. Download lives in the bar above it.
  it("renders a PDF inline in the lightbox from the resolved URL", async () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/spec.pdf");
    mountPreview({ item: pdfItem(), resolveUrl });

    const frame = await vi.waitFor(() => {
      flushSync();
      const el = host.querySelector<HTMLIFrameElement>(
        ".att-preview-stage [data-testid=attachment-pdf]",
      );
      expect(el).not.toBeNull();
      return el!;
    });
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("https://signed.example/spec.pdf");
    expect(frame.getAttribute("title")).toBe("titlebar-spec.pdf");
    expect(resolveUrl).toHaveBeenCalled();
    // Rendered, so the stage's not-rendered fallback is gone.
    expect(host.querySelector("[data-testid=attachment-file-download]")).toBeNull();
  });

  it("renders a PDF straight from a previewUrl the record already carries", () => {
    const resolveUrl = vi.fn(async () => "https://signed.example/other.pdf");
    mountPreview({
      item: pdfItem({ previewUrl: "blob:local-spec-pdf" }),
      resolveUrl,
    });
    expect(
      host.querySelector("[data-testid=attachment-pdf]")?.getAttribute("src"),
    ).toBe("blob:local-spec-pdf");
    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it("keeps Download in the bar for a PDF and downloads the resolved file", async () => {
    const download = vi
      .spyOn(attachmentPreview, "downloadAttachment")
      .mockResolvedValue(undefined);
    mountPreview({
      item: pdfItem(),
      resolveUrl: async () => "https://signed.example/spec.pdf",
    });

    const button = await vi.waitFor(() => {
      flushSync();
      const el = host.querySelector<HTMLButtonElement>(
        ".att-preview-toolbar [data-testid=attachment-download]",
      );
      expect(el?.disabled).toBe(false);
      return el!;
    });
    expect(button.getAttribute("aria-label")).toBe("Download titlebar-spec.pdf");

    button.click();
    await vi.waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        "https://signed.example/spec.pdf",
        "titlebar-spec.pdf",
      ),
    );
  });

  it("falls back to a Download offer for a file it cannot render inline", async () => {
    const download = vi
      .spyOn(attachmentPreview, "downloadAttachment")
      .mockResolvedValue(undefined);
    mountPreview({
      item: item({
        name: "deck.key",
        contentType: "application/x-iwork-keynote-sffkey",
        kind: "file",
      }),
      resolveUrl: async () => "https://signed.example/deck.key",
    });

    const button = await vi.waitFor(() => {
      flushSync();
      const el = host.querySelector<HTMLButtonElement>(
        "[data-testid=attachment-file-download]",
      );
      expect(el?.disabled).toBe(false);
      return el!;
    });
    expect(host.querySelector("iframe")).toBeNull();
    expect(button.textContent?.trim()).toBe("Download");
    expect(
      host.querySelector<HTMLButtonElement>(
        ".att-preview-toolbar [data-testid=attachment-download]",
      )?.disabled,
    ).toBe(false);

    button.click();
    await vi.waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        "https://signed.example/deck.key",
        "deck.key",
      ),
    );
  });
});

describe("AttachmentPreview bar", () => {
  // One 46px bar carries name, size and every control. Download used to float
  // over the artwork in the corner of the stage.
  it("puts the name, the size and download in one bar, none over the artwork", () => {
    mountPreview({ item: item({ name: "mock.png", sizeLabel: "2.4 MB" }) });
    const bar = host.querySelector(".att-preview-toolbar")!;
    expect(bar.querySelector(".att-preview-name")?.textContent).toBe("mock.png");
    expect(bar.querySelector(".att-preview-meta")?.textContent).toBe("2.4 MB");
    expect(bar.querySelector("[data-testid=attachment-download]")).not.toBeNull();
    expect(
      host.querySelector(".att-preview-stage [data-testid=attachment-download]"),
    ).toBeNull();
  });

  it("matches the lightbox spec: 46px bar, 12/500 name, 10px mono size, standard-height r7 icons, r12 shadowed image", () => {
    const css = (
      readFileSync(join(import.meta.dirname, "AttachmentPreview.svelte"), "utf8")
        .split("<style>")[1] ?? ""
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = (selector: string): string => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`));
      if (!match) throw new Error(`no rule for ${selector}`);
      return match[1];
    };
    expect(rule(".att-preview-toolbar")).toMatch(/height:\s*46px;/);
    expect(rule(".att-preview-name")).toMatch(/font:\s*500 12px\//);
    expect(rule(".att-preview-meta")).toMatch(/font:\s*400 10px\/[\d.]+ var\(--font-mono/);
    const ic = rule(".att-preview-toolbar :global(.att-preview-ic)");
    // Square on the console-rail beta's one button height (button-standard.css).
    expect(ic).toMatch(/width:\s*var\(--hq-btn-h\);/);
    expect(ic).toMatch(/height:\s*var\(--hq-btn-h\);/);
    expect(ic).toMatch(/border-radius:\s*7px;/);
    const img = rule(".att-preview-image");
    expect(img).toMatch(/border-radius:\s*12px;/);
    expect(img).toMatch(/box-shadow:\s*0 24px 60px rgba\(0, 0, 0, 0\.45\);/);
    expect(css).not.toMatch(/\.att-download\b/);
  });
});
