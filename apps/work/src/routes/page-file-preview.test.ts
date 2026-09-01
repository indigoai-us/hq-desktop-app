// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("$lib/hq-pro-client.js", () => ({
  hqProFetch: vi.fn(),
  hqProApiUrl: vi.fn(() => "https://hq-pro.test"),
}));

import { mount, unmount } from "svelte";
import type { ChannelFileItemModel, ConversationRow } from "@hq/ui";
import Page from "./+page.svelte";
import { hqProFetch } from "$lib/hq-pro-client.js";

const selectedRow: ConversationRow = {
  id: "ch:cmp_a",
  kind: "channel",
  title: "Company A",
  companyUid: "cmp_a",
  unreadDot: false,
  lastActivityAt: 0,
  pinned: false,
  channelId: "chn_cmp_a",
  channelScope: "company",
};

const otherCompanyFile: ChannelFileItemModel = {
  key: "projects/other/brief.md",
  vaultPath: "projects/other/brief.md",
  companyUid: "cmp_b",
  name: "brief.md",
  caption: "PROJECT",
  iconKind: "markdown",
};

type CapturedDesktopAppProps = {
  loadFilePreview: (item: ChannelFileItemModel) => Promise<unknown>;
  onselectrow: (row: ConversationRow) => void;
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function capturedProps(): CapturedDesktopAppProps {
  return desktopAppProps.current as unknown as CapturedDesktopAppProps;
}

beforeEach(() => {
  vi.mocked(hqProFetch).mockReset();
  desktopAppProps.current = null;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(Page, { target: host, props: { data: { user: null } } });
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.unstubAllGlobals();
});

describe("web Vault file preview company scope", () => {
  it("denies a file from another company before issuing a presign request", async () => {
    const props = capturedProps();
    props.onselectrow(selectedRow);

    await expect(props.loadFilePreview(otherCompanyFile)).resolves.toMatchObject({
      kind: "unavailable",
      state: "denied",
    });
    expect(hqProFetch).toHaveBeenCalledTimes(0);
  });

  it("previews a file from the selected company", async () => {
    const props = capturedProps();
    props.onselectrow(selectedRow);
    vi.mocked(hqProFetch).mockResolvedValue(
      new Response(
        JSON.stringify({ results: [{ url: "https://vault.test/brief.md" }] }),
        { status: 200 },
      ),
    );
    const fetchMock = vi.fn(async () =>
      new Response("# Company A brief", {
        status: 200,
        headers: { "content-type": "text/markdown" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      props.loadFilePreview({ ...otherCompanyFile, companyUid: "cmp_a" }),
    ).resolves.toEqual({ kind: "text", text: "# Company A brief" });
    expect(hqProFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://vault.test/brief.md");
  });
});
