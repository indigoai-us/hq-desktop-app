// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ChannelFilesTab from "./ChannelFilesTab.svelte";
import type { ChannelFileItemModel } from "./channelTabModels";

const files: ChannelFileItemModel[] = [
  {
    key: "projects/demo/readme.md",
    vaultPath: "projects/demo/readme.md",
    localPath: "companies/demo/projects/readme.md",
    companyUid: "cmp_member",
    name: "readme.md",
    caption: "PROJECT",
    iconKind: "markdown",
  },
];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

describe("ChannelFilesTab", () => {
  it("loads a bounded authorized text preview and exposes explicit native actions", async () => {
    const loadPreview = vi.fn(async () => ({ kind: "text" as const, text: "# Project brief" }));
    const reveal = vi.fn(async () => ({ ok: true }));
    const open = vi.fn(async () => ({ ok: true }));

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelFilesTab, {
      target: host,
      props: {
        files,
        onloadpreview: loadPreview,
        onreveal: reveal,
        onopen: open,
      },
    });

    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();

    expect(loadPreview).toHaveBeenCalledWith(files[0]);
    expect(host.querySelector('[data-testid="channel-file-preview-text"]')?.textContent).toContain(
      "# Project brief",
    );

    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-reveal"]')?.click(),
    );
    await flush();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-open"]')?.click(),
    );
    await flush();
    expect(reveal).toHaveBeenCalledWith(files[0]);
    expect(open).toHaveBeenCalledWith(files[0]);
  });

  it("shows a truthful denied state without requesting a preview", async () => {
    const loadPreview = vi.fn(async () => ({ kind: "text" as const, text: "must not load" }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelFilesTab, {
      target: host,
      props: {
        files: [{ ...files[0]!, accessDenied: true }],
        onloadpreview: loadPreview,
      },
    });

    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();

    expect(loadPreview).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="channel-file-preview-denied"]')).not.toBeNull();
  });

  it("releases a generated media blob URL when the preview closes", async () => {
    const originalRevoke = URL.revokeObjectURL;
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    try {
      host = document.createElement("div");
      document.body.appendChild(host);
      component = mount(ChannelFilesTab, {
        target: host,
        props: {
          files,
          onloadpreview: async () => ({ kind: "image" as const, url: "blob:preview-image" }),
        },
      });

      flushSync(() =>
        host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
      );
      await flush();
      flushSync(() =>
        host.querySelector<HTMLButtonElement>('[data-testid="channel-files-preview-close"]')?.click(),
      );

      expect(revoke).toHaveBeenCalledWith("blob:preview-image");
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
