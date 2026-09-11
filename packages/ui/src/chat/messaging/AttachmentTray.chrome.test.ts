// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";

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

function mountTray(items: FileAttachmentModel[], onclose = () => {}): void {
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

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

// The tray used to print the filename twice — once in a header of its own and
// again in the preview's toolbar six lines below it.
it("names the open file exactly once", () => {
  mountTray([item({ name: "titlebar-mock.png" })]);

  // Chrome only: the browser strip labels its thumbnails, and an unreadable
  // file states its own name on the stage. Neither is the title bar.
  const named = [...host.querySelectorAll("*")].filter(
    (el) =>
      el.children.length === 0 &&
      el.textContent?.trim() === "titlebar-mock.png" &&
      !el.closest(".att-tray-browser") &&
      !el.closest(".att-preview-stage"),
  );
  expect(named).toHaveLength(1);
});

// Close lives in the preview's toolbar, so there is one bar, not two.
it("puts close and download in the same toolbar", () => {
  mountTray([item()]);

  const toolbar = host.querySelector(".att-preview-toolbar");
  expect(toolbar).toBeTruthy();
  expect(toolbar!.querySelector("[data-testid=attachment-tray-close]")).toBeTruthy();
  expect(toolbar!.querySelector("[data-testid=attachment-download]")).toBeTruthy();
});

it("closes from the toolbar button", () => {
  const onclose = vi.fn();
  mountTray([item()], onclose);

  host
    .querySelector<HTMLButtonElement>("[data-testid=attachment-tray-close]")!
    .click();
  expect(onclose).toHaveBeenCalledOnce();
});
