// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());
const desktopAppProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));

vi.mock("svelte", async () => {
  // @ts-expect-error happy-dom tests need Svelte's client runtime.
  return await import("../../node_modules/svelte/src/index-client.js");
});

vi.mock("@hq/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@hq/ui")>();
  return {
    ...actual,
    DesktopApp: (_anchor: Node, props: Record<string, unknown>) => {
      desktopAppProps.current = props;
    },
  };
});

vi.mock("./tauri-invoke.js", () => ({ tauriInvoke }));

vi.mock("$lib/hq-pro-client.js", () => ({
  hqProFetch: vi.fn(),
  hqProApiUrl: vi.fn(() => "https://hq-pro.test"),
  redirectToSigninWithCallback: vi.fn(),
}));

vi.mock("$lib/mesh-runtime", () => ({
  startWebMeshForAdapter: vi.fn(() => null),
}));

import { mount, tick, unmount } from "svelte";
import {
  approvedWorkExternalUrl,
  openWorkExternalUrl,
  WORK_EXTERNAL_LINK_REFUSAL_MESSAGE,
} from "./external-open.js";
import Page from "../routes/+page.svelte";

const arbitraryHttpsUrls = [
  "https://preview.example/hq-desktop",
  "https://hq-work-git-branch.vercel.app/",
  "https://github.com/indigoai-us/hq-desktop-app/pull/575/files",
  "https://hq-work-attachments.s3.us-east-1.amazonaws.com/chat/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
] as const;

type CapturedDesktopAppProps = {
  onopenurl: (url: string) => void;
};

let pageHost: HTMLDivElement | null = null;
let pageComponent: ReturnType<typeof mount> | null = null;

function capturedProps(): CapturedDesktopAppProps {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current as unknown as CapturedDesktopAppProps;
}

describe("Work external URL handoffs", () => {
  beforeEach(() => {
    tauriInvoke.mockReset();
    tauriInvoke.mockResolvedValue(undefined);
    desktopAppProps.current = null;
  });

  afterEach(async () => {
    if (pageComponent) await unmount(pageComponent);
    pageComponent = null;
    pageHost?.remove();
    pageHost = null;
    vi.restoreAllMocks();
  });

  it("refuses unsafe, malformed, non-HTTPS, and credentialed URLs before they can reach an opener", () => {
    const windowOpen = vi
      .spyOn(window, "open")
      .mockImplementation(() => null);

    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "  javascript:alert(1)",
      "http://preview.example/",
      "https://user:pass@preview.example/",
      "not a url",
    ]) {
      expect(approvedWorkExternalUrl(raw)).toBeNull();
      expect(() => openWorkExternalUrl(raw, "web")).toThrow(
        WORK_EXTERNAL_LINK_REFUSAL_MESSAGE,
      );
    }

    expect(windowOpen).not.toHaveBeenCalled();
    expect(tauriInvoke).not.toHaveBeenCalled();
  });

  it.each(arbitraryHttpsUrls)(
    "opens arbitrary HTTPS Work links on web with browser protections: %s",
    (raw) => {
      const windowOpen = vi
        .spyOn(window, "open")
        .mockImplementation(() => null);

      openWorkExternalUrl(raw, "web");

      expect(windowOpen).toHaveBeenCalledWith(
        new URL(raw).toString(),
        "_blank",
        "noopener,noreferrer",
      );
    },
  );

  it.each(arbitraryHttpsUrls)(
    "opens arbitrary HTTPS Work links through the desktop shell: %s",
    async (raw) => {
      openWorkExternalUrl(raw, "desktop");

      await vi.waitFor(() => {
        expect(tauriInvoke).toHaveBeenCalledWith("plugin:shell|open", {
          path: new URL(raw).toString(),
          with: null,
        });
      });
    },
  );

  it("surfaces a refused link through the Work page shell", async () => {
    const host = document.createElement("div");
    pageHost = host;
    document.body.appendChild(host);
    pageComponent = mount(Page, {
      target: host,
      props: { data: { user: null } },
    });
    await tick();

    capturedProps().onopenurl("javascript:alert(1)");
    await tick();

    expect(
      host.querySelector('[data-testid="external-link-error"]')?.textContent,
    ).toContain(WORK_EXTERNAL_LINK_REFUSAL_MESSAGE);
  });
});
