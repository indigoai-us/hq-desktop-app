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
  redirectToSigninWithCallback: vi.fn(),
}));

vi.mock("$lib/mesh-runtime", () => ({
  startWebMeshForAdapter: vi.fn(() => null),
}));

import { mount, tick, unmount } from "svelte";
import type { ChatSidebarApi, ConversationRow, SelfIdentity } from "@hq/ui";
import {
  SHALLOW_CACHE_KEY,
  type ShallowBrowserCache,
} from "$lib/browser-cache.js";
import { resetLiveRailHydrate } from "$lib/chat-adapter.js";
import { hqProFetch } from "$lib/hq-pro-client.js";
import Page from "../routes/+page.svelte";

type CapturedDesktopAppProps = {
  self: SelfIdentity | null;
  sidebarApi: ChatSidebarApi;
  searchRows: ConversationRow[];
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
}

function capturedProps(): CapturedDesktopAppProps {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current as unknown as CapturedDesktopAppProps;
}

function directoryRow(channelId: string, name: string) {
  return {
    channelId,
    type: "channel",
    scope: "company",
    name,
    companyUid: "cmp_live",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
  };
}

function writeRailCache(
  directory: ReturnType<typeof directoryRow>[],
  contacts: ShallowBrowserCache["contacts"] = [],
): void {
  const cache: ShallowBrowserCache = {
    personUid: "prs_web",
    savedAt: Date.now(),
    directory,
    contacts,
    lastThread: null,
    lastSelectedId: null,
  };
  localStorage.setItem(SHALLOW_CACHE_KEY, JSON.stringify(cache));
}

function stubShellRequests({
  directory = [],
  contacts = [],
  onPagedDirectory,
}: {
  directory?: ReturnType<typeof directoryRow>[];
  contacts?: ShallowBrowserCache["contacts"];
  onPagedDirectory?: () => void;
} = {}): void {
  vi.mocked(hqProFetch).mockImplementation(async (input) => {
    const url = urlOf(input);
    if (url.endsWith("/v1/identity/whoami")) {
      return response({ personUid: "prs_web", email: "web@example.com" });
    }
    if (url.endsWith("/membership/me")) return response({ memberships: [] });
    if (url.includes("/v1/notify/channels?cursor=page_2")) {
      onPagedDirectory?.();
      return response({ snapshot: false, rows: [] });
    }
    if (url.includes("/v1/notify/channels")) {
      return response({ snapshot: true, rows: directory });
    }
    if (url.includes("/v1/notify/contacts")) return response({ contacts });
    if (url.includes("/v1/notify/inbox")) return response({ events: [] });
    if (url.includes("/v1/work-mesh/work")) return response({ items: [] });
    return response({ threads: [] });
  });
}

async function mountSignedInPage(): Promise<void> {
  component = mount(Page, {
    target: host,
    props: {
      data: {
        user: {
          sub: "acct_web",
          email: "web@example.com",
          name: "Web Person",
        },
      },
    },
  });
  await tick();
  await vi.waitFor(() => {
    expect(capturedProps().self?.uid).toBe("prs_web");
  });
}

beforeEach(() => {
  desktopAppProps.current = null;
  vi.mocked(hqProFetch).mockReset();
  resetLiveRailHydrate();
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  resetLiveRailHydrate();
  vi.unstubAllGlobals();
});

describe("page sidebar rail refresh", () => {
  it("re-reads the shallow rail after the first directory page hydrates it", async () => {
    stubShellRequests({
      directory: [directoryRow("chn_initial", "Initial live channel")],
    });
    await mountSignedInPage();

    await capturedProps().sidebarApi.fetchChannelDirectory(null);

    await vi.waitFor(() => {
      expect(capturedProps().searchRows).toEqual([
        expect.objectContaining({
          id: "ch:chn_initial",
          title: "Initial live channel",
        }),
      ]);
    });
  });

  it("re-reads the shallow rail after a paginated directory page resolves", async () => {
    stubShellRequests({
      onPagedDirectory: () => {
        writeRailCache([
          directoryRow("chn_paginated", "Paginated live channel"),
        ]);
      },
    });
    await mountSignedInPage();

    await capturedProps().sidebarApi.fetchChannelDirectory("page_2");

    await vi.waitFor(() => {
      expect(capturedProps().searchRows).toEqual([
        expect.objectContaining({
          id: "ch:chn_paginated",
          title: "Paginated live channel",
        }),
      ]);
    });
  });

  it("re-reads the shallow rail after contacts hydrate it", async () => {
    stubShellRequests({
      contacts: [
        {
          personUid: "prs_contact",
          displayName: "Hydrated contact",
        },
      ],
    });
    await mountSignedInPage();

    await capturedProps().sidebarApi.listContacts();

    await vi.waitFor(() => {
      expect(capturedProps().searchRows).toEqual([
        expect.objectContaining({
          id: "dm:prs_contact",
          title: "Hydrated contact",
        }),
      ]);
    });
  });
});
