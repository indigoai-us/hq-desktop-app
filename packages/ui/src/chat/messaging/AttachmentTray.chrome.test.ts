// @vitest-environment happy-dom

// The attachment preview is a lightbox: a full-bleed blurred scrim, one bar
// carrying the filename, size, download and close, and the artwork. It used to
// be a dark card floating on the scrim that named the file twice (a header of
// its own plus the preview's toolbar), floated download over the artwork, and
// ran a filmstrip of every attachment along the bottom.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import AttachmentTray from "./AttachmentTray.svelte";
import type { FileAttachmentModel } from "./channelMessageModels";

function item(overrides: Partial<FileAttachmentModel> = {}): FileAttachmentModel {
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

function mountTray(
  items: FileAttachmentModel[],
  onclose: () => void = () => {},
): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AttachmentTray, {
    target: host,
    props: {
      items,
      selectedId: items[0]?.id ?? null,
      onselect: () => {},
      onclose,
      resolveUrl: async () => null,
    },
  });
  flushSync();
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("attachment lightbox chrome", () => {
  it("names the open file exactly once", () => {
    mountTray([item({ name: "titlebar-mock.png" })]);
    // Chrome only: an unreadable file states its own name on the stage.
    const named = [...host.querySelectorAll("*")].filter(
      (el) =>
        el.children.length === 0 &&
        el.textContent?.trim() === "titlebar-mock.png" &&
        !el.closest(".att-preview-stage"),
    );
    expect(named).toHaveLength(1);
    expect(host.querySelector(".att-tray-head, .att-tray-kicker")).toBeNull();
  });

  it("puts close and download in the same single bar", () => {
    mountTray([item()]);
    const bars = host.querySelectorAll(".att-preview-toolbar");
    expect(bars).toHaveLength(1);
    expect(bars[0]!.querySelector("[data-testid=attachment-tray-close]")).toBeTruthy();
    expect(bars[0]!.querySelector("[data-testid=attachment-download]")).toBeTruthy();
  });

  it("has no filmstrip of thumbnails under the artwork", () => {
    mountTray([
      item(),
      item({ id: "att-2", vaultPath: "chat/att-2/b.png", name: "b.png" }),
      item({ id: "att-3", vaultPath: "chat/att-3/c.pdf", name: "c.pdf", kind: "file" }),
    ]);
    expect(host.querySelector("[data-testid=attachment-tray-item]")).toBeNull();
    expect(host.querySelector(".att-tray-browser, nav")).toBeNull();
  });

  it("still offers close when there is nothing to preview", () => {
    const onclose = vi.fn();
    mountTray([], onclose);
    host
      .querySelector<HTMLButtonElement>("[data-testid=attachment-tray-close]")!
      .click();
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe("attachment lightbox behaviour", () => {
  it("closes from the bar's close button", () => {
    const onclose = vi.fn();
    mountTray([item()], onclose);
    host
      .querySelector<HTMLButtonElement>("[data-testid=attachment-tray-close]")!
      .click();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("closes on Escape", () => {
    const onclose = vi.fn();
    mountTray([item()], onclose);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onclose).toHaveBeenCalled();
  });

  it("moves focus into the dialog when it opens", () => {
    mountTray([item()]);
    expect(document.activeElement).toBe(host.querySelector("[role=dialog]"));
  });

  // The scrim is full-bleed, so the empty stage around the artwork is the
  // "outside" a click dismisses from. Clicking the artwork itself does not.
  it("closes on a click beside the artwork, not on the artwork", () => {
    const onclose = vi.fn();
    mountTray([item({ previewUrl: "blob:art" })], onclose);
    host.querySelector<HTMLElement>(".att-preview-image")!.click();
    expect(onclose).not.toHaveBeenCalled();
    host.querySelector<HTMLElement>(".att-preview-stage")!.click();
    expect(onclose).toHaveBeenCalledOnce();
  });
});

describe("attachment lightbox scrim", () => {
  const css = (
    readFileSync(join(import.meta.dirname, "AttachmentTray.svelte"), "utf8")
      .split("<style>")[1] ?? ""
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  it("is a full-bleed rgba(0,0,0,.74) scrim blurred 4px, not a floating card", () => {
    const scrim = css.match(/\.att-modal\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(scrim).toMatch(/inset:\s*0;/);
    expect(scrim).toMatch(/background:\s*rgba\(0, 0, 0, 0\.74\);/);
    expect(scrim).toMatch(/(?:^|;)\s*backdrop-filter:\s*blur\(4px\);/);
    expect(scrim).not.toMatch(/padding:/);
    const tray = css.match(/\.att-tray\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(tray).toMatch(/background:\s*transparent;/);
    expect(tray).not.toMatch(/border(?:-radius)?:/);
  });
});
