// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { nativeInvoke, tauriListen } = vi.hoisted(() => ({
  nativeInvoke: vi.fn(),
  tauriListen: vi.fn(),
}));

const desktopAppProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
  mounts: 0,
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
      desktopAppProps.mounts += 1;
    },
  };
});

vi.mock("$lib/tauri-invoke.js", () => ({ tauriInvoke: nativeInvoke }));
vi.mock("$lib/tauri-listen.js", () => ({ tauriListen }));
vi.mock("$lib/hq-pro-client.js", () => ({
  hqProFetch: vi.fn(),
  hqProApiUrl: vi.fn(() => "https://hq-pro.test"),
  redirectToSigninWithCallback: vi.fn(),
}));
vi.mock("$lib/mesh-runtime", () => ({
  startWebMeshForAdapter: vi.fn(() => null),
}));

import { mount, tick, unmount } from "svelte";
import type {
  ChannelStatusModel,
  ConversationRow,
  SelfIdentity,
  Workspace,
} from "@hq/ui";
import { hqProFetch } from "$lib/hq-pro-client.js";
import Page from "./+page.svelte";

type AuthStatus =
  | "active"
  | "credentials_absent"
  | "credentials_invalid"
  | "refresh_temporarily_unavailable";
type AuthSession = {
  accountId: string | null;
  generation: number;
  status: AuthStatus;
};
type NativeResponse = { status: number; body: string };
type CapturedDesktopAppProps = {
  self: SelfIdentity | null;
  companies: Workspace[];
  tenantAccountId: string | null;
  tenantGeneration: number;
  channelStatusByRow: (row: ConversationRow) => ChannelStatusModel | null;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let accountId: string | null;
let initialSession: AuthSession;
let authSessionHandler: ((event: { payload: unknown }) => void) | null;
let listWorkspaceCalls: string[];
let identityQueries: string[];
let whoamiForAccount: (account: string) => NativeResponse | Promise<NativeResponse>;
let workspacesForAccount: (account: string) => unknown | Promise<unknown>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function workspace(account: string): Record<string, string> {
  return {
    companyUid: `cmp_${account}`,
    companyName: `Company ${account}`,
    role: "member",
    status: "active",
  };
}

function nativeWhoami(account: string): NativeResponse {
  return {
    status: 200,
    body: JSON.stringify({
      personUid: `prs_${account}`,
      email: `${account}@example.com`,
      displayName: `Person ${account}`,
    }),
  };
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function capturedProps(): CapturedDesktopAppProps {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current as unknown as CapturedDesktopAppProps;
}

function projectRow(account: string): ConversationRow {
  return {
    id: `ch:chn_${account}`,
    kind: "channel",
    title: `Project ${account}`,
    companyUid: `cmp_${account}`,
    unreadDot: false,
    lastActivityAt: 0,
    pinned: false,
    channelId: `chn_${account}`,
    channelScope: "project",
    projectId: `project_${account}`,
  };
}

function makeDesktopRuntime(): void {
  Object.defineProperty(window, "__TAURI__", {
    configurable: true,
    value: { core: { invoke: nativeInvoke } },
  });
}

function clearDesktopRuntime(): void {
  delete (window as Window & { __TAURI__?: unknown }).__TAURI__;
}

async function mountDesktop(): Promise<void> {
  makeDesktopRuntime();
  component = mount(Page, { target: host, props: { data: { user: null } } });
  await tick();
  await vi.waitFor(() => expect(authSessionHandler).not.toBeNull());
}

function emitAuthSession(next: AuthSession): void {
  accountId = next.status === "active" ? next.accountId : null;
  if (!authSessionHandler) throw new Error("auth session listener was not registered");
  authSessionHandler({ payload: next });
}

beforeEach(() => {
  desktopAppProps.current = null;
  desktopAppProps.mounts = 0;
  localStorage.clear();
  accountId = "acct_a";
  initialSession = {
    accountId: "acct_a",
    generation: 1,
    status: "active",
  };
  authSessionHandler = null;
  listWorkspaceCalls = [];
  identityQueries = [];
  whoamiForAccount = nativeWhoami;
  workspacesForAccount = (account) => ({ workspaces: [workspace(account)] });
  nativeInvoke.mockReset();
  tauriListen.mockReset();
  vi.mocked(hqProFetch).mockReset();
  nativeInvoke.mockImplementation(async (command, args) => {
    if (command === "get_auth_session") return initialSession;
    if (command === "get_auth_state") {
      identityQueries.push("get_auth_state");
      return accountId
        ? { authenticated: true, accountId }
        : { authenticated: false };
    }
    if (command === "hq_pro_fetch") {
      const url = (args?.url as string | undefined) ?? "";
      if (url === "/v1/identity/whoami" && accountId) {
        identityQueries.push("whoami");
        return whoamiForAccount(accountId);
      }
    }
    if (command === "list_syncable_workspaces") {
      const account = accountId ?? "signed_out";
      listWorkspaceCalls.push(account);
      return workspacesForAccount(account);
    }
    throw new Error(`Unexpected native command: ${command}`);
  });
  tauriListen.mockImplementation(async (event, handler) => {
    if (event === "auth:session-changed") {
      authSessionHandler = handler as (event: { payload: unknown }) => void;
    }
    return vi.fn();
  });
  vi.mocked(hqProFetch).mockImplementation(async (input) => {
    const url = new URL(String(input), "https://hq-pro.test");
    const companyUid = url.searchParams.get("companyUid");
    const status = url.searchParams.get("status");
    const account = companyUid?.replace(/^cmp_/, "") ?? "unknown";
    return response({
      threads:
        status === "in-progress"
          ? [
              {
                threadId: `thread_${account}`,
                project: `project_${account}`,
                status: "progress",
                actor: `agt_${account}`,
                title: `Task ${account}`,
              },
            ]
          : [],
    });
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
  localStorage.clear();
  clearDesktopRuntime();
  vi.unstubAllGlobals();
});

describe("native desktop auth session transitions", () => {
  it("seeds the conversation cache into the literal tenant-scoped key", async () => {
    const tenantCacheKey =
      "hq.work.tenant.v1.acct_a.all.hq.chat.conversation-cache";
    const bareCacheKey = "hq.chat.conversation-cache";
    localStorage.setItem(
      "hq.web.rail-cache.v4",
      JSON.stringify({
        personUid: "prs_acct_a",
        savedAt: Date.now(),
        directory: [
          {
            channelId: "chn_seeded",
            scope: "project",
            name: "Seeded project",
            lastActivityAt: null,
          },
        ],
        contacts: [],
        lastThread: null,
        lastSelectedId: null,
      }),
    );

    await mountDesktop();

    await vi.waitFor(() => expect(localStorage.length).toBe(2));
    const seededConversationKey = Array.from(
      { length: localStorage.length },
      (_, index) => localStorage.key(index),
    ).find((key) => key?.endsWith("hq.chat.conversation-cache"));

    expect(seededConversationKey).toBe(tenantCacheKey);
    expect(localStorage.getItem(bareCacheKey)).toBeNull();
  });

  it("remounts the desktop shell only for a real auth-session transition", async () => {
    await mountDesktop();
    const initialMounts = desktopAppProps.mounts;

    await vi.waitFor(() => expect(capturedProps().self?.uid).toBe("prs_acct_a"));
    expect(desktopAppProps.mounts).toBe(initialMounts);

    emitAuthSession({
      accountId: "acct_b",
      generation: 2,
      status: "active",
    });
    await vi.waitFor(() => expect(desktopAppProps.mounts).toBe(initialMounts + 1));
  });

  it("clears the old tenant synchronously and hydrates the new active tenant", async () => {
    await mountDesktop();
    await vi.waitFor(() => {
      expect(capturedProps().self?.uid).toBe("prs_acct_a");
      expect(capturedProps().companies.map((company) => company.cloudUid)).toEqual([
        "cmp_acct_a",
      ]);
      expect(
        capturedProps()
          .channelStatusByRow(projectRow("acct_a"))
          ?.liveAgents.map((agent) => agent.id),
      ).toContain("thread_acct_a");
    });

    const nextWhoami = deferred<NativeResponse>();
    whoamiForAccount = (account) =>
      account === "acct_b" ? nextWhoami.promise : nativeWhoami(account);

    emitAuthSession({
      accountId: "acct_b",
      generation: 2,
      status: "active",
    });
    await tick();

    expect(capturedProps().tenantAccountId).toBe("acct_b");
    expect(capturedProps().tenantGeneration).toBe(2);
    expect(capturedProps().self).toBeNull();
    expect(capturedProps().companies).toEqual([]);
    expect(
      capturedProps()
        .channelStatusByRow(projectRow("acct_a"))
        ?.liveAgents.map((agent) => agent.id) ?? [],
    ).not.toContain("thread_acct_a");

    nextWhoami.resolve(nativeWhoami("acct_b"));
    await vi.waitFor(() => {
      expect(capturedProps().self?.uid).toBe("prs_acct_b");
      expect(capturedProps().companies.map((company) => company.cloudUid)).toEqual([
        "cmp_acct_b",
      ]);
      expect(listWorkspaceCalls).toContain("acct_b");
    });
  });

  it("clears state for credentials_absent without starting identity hydration", async () => {
    await mountDesktop();
    await vi.waitFor(() => expect(capturedProps().self?.uid).toBe("prs_acct_a"));
    const identityQueriesBefore = identityQueries.length;

    emitAuthSession({
      accountId: null,
      generation: 2,
      status: "credentials_absent",
    });
    await tick();

    expect(capturedProps().tenantAccountId).toBeNull();
    expect(capturedProps().tenantGeneration).toBe(2);
    expect(capturedProps().self).toBeNull();
    expect(capturedProps().companies).toEqual([]);
    expect(identityQueries).toHaveLength(identityQueriesBefore);
    expect(listWorkspaceCalls).not.toContain("signed_out");
  });

  it("ignores a stale session envelope without changing state", async () => {
    initialSession = {
      accountId: "acct_a",
      generation: 5,
      status: "active",
    };
    await mountDesktop();
    await vi.waitFor(() => {
      expect(capturedProps().tenantGeneration).toBe(5);
      expect(capturedProps().self?.uid).toBe("prs_acct_a");
    });
    const identityQueriesBefore = identityQueries.length;

    emitAuthSession({ accountId: "acct_b", generation: 4, status: "active" });
    await tick();

    expect(capturedProps().tenantAccountId).toBe("acct_a");
    expect(capturedProps().tenantGeneration).toBe(5);
    expect(capturedProps().self?.uid).toBe("prs_acct_a");
    expect(identityQueries).toHaveLength(identityQueriesBefore);
  });

  it("does not re-query identity for a duplicate active envelope", async () => {
    await mountDesktop();
    await vi.waitFor(() => expect(capturedProps().self?.uid).toBe("prs_acct_a"));
    const identityQueriesBefore = identityQueries.length;

    emitAuthSession({
      accountId: "acct_a",
      generation: 1,
      status: "active",
    });
    await tick();

    expect(identityQueries).toHaveLength(identityQueriesBefore);
    expect(capturedProps().self?.uid).toBe("prs_acct_a");
  });

  it("discards a slow older-generation roster after a newer tenant arrives", async () => {
    await mountDesktop();
    await vi.waitFor(() => expect(capturedProps().self?.uid).toBe("prs_acct_a"));
    const slowBWorkspace = deferred<unknown>();
    workspacesForAccount = (account) =>
      account === "acct_b"
        ? slowBWorkspace.promise
        : { workspaces: [workspace(account)] };

    emitAuthSession({
      accountId: "acct_b",
      generation: 2,
      status: "active",
    });
    await vi.waitFor(() => expect(listWorkspaceCalls).toContain("acct_b"));

    emitAuthSession({
      accountId: "acct_c",
      generation: 3,
      status: "active",
    });
    await vi.waitFor(() => {
      expect(capturedProps().self?.uid).toBe("prs_acct_c");
      expect(capturedProps().companies.map((company) => company.cloudUid)).toEqual([
        "cmp_acct_c",
      ]);
    });

    slowBWorkspace.resolve({ workspaces: [workspace("acct_b")] });
    // A macrotask turn drains the entire microtask queue, including the stale
    // lane's continuation. Draining a fixed number of microtasks instead would
    // let the assertions run before the stale write and pass by luck.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(capturedProps().tenantGeneration).toBe(3);
    expect(capturedProps().self?.uid).toBe("prs_acct_c");
    expect(capturedProps().companies.map((company) => company.cloudUid)).toEqual([
      "cmp_acct_c",
    ]);
  });

  it("unsubscribes safely and tolerates a rejected listener registration", async () => {
    const unlisten = vi.fn(() => {
      throw new Error("late native teardown failure");
    });
    tauriListen.mockImplementationOnce(async (event, handler) => {
      if (event === "auth:session-changed") {
        authSessionHandler = handler as (event: { payload: unknown }) => void;
      }
      return unlisten;
    });
    await mountDesktop();
    if (component) await expect(unmount(component)).resolves.toBeUndefined();
    component = null;
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledOnce();

    tauriListen.mockRejectedValueOnce(new Error("event bridge unavailable"));
    authSessionHandler = null;
    component = mount(Page, { target: host, props: { data: { user: null } } });
    await tick();
    if (component) await expect(unmount(component)).resolves.toBeUndefined();
    component = null;
  });

  it("never registers a native listener for the web adapter", async () => {
    clearDesktopRuntime();
    component = mount(Page, { target: host, props: { data: { user: null } } });
    await tick();

    expect(tauriListen).not.toHaveBeenCalled();
  });
});
