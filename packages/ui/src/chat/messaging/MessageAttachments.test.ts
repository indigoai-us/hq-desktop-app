// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import MessageAttachments from "./MessageAttachments.svelte";
import type { FileAttachmentModel } from "./channelMessageModels";

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
