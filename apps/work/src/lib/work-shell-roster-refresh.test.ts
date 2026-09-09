// @vitest-environment happy-dom

/**
 * Regression (fresh-Mac onboarding): the desktop WorkShell fetched the company
 * roster exactly once at mount and swallowed a failure, so an owner whose
 * company was created on the website kept seeing "Create a company" until
 * they restarted. The roster must (1) retry a failed fetch on a bounded
 * backoff and (2) re-fetch when the native sync runner announces a company.
 */
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
  configureHqProApiUrl: vi.fn(),
  hqProFetch: vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
  hqProApiUrl: vi.fn(() => "https://hq-pro.test"),
  redirectToSigninWithCallback: vi.fn(),
}));

vi.mock("$lib/mesh-runtime", () => ({
  startWebMeshForAdapter: vi.fn(() => null),
}));

import { mount, unmount } from "svelte";
import type { Workspace } from "@hq/ui";
import Page from "./WorkShell.svelte";

type NativeHandler = (event: { payload: unknown }) => void;

const ACME_ROW = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "cloud-only",
  cloudUid: "cmp_acme",
  role: "owner",
  membershipStatus: "active",
  hasLocalFolder: false,
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function capturedCompanies(): Workspace[] {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current.companies as Workspace[];
}

function capturedRosterStatus(): string {
  if (!desktopAppProps.current) throw new Error("DesktopApp did not mount");
  return desktopAppProps.current.rosterStatus as string;
}

function makeHost(
  rosterResponses: Array<() => unknown>,
  whoamiResponses: Array<() => unknown> = [],
) {
  const handlers = new Map<string, NativeHandler[]>();
  const listCalls = { count: 0 };
  const whoamiCalls = { count: 0 };
  const invoke = vi.fn(async (command: string) => {
    switch (command) {
      case "get_auth_session":
        return { accountId: "acct_ada", generation: 1, status: "active" };
      case "get_auth_state":
        return { authenticated: true, accountId: "acct_ada", email: "ada@example.com" };
      case "whoami": {
        whoamiCalls.count += 1;
        const scripted = whoamiResponses.shift();
        if (scripted) return scripted();
        return { personUid: "prs_ada", email: "ada@example.com", displayName: "Ada" };
      }
      case "list_syncable_workspaces": {
        listCalls.count += 1;
        // The last scripted response is sticky, so a retry after the script
        // ends sees the same outcome instead of an accidental empty success.
        const next =
          rosterResponses.length > 1 ? rosterResponses.shift() : rosterResponses[0];
        return next ? next() : { workspaces: [] };
      }
      default:
        return null;
    }
  });
  const listen = vi.fn(async (event: string, handler: NativeHandler) => {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => {
      handlers.set(event, (handlers.get(event) ?? []).filter((h) => h !== handler));
    };
  });
  function emit(event: string, payload: unknown): void {
    for (const handler of handlers.get(event) ?? []) handler({ payload });
  }
  return { invoke, listen, emit, listCalls, whoamiCalls, handlers };
}

function mountDesktopShell(native: ReturnType<typeof makeHost>): void {
  component = mount(Page, {
    target: host,
    props: {
      data: { user: null },
      runtimeKind: "desktop",
      invoke: native.invoke as never,
      listen: native.listen as never,
      rosterRetryDelaysMs: [5, 5, 5],
    },
  });
}

beforeEach(() => {
  desktopAppProps.current = null;
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe("WorkShell company roster refresh (desktop)", () => {
  it("retries a failed first roster fetch instead of keeping an empty roster", async () => {
    const native = makeHost([
      () => {
        throw new Error("vault unreachable");
      },
      () => ({ workspaces: [ACME_ROW] }),
    ]);
    mountDesktopShell(native);

    await vi.waitFor(() => {
      expect(native.listCalls.count).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
  });

  it("re-fetches the roster when the sync runner announces a provisioned company", async () => {
    const native = makeHost([
      () => ({ workspaces: [] }),
      () => ({ workspaces: [ACME_ROW] }),
    ]);
    mountDesktopShell(native);

    await vi.waitFor(() => {
      expect(native.listCalls.count).toBe(1);
      expect(capturedCompanies()).toEqual([]);
    });
    await vi.waitFor(() => {
      expect(native.handlers.get("sync:company-provisioned")?.length ?? 0).toBeGreaterThan(0);
      expect(native.handlers.get("sync:all-complete")?.length ?? 0).toBeGreaterThan(0);
    });
    // No spontaneous refetch while nothing happened.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(native.listCalls.count).toBe(1);

    native.emit("sync:company-provisioned", {
      companyUid: "cmp_acme",
      companySlug: "acme",
      bucketName: "hq-vault-cmp-acme",
    });
    await vi.waitFor(() => {
      expect(native.listCalls.count).toBe(2);
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });

    native.emit("sync:all-complete", {
      companiesAttempted: 1,
      filesDownloaded: 0,
      bytesDownloaded: 0,
      errors: [],
    });
    await vi.waitFor(() => {
      expect(native.listCalls.count).toBe(3);
    });
  });

  it("keeps the last good roster when a later refresh fails", async () => {
    const native = makeHost([
      () => ({ workspaces: [ACME_ROW] }),
      () => {
        throw new Error("vault unreachable");
      },
    ]);
    mountDesktopShell(native);
    await vi.waitFor(() => {
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
    native.emit("sync:all-complete", { errors: [] });
    await vi.waitFor(() => {
      expect(native.listCalls.count).toBeGreaterThanOrEqual(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
  });
});

/**
 * Regression (clean-VM first sign-in): a brand-new owner signed in for the
 * first time and #welcome showed the seeded "Name your company" card even
 * though the backend had the company; a relaunch fixed it. Two silent bails
 * caused it: a null self hydration ended the bootstrap with no retry, and a
 * cloud-unreachable roster envelope read as a successful empty roster. Both
 * must retry, and the shell must say where the roster is (loading → ready |
 * failed) so #welcome never leads with "Create a company" prematurely.
 */
describe("WorkShell first sign-in roster status (desktop)", () => {
  it("reports loading, then ready once the roster lands", async () => {
    const native = makeHost([() => ({ workspaces: [ACME_ROW] })]);
    mountDesktopShell(native);
    await vi.waitFor(() => {
      expect(desktopAppProps.current).not.toBeNull();
    });
    expect(capturedRosterStatus()).toBe("loading");
    await vi.waitFor(() => {
      expect(capturedRosterStatus()).toBe("ready");
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
  });

  it("retries a transient null self hydration instead of bailing with an empty roster", async () => {
    const native = makeHost(
      [() => ({ workspaces: [ACME_ROW] })],
      [
        () => {
          throw new Error("whoami: connection reset");
        },
      ],
    );
    mountDesktopShell(native);

    await vi.waitFor(() => {
      expect(native.whoamiCalls.count).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(capturedRosterStatus()).toBe("ready");
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
    expect((desktopAppProps.current?.self as { uid: string } | null)?.uid).toBe("prs_ada");
  });

  it("treats a cloud-unreachable roster envelope as a failed fetch and retries", async () => {
    const native = makeHost([
      () => ({ workspaces: [], cloudReachable: false, error: "vault unreachable" }),
      () => ({ workspaces: [ACME_ROW], cloudReachable: true, error: null }),
    ]);
    mountDesktopShell(native);

    await vi.waitFor(() => {
      expect(native.listCalls.count).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(() => {
      expect(capturedRosterStatus()).toBe("ready");
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
  });

  it("reports failed once the retry budget is spent, and Retry re-runs the fetch", async () => {
    const native = makeHost([
      () => {
        throw new Error("vault unreachable");
      },
    ]);
    mountDesktopShell(native);

    await vi.waitFor(() => {
      expect(native.listCalls.count).toBe(4);
    });
    await vi.waitFor(() => {
      expect(capturedRosterStatus()).toBe("failed");
    });
    expect(capturedCompanies()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(native.listCalls.count).toBe(4);

    native.invoke.mockImplementation(async (command: string) => {
      if (command === "list_syncable_workspaces") {
        native.listCalls.count += 1;
        return { workspaces: [ACME_ROW] };
      }
      if (command === "whoami") {
        return { personUid: "prs_ada", email: "ada@example.com", displayName: "Ada" };
      }
      return null;
    });
    const retry = desktopAppProps.current?.onretryroster as (() => void) | undefined;
    expect(typeof retry).toBe("function");
    retry!();
    await vi.waitFor(() => {
      expect(capturedRosterStatus()).toBe("ready");
      expect(capturedCompanies().map((c) => c.cloudUid)).toEqual(["cmp_acme"]);
    });
  });
});
