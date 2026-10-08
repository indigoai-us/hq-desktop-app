// @vitest-environment happy-dom

// QA-094: links in a rendered Markdown preview. Relative links open project
// files, a missing file shows a plain note, https goes to the host opener and
// #anchors scroll inside the preview.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import FilePreviewPane from "./FilePreviewPane.svelte";
import { setHostOpenUrl } from "../common/external-links.js";
import { resolveMarkdownLink } from "../common/markdown-links.js";
import type { PlatformAdapter } from "@hq/platform";

const ROOT = "projects/job-migration";

const files: Record<string, string> = {
  [`${ROOT}/README.md`]: "# Readme\n\nSee [refs](references.md), [deep](docs/x.md), [gone](missing.md), [site](https://example.com/a), [jump](#usage-notes).\n\n## Usage notes\n\nBody.",
  [`${ROOT}/references.md`]: "# References",
  [`${ROOT}/docs/x.md`]: "# X",
};

function makeAdapter(): PlatformAdapter {
  return {
    isAvailable: () => false,
    files: {
      getFileContent: vi.fn(async (path: string) =>
        path in files ? { ok: true, value: files[path] } : { ok: false, reason: "error", message: "not found" },
      ),
      getAuthorizedPreview: vi.fn(async () => ({ ok: false, reason: "error", message: "not found" })),
    },
  } as unknown as PlatformAdapter;
}

let component: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    await tick();
  }
}

async function render(path = `${ROOT}/README.md`) {
  const onopenpath = vi.fn();
  component = mount(FilePreviewPane, {
    target: document.body,
    props: { adapter: makeAdapter(), path, scopeRoot: ROOT, onopenpath },
  });
  await settle();
  return onopenpath;
}

function clickLink(text: string): MouseEvent {
  const link = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-testid="file-preview-markdown"] a')).find(
    (a) => a.textContent === text,
  )!;
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(event);
  return event;
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  setHostOpenUrl(null);
  document.body.innerHTML = "";
});

describe("Markdown preview links (QA-094)", () => {
  it("a relative link opens the sibling project file", async () => {
    const onopenpath = await render();
    const event = clickLink("refs");
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(onopenpath).toHaveBeenCalledWith(`${ROOT}/references.md`);
  });

  it("a nested path resolves against the current file's folder", async () => {
    const onopenpath = await render();
    clickLink("deep");
    await settle();
    expect(onopenpath).toHaveBeenCalledWith(`${ROOT}/docs/x.md`);
    expect(resolveMarkdownLink("../README.md", `${ROOT}/docs/x.md`)).toEqual({ kind: "file", path: `${ROOT}/README.md` });
  });

  it("a link to a missing file shows a plain note and opens nothing", async () => {
    const onopenpath = await render();
    clickLink("gone");
    await settle();
    expect(onopenpath).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="file-preview-link-note"]')?.textContent).toBe(
      "missing.md isn't in this project",
    );
  });

  it("an https link goes to the host opener", async () => {
    const opener = vi.fn();
    setHostOpenUrl(opener);
    const onopenpath = await render();
    const event = clickLink("site");
    expect(event.defaultPrevented).toBe(true);
    expect(opener).toHaveBeenCalledWith("https://example.com/a");
    expect(onopenpath).not.toHaveBeenCalled();
  });

  it("an anchor scrolls inside the preview", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const onopenpath = await render();
    const event = clickLink("jump");
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect((scroll.mock.contexts[0] as Element).textContent).toBe("Usage notes");
    expect(onopenpath).not.toHaveBeenCalled();
  });
});
