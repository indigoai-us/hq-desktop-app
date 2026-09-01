// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import ChannelFilesTab from "./ChannelFilesTab.svelte";
import ChannelFilesTabHarness from "./ChannelFilesTabHarness.svelte";
import type { ChannelFileItemModel, ChannelFilePreview } from "./channelTabModels";

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
    const reveal = vi.fn(async () => ({ ok: true }));
    const open = vi.fn(async () => ({ ok: true }));
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ChannelFilesTab, {
      target: host,
      props: {
        files: [{ ...files[0]!, accessDenied: true }],
        onloadpreview: loadPreview,
        onreveal: reveal,
        onopen: open,
      },
    });

    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();

    expect(loadPreview).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="channel-file-preview-denied"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="channel-file-reveal"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-file-open"]')).toBeNull();
  });

  it("does not offer local actions when the host rejects the file in the current context", async () => {
    const loadPreview = vi.fn(async () => ({ kind: "text" as const, text: "must not load" }));
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
        onauthorizeaction: () => false,
      },
    });

    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();

    expect(host.querySelector('[data-testid="channel-file-reveal"]')).toBeNull();
    expect(host.querySelector('[data-testid="channel-file-open"]')).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
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

  it("invalidates and releases a late preview when a live refresh removes its file", async () => {
    const originalRevoke = URL.revokeObjectURL;
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const deferredPreview: {
      resolve: ((preview: ChannelFilePreview) => void) | null;
    } = { resolve: null };
    try {
      host = document.createElement("div");
      document.body.appendChild(host);
      const harness = mount(ChannelFilesTabHarness, {
        target: host,
        props: {
          onloadpreview: () =>
            new Promise<ChannelFilePreview>((resolve) => {
              deferredPreview.resolve = resolve;
            }),
        },
      });
      flushSync(() => harness.replaceFiles(files));
      await flush();

      flushSync(() =>
        host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
      );
      await flush();
      expect(host.querySelector('[data-testid="channel-file-preview-loading"]')).not.toBeNull();

      flushSync(() => harness.replaceFiles([]));
      await flush();
      expect(host.querySelector('[data-testid="channel-files-preview"]')).toBeNull();

      const resolvePreview = deferredPreview.resolve;
      if (!resolvePreview) throw new Error("Preview request did not start.");
      resolvePreview({ kind: "image", url: "blob:stale-preview" });
      await flush();
      expect(revoke).toHaveBeenCalledWith("blob:stale-preview");
      await unmount(harness);
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it.each([
    ["account", "account-a|cmp_member|chn_demo", "account-b|cmp_member|chn_demo", files],
    ["conversation", "account-a|cmp_member|chn_demo", "account-a|cmp_member|chn_other", files],
    [
      "company",
      "account-a|cmp_member|chn_demo",
      "account-a|cmp_other|chn_demo",
      [{ ...files[0]!, companyUid: "cmp_other" }],
    ],
  ])(
    "invalidates a same-key deferred preview when its %s context changes",
    async (_scope, initialContext, nextContext, nextFiles) => {
      const originalRevoke = URL.revokeObjectURL;
      const revoke = vi.fn();
      URL.revokeObjectURL = revoke;
      const deferredPreview: {
        resolve: ((preview: ChannelFilePreview) => void) | null;
      } = { resolve: null };
      try {
        host = document.createElement("div");
        document.body.appendChild(host);
        component = mount(ChannelFilesTabHarness, {
          target: host,
          props: {
            onloadpreview: () =>
              new Promise<ChannelFilePreview>((resolve) => {
                deferredPreview.resolve = resolve;
              }),
          },
        });
        flushSync(() => {
          component?.replaceFiles(files);
          component?.replacePreviewContext(initialContext);
        });
        await flush();
        flushSync(() =>
          host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
        );
        await flush();

        flushSync(() => {
          component?.replaceFiles(nextFiles);
          component?.replacePreviewContext(nextContext);
        });
        await flush();
        expect(host.querySelector('[data-testid="channel-files-preview"]')).toBeNull();

        const resolvePreview = deferredPreview.resolve;
        if (!resolvePreview) throw new Error("Preview request did not start.");
        resolvePreview({ kind: "image", url: `blob:stale-${_scope}` });
        await flush();
        expect(revoke).toHaveBeenCalledWith(`blob:stale-${_scope}`);
      } finally {
        URL.revokeObjectURL = originalRevoke;
      }
    },
  );

  it("does not surface an account A action failure after account B reopens the same file", async () => {
    const accountAAction = {
      reject: null as ((reason?: unknown) => void) | null,
    };
    const reveal = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          accountAAction.reject = reject;
        }),
    );

    host = document.createElement("div");
    document.body.appendChild(host);
    const harness = mount(ChannelFilesTabHarness, {
      target: host,
      props: {
        onloadpreview: async () => ({ kind: "text", text: "Account-scoped brief" }),
        onreveal: reveal,
      },
    });

    flushSync(() => {
      harness.replaceFiles(files);
      harness.replacePreviewContext("account-a|cmp_member|chn_demo");
    });
    await flush();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-reveal"]')?.click(),
    );
    expect(reveal).toHaveBeenCalledTimes(1);

    flushSync(() => harness.replacePreviewContext("account-b|cmp_member|chn_demo"));
    await flush();
    flushSync(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
    );
    await flush();

    const reject = accountAAction.reject;
    if (!reject) throw new Error("Account A action did not start.");
    reject(new Error("Account A access was revoked"));
    await flush();

    expect(host.querySelector('[data-testid="channel-file-action-error"]')).toBeNull();
    expect(
      host.querySelector('[data-testid="channel-file-preview-text"]')?.textContent,
    ).toContain("Account-scoped brief");
    await unmount(harness);
  });

  it("releases a deferred blob preview that resolves after component teardown", async () => {
    const originalRevoke = URL.revokeObjectURL;
    const revoke = vi.fn();
    URL.revokeObjectURL = revoke;
    const deferredPreview: {
      resolve: ((preview: ChannelFilePreview) => void) | null;
    } = { resolve: null };
    try {
      host = document.createElement("div");
      document.body.appendChild(host);
      component = mount(ChannelFilesTab, {
        target: host,
        props: {
          files,
          previewContext: "account-a|cmp_member|chn_demo",
          onloadpreview: () =>
            new Promise<ChannelFilePreview>((resolve) => {
              deferredPreview.resolve = resolve;
            }),
        },
      });
      flushSync(() =>
        host.querySelector<HTMLButtonElement>('[data-testid="channel-file-row"]')?.click(),
      );
      await flush();

      const mounted = component;
      component = null;
      if (mounted) await unmount(mounted);
      const resolvePreview = deferredPreview.resolve;
      if (!resolvePreview) throw new Error("Preview request did not start.");
      resolvePreview({ kind: "pdf", url: "blob:late-after-unmount" });
      await flush();
      expect(revoke).toHaveBeenCalledWith("blob:late-after-unmount");
    } finally {
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
