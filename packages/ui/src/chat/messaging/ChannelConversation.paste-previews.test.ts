// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import ChannelConversation from "./ChannelConversation.svelte";
import type { MentionTarget } from "../mentions.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function pngFile(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: "image/png" });
}

function pdfFile(name: string, bytes: number): File {
  return new File([new Uint8Array(bytes)], name, { type: "application/pdf" });
}

function dispatchPaste(el: HTMLElement, files: File[]): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { files, items: [], types: ["Files"] },
  });
  el.dispatchEvent(event);
}

async function settle(): Promise<void> {
  await tick();
  flushSync();
}

function mountComposer(
  onsend?: (
    body: string,
    mentions: MentionTarget[],
    files?: File[],
  ) => void | Promise<void>,
): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ChannelConversation, {
    target: host,
    props: {
      messages: [],
      onsend,
    },
  });
  return host;
}

function composer(root: HTMLElement): HTMLTextAreaElement {
  return root.querySelector(
    '[data-testid="conversation-composer"]',
  ) as HTMLTextAreaElement;
}

function previews(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      '[data-testid="composer-image-preview"]',
    ),
  ];
}

function chips(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('[data-testid="composer-file-chip"]'),
  ];
}

describe("ChannelConversation pasted image previews", () => {
  it("renders a thumbnail with alt and filename tooltip for one pasted image", async () => {
    const root = mountComposer();
    await settle();
    dispatchPaste(composer(root), [pngFile("image.png", 12)]);
    await settle();

    const thumbs = previews(root);
    expect(thumbs).toHaveLength(1);
    expect(chips(root)).toHaveLength(0);
    const img = thumbs[0].querySelector("img") as HTMLImageElement;
    expect(img.alt).toMatch(/^pasted-.*\.png$/);
    expect(thumbs[0].getAttribute("title")).toBe(img.alt);
    expect(img.getAttribute("src")).toMatch(/^blob:/);
  });

  it("accumulates three pasted images in order, including paste-after-paste", async () => {
    const root = mountComposer();
    await settle();
    const input = composer(root);
    dispatchPaste(input, [pngFile("image.png", 10)]);
    await settle();
    dispatchPaste(input, [
      pngFile("image.png", 20),
      pngFile("image.png", 30),
    ]);
    await settle();

    const alts = previews(root).map(
      (thumb) => thumb.querySelector("img")?.alt ?? "",
    );
    expect(alts).toHaveLength(3);
    expect(alts[0]).toMatch(/-1\.png$/);
    expect(alts[1]).toMatch(/-2\.png$/);
    expect(alts[2]).toMatch(/-3\.png$/);
  });

  it("removes the middle preview and leaves the other two in order", async () => {
    const root = mountComposer();
    await settle();
    dispatchPaste(composer(root), [
      pngFile("one.png", 11),
      pngFile("two.png", 22),
      pngFile("three.png", 33),
    ]);
    await settle();

    const middle = previews(root)[1];
    const remove = middle.querySelector(
      'button[aria-label="Remove two.png"]',
    ) as HTMLButtonElement;
    remove.click();
    await settle();

    expect(
      previews(root).map((thumb) => thumb.querySelector("img")?.alt ?? ""),
    ).toEqual(["one.png", "three.png"]);
  });

  it("keeps an image preview beside a compact file chip for mixed paste", async () => {
    const root = mountComposer();
    await settle();
    dispatchPaste(composer(root), [
      pngFile("shot.png", 16),
      pdfFile("notes.pdf", 24),
    ]);
    await settle();

    expect(previews(root).map((thumb) => thumb.querySelector("img")?.alt)).toEqual([
      "shot.png",
    ]);
    expect(chips(root).map((chip) => chip.getAttribute("title"))).toEqual([
      "notes.pdf",
    ]);
    expect(chips(root)[0].textContent).toContain("notes.pdf");
  });

  it("sends image attachments in paste order so the thread can render them inline", async () => {
    const sent: File[][] = [];
    const root = mountComposer((_body, _mentions, files) => {
      sent.push(files ?? []);
    });
    await settle();
    dispatchPaste(composer(root), [
      pngFile("first.png", 14),
      pngFile("second.png", 15),
    ]);
    await settle();

    const sendBtn = root.querySelector(
      '[data-testid="composer-send"]',
    ) as HTMLButtonElement;
    sendBtn.click();
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].map((file) => file.name)).toEqual(["first.png", "second.png"]);
    const thumbs = [
      ...root.querySelectorAll<HTMLImageElement>(
        '[data-testid="attachment-thumb"] img',
      ),
    ];
    expect(thumbs.map((img) => img.alt)).toEqual(["first.png", "second.png"]);
  });

  it("revokes the object URL when a pending image is removed", async () => {
    const created: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      const name = blob instanceof File ? blob.name : "blob";
      const url = `blob:test/${name}`;
      created.push(url);
      return url;
    });
    const revoked: string[] = [];
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revoked.push(String(url));
    });

    const root = mountComposer();
    await settle();
    dispatchPaste(composer(root), [
      pngFile("keep-a.png", 11),
      pngFile("drop-me.png", 22),
      pngFile("keep-b.png", 33),
    ]);
    await settle();
    expect(created).toEqual([
      "blob:test/keep-a.png",
      "blob:test/drop-me.png",
      "blob:test/keep-b.png",
    ]);

    const drop = previews(root)[1].querySelector(
      'button[aria-label="Remove drop-me.png"]',
    ) as HTMLButtonElement;
    drop.click();
    await settle();

    expect(revoked).toContain("blob:test/drop-me.png");
    expect(revoked).not.toContain("blob:test/keep-a.png");
    expect(revoked).not.toContain("blob:test/keep-b.png");
    expect(
      previews(root).map((thumb) => thumb.querySelector("img")?.alt ?? ""),
    ).toEqual(["keep-a.png", "keep-b.png"]);
  });

  it("removes a focused image preview with Backspace", async () => {
    const root = mountComposer();
    await settle();
    dispatchPaste(composer(root), [pngFile("bye.png", 18)]);
    await settle();
    const remove = previews(root)[0].querySelector(
      'button[aria-label="Remove bye.png"]',
    ) as HTMLButtonElement;
    remove.focus();
    remove.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    );
    await settle();
    expect(previews(root)).toHaveLength(0);
    expect(root.querySelector('[data-testid="composer-pending"]')).toBeNull();
  });
});
