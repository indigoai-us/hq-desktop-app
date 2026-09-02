// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import workPackage from "../../package.json";

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
import type { PlatformAdapter } from "@hq/platform";
import type {
  BoardTabData,
  ChatSidebarApi,
  ChannelStatusModel,
  ConversationRow,
  SelfIdentity,
} from "@hq/ui";
import { displayVersion } from "$lib/version.js";
import {
  hqProFetch,
  redirectToSigninWithCallback,
} from "$lib/hq-pro-client.js";
import { resetLiveRailHydrate } from "$lib/chat-adapter.js";
import { tenantStorageKey } from "../../../../packages/ui/src/identity/tenant-storage.js";
import Page from "../lib/WorkShell.svelte";

type CapturedDesktopAppProps = {
  self: SelfIdentity | null;
  version: string;
  tenantAccountId: string | null;
  sidebarApi: ChatSidebarApi;
  searchRows: ConversationRow[];
  channelStatusByRow: (row: ConversationRow) => ChannelStatusModel | null;
  boardByRow: (row: ConversationRow) => BoardTabData | null;
  adapter: PlatformAdapter;
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function capturedProps(): CapturedDesktopAppProps {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current as unknown as CapturedDesktopAppProps;
}

function row(projectId: string, companyUid = "cmp_a"): ConversationRow {
  return {
    id: `ch:chn_${projectId}`,
    kind: "channel",
    title: projectId,
    companyUid,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: `chn_${projectId}`,
    channelScope: "project",
    projectId,
  };
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input.toString();
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
}

describe("hosted Work shell identity and tenancy", () => {
  it("wires the page adapter's 401 handler to the callback-preserving redirect", async () => {
    vi.mocked(hqProFetch).mockResolvedValue(
      response({ error: "Unauthenticated" }, 401),
    );

    await mountSignedInPage();
    vi.mocked(redirectToSigninWithCallback).mockClear();
    await capturedProps().adapter.identity.whoami();

    expect(redirectToSigninWithCallback).toHaveBeenCalledTimes(1);
  });

  it("uses the verified person uid instead of the Cognito account subject", async () => {
    vi.mocked(hqProFetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v1/identity/whoami")) {
        return response({
          personUid: "prs_web",
          email: "web@example.com",
          displayName: "Web Person",
        });
      }
      if (url.endsWith("/membership/me")) return response({ memberships: [] });
      return response({ threads: [] });
    });

    await mountSignedInPage();

    await vi.waitFor(() => {
      expect(capturedProps().self?.uid).toBe("prs_web");
    });
    expect(vi.mocked(hqProFetch)).toHaveBeenCalledWith(
      "https://hq-pro.test/v1/identity/whoami",
      expect.any(Object),
    );
  });

  it("passes the Cognito account subject into the tenant storage partition", async () => {
    vi.mocked(hqProFetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v1/identity/whoami")) {
        return response({ personUid: "prs_web", email: "web@example.com" });
      }
      if (url.endsWith("/membership/me")) return response({ memberships: [] });
      return response({ threads: [] });
    });

    await mountSignedInPage();

    expect(capturedProps().tenantAccountId).toBe("acct_web");
    expect(
      tenantStorageKey(
        { accountId: "acct_web", companyId: "cmp_a" },
        "hq.chat.dm-inbox-since",
      ),
    ).not.toBe(
      tenantStorageKey(
        { accountId: "acct_web", companyId: "cmp_b" },
        "hq.chat.dm-inbox-since",
      ),
    );
  });

  it("updates command-palette rows after an empty-cache rail hydration", async () => {
    vi.mocked(hqProFetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v1/identity/whoami")) {
        return response({ personUid: "prs_web", email: "web@example.com" });
      }
      if (url.endsWith("/membership/me")) return response({ memberships: [] });
      if (url.includes("/v1/notify/channels")) {
        return response({
          snapshot: true,
          rows: [
            {
              channelId: "chn_live",
              type: "channel",
              scope: "company",
              name: "Live project",
              companyUid: "cmp_live",
              lastActivityAt: "2026-09-01T00:00:00.000Z",
            },
          ],
        });
      }
      if (url.includes("/v1/notify/contacts")) return response({ contacts: [] });
      if (url.includes("/v1/notify/inbox")) return response({ events: [] });
      if (url.includes("/v1/work-mesh/work")) return response({ items: [] });
      return response({ threads: [] });
    });

    await mountSignedInPage();
    await vi.waitFor(() => {
      expect(capturedProps().self?.uid).toBe("prs_web");
    });
    expect(capturedProps().searchRows).toEqual([]);

    await capturedProps().sidebarApi.fetchChannelDirectory(null);

    await vi.waitFor(() => {
      expect(capturedProps().searchRows).toEqual([
        expect.objectContaining({ id: "ch:chn_live", title: "Live project" }),
      ]);
    });
  });
});

describe("hosted Work shell fallback status", () => {
  it("does not surface a same-project work thread from another company", async () => {
    vi.mocked(hqProFetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v1/identity/whoami")) {
        return response({ personUid: "prs_web", email: "web@example.com" });
      }
      if (url.endsWith("/membership/me")) {
        return response({
          memberships: [
            { companyUid: "cmp_a", companyName: "Company A", role: "member" },
            { companyUid: "cmp_b", companyName: "Company B", role: "member" },
          ],
        });
      }
      if (url.includes("/v1/work-mesh/threads?")) {
        const companyUid = new URL(url, "https://hq-pro.test").searchParams.get(
          "companyUid",
        );
        return response({
          threads:
            companyUid === "cmp_a"
              ? [
                  {
                    threadId: "thread-a",
                    project: "shared-project",
                    status: "progress",
                    actor: "agt_company_a",
                    title: "Company A task",
                  },
                ]
              : companyUid === "cmp_b"
                ? [
                    {
                      threadId: "thread-b",
                      project: "shared-project",
                      status: "blocked",
                      actor: "agt_company_b",
                      title: "Company B task",
                    },
                  ]
                : [],
        });
      }
      return response([]);
    });

    await mountSignedInPage();
    await vi.waitFor(() => {
      expect(vi.mocked(hqProFetch)).toHaveBeenCalledWith(
        expect.stringContaining("companyUid=cmp_b"),
      );
    });

    const status = capturedProps().channelStatusByRow(row("shared-project"));
    expect(status?.liveAgents.map((agent) => agent.id)).toContain("thread-a");
    expect(status?.liveAgents.map((agent) => agent.id)).not.toContain("thread-b");
  });
});

describe("hosted Work project metadata retry", () => {
  it("retries a transient project-meta failure and caches the recovered response", async () => {
    let viewRequests = 0;
    vi.mocked(hqProFetch).mockImplementation(async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/v1/identity/whoami")) {
        return response({ personUid: "prs_web", email: "web@example.com" });
      }
      if (url.endsWith("/membership/me")) return response({ memberships: [] });
      if (url.includes("/v1/work-mesh/projects/retry-project")) {
        viewRequests += 1;
        if (viewRequests === 1) throw new Error("temporary upstream failure");
        return response({
          companyUid: "cmp_a",
          projectId: "retry-project",
          name: "Recovered project",
          stories: [{ id: "US-1", title: "Recovered", status: "queued" }],
          repos: [],
          files: [],
        });
      }
      if (url.includes("/work-sessions") || url.includes("/members")) {
        return response([]);
      }
      return response({ threads: [] });
    });

    await mountSignedInPage();
    const project = row("retry-project");

    expect(capturedProps().boardByRow(project)).toBeNull();
    await vi.waitFor(() => expect(viewRequests).toBe(1));
    await tick();

    await vi.waitFor(() => {
      expect(capturedProps().boardByRow(project)).toBeNull();
      expect(viewRequests).toBe(2);
    });
    await vi.waitFor(() => {
      expect(capturedProps().boardByRow(project)?.stories["US-1"]?.title).toBe(
        "Recovered",
      );
    });
  });
});

describe("hosted Work shell version", () => {
  it("hands DesktopApp the package-derived display version", async () => {
    vi.mocked(hqProFetch).mockImplementation(async () => response({ threads: [] }));
    component = mount(Page, { target: host, props: { data: { user: null } } });
    expect(capturedProps().version).toBe(
      displayVersion(`v${workPackage.version}`),
    );
  });
});
