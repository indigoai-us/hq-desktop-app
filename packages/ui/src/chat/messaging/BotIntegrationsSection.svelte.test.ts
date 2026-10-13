// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import BotIntegrationsSection from "./BotIntegrationsSection.svelte";
import BotIntegrationsSectionHarness from "./BotIntegrationsSectionHarness.test.svelte";

type OkResult<T> = { ok: true; value: T };
type FailResult = {
  ok: false;
  reason: string;
  code?: string;
  message?: string;
  retriable?: boolean;
};
type Result<T> = OkResult<T> | FailResult;

interface GrantInput {
  companyUid: string;
  connectionId: string;
  granteeUid: string;
}

interface Adapter {
  identity: {
    hasFeature: ReturnType<typeof vi.fn>;
  };
  integrations: {
    listConnections: ReturnType<typeof vi.fn>;
    getConnectionAccess: ReturnType<typeof vi.fn>;
    grantConnectionAccess: ReturnType<typeof vi.fn>;
    revokeConnectionAccess: ReturnType<typeof vi.fn>;
  };
}

const CONNECTIONS_ENVELOPE = {
  viewer: { personUid: "usr_me", canManageIntegrations: true },
  connections: [
    {
      id: "acct_linear",
      provider: "linear",
      status: "connected",
      createdBy: "usr_me",
      createdAt: "2026-10-10T00:00:00Z",
      installation: { displayName: "Linear" },
      access: { mode: "shared" },
    },
  ],
  audit: [],
};

function okAccess(options: {
  mode?: string;
  canManage?: boolean;
  entries?: Array<{ granteeType: string; granteeId: string; permission?: string }>;
}): OkResult<unknown> {
  return {
    ok: true,
    value: {
      access: { mode: options.mode ?? "shared" },
      canManage: options.canManage ?? true,
      entries: options.entries ?? [],
    },
  };
}

function makeAdapter(): Adapter {
  return {
    identity: {
      hasFeature: vi.fn(async () => ({ ok: true, value: true })),
    },
    integrations: {
      listConnections: vi.fn(async () => ({ ok: true, value: CONNECTIONS_ENVELOPE })),
      getConnectionAccess: vi.fn(async () =>
        okAccess({ mode: "shared", entries: [] }),
      ),
      grantConnectionAccess: vi.fn(async (_input: GrantInput) => ({
        ok: true,
        value: null,
      })),
      revokeConnectionAccess: vi.fn(async (_input: GrantInput) => ({
        ok: true,
        value: null,
      })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

interface MountOptions {
  companyUid?: string | null;
  botUid?: string | null;
  botRole?: string | null;
  adapter: Adapter;
  flagEnabled?: boolean | null;
}

function mountSection(options: MountOptions): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotIntegrationsSection, {
    target: host,
    props: {
      companyUid: options.companyUid ?? "cmp_acme",
      botUid: options.botUid ?? "agt_nova",
      botRole: options.botRole ?? "member",
      adapter: options.adapter as unknown as never,
      flagEnabled: options.flagEnabled ?? true,
    },
  });
  flushSync();
}

async function settle(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i++) {
    await Promise.resolve();
    await tick();
    flushSync();
  }
}

beforeEach(() => {
  host = document.createElement("div");
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

describe("BotIntegrationsSection: flag seam and visibility", () => {
  it("renders nothing when the flag is off", async () => {
    const adapter = makeAdapter();
    mountSection({ adapter, flagEnabled: false });
    await settle();
    expect(host.querySelector("[data-testid='bot-integrations-section']")).toBeNull();
    expect(adapter.integrations.listConnections).not.toHaveBeenCalled();
  });

  it("renders nothing when companyUid or botUid is missing, even with flag on", async () => {
    const adapter = makeAdapter();
    mountSection({ adapter, companyUid: "", flagEnabled: true });
    await settle();
    expect(host.querySelector("[data-testid='bot-integrations-section']")).toBeNull();
    expect(adapter.integrations.listConnections).not.toHaveBeenCalled();
  });

  it("renders the section and loads connections when the flag is on", async () => {
    const adapter = makeAdapter();
    mountSection({ adapter });
    await settle();
    expect(
      host.querySelector("[data-testid='bot-integrations-section']"),
    ).not.toBeNull();
    expect(adapter.integrations.listConnections).toHaveBeenCalledWith("cmp_acme");
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
    });
  });
});

describe("BotIntegrationsSection: toggle and rollback", () => {
  it("grants and reloads access when the switch is turned on", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess
      .mockResolvedValueOnce(okAccess({ entries: [] }))
      .mockResolvedValueOnce(
        okAccess({
          entries: [{ granteeType: "person", granteeId: "agt_nova", permission: "read" }],
        }),
      );

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button).not.toBeNull();
    expect(button!.getAttribute("data-state")).toBe("off");
    expect(button!.disabled).toBe(false);

    button!.click();
    await settle();

    expect(adapter.integrations.grantConnectionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.integrations.grantConnectionAccess).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeUid: "agt_nova",
    });
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledTimes(2);
    const after = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(after!.getAttribute("data-state")).toBe("on");
  });

  it("revokes when the switch is turned off", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess
      .mockResolvedValueOnce(
        okAccess({
          entries: [{ granteeType: "person", granteeId: "agt_nova", permission: "read" }],
        }),
      )
      .mockResolvedValueOnce(okAccess({ entries: [] }));

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("on");

    button!.click();
    await settle();

    expect(adapter.integrations.revokeConnectionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.integrations.revokeConnectionAccess).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeUid: "agt_nova",
    });
    const after = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(after!.getAttribute("data-state")).toBe("off");
  });

  it("shows a heal-path error without raw server text when the grant fails", async () => {
    const adapter = makeAdapter();
    adapter.integrations.grantConnectionAccess.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "http-403",
      message: "FORBIDDEN: raw server detail",
    } satisfies FailResult);

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    button!.click();
    await settle();

    const row = host.querySelector("[data-testid='bot-integrations-row']");
    expect(row).not.toBeNull();
    const alert = row!.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Could not turn this app on");
    expect(alert!.textContent).not.toContain("FORBIDDEN");
    expect(alert!.textContent).not.toContain("raw server detail");
    expect(alert!.textContent).not.toContain("http-403");

    const after = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(after!.getAttribute("data-state")).toBe("off");
    expect(after!.disabled).toBe(false);
  });

  it("shows a heal-path error when the grant throws", async () => {
    const adapter = makeAdapter();
    adapter.integrations.grantConnectionAccess.mockRejectedValueOnce(
      new Error("network boom"),
    );

    mountSection({ adapter });
    await settle();

    host
      .querySelector<HTMLButtonElement>("[data-testid='bot-integrations-switch']")!
      .click();
    await settle();

    const alert = host
      .querySelector("[data-testid='bot-integrations-row']")!
      .querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Could not update");
    expect(alert!.textContent).not.toContain("network boom");
  });
});

describe("BotIntegrationsSection: locked states", () => {
  it("locks the switch on and shows admin help text when the bot is an owner", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess.mockResolvedValueOnce(
      okAccess({ entries: [] }),
    );

    mountSection({ adapter, botRole: "owner" });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("on-admin");
    expect(button!.disabled).toBe(true);

    const help = host.querySelector("[data-testid='bot-integrations-help']");
    expect(help!.textContent).toContain("Company owners and admins already have access");
  });

  it("shows a read-only state when the caller cannot manage the connection", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess.mockResolvedValueOnce(
      okAccess({ canManage: false, entries: [] }),
    );

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("read-only");
    expect(button!.disabled).toBe(true);

    const help = host.querySelector("[data-testid='bot-integrations-help']");
    expect(help!.textContent).toContain("Ask the connection's owner");
  });
});

describe("BotIntegrationsSection: on-everyone state", () => {
  it("shows the on-everyone locked state when the connection is open to all", async () => {
    const adapter = makeAdapter();
    adapter.integrations.listConnections.mockResolvedValueOnce({
      ok: true,
      value: {
        ...CONNECTIONS_ENVELOPE,
        connections: CONNECTIONS_ENVELOPE.connections.map((c) => ({
          ...c,
          access: { mode: "everyone" },
        })),
      },
    });
    adapter.integrations.getConnectionAccess.mockResolvedValueOnce(
      okAccess({ mode: "everyone", canManage: true, entries: [] }),
    );

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button).not.toBeNull();
    expect(button!.getAttribute("data-state")).toBe("on-everyone");
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute("aria-label")).toContain("on for everyone");

    const help = host.querySelector("[data-testid='bot-integrations-help']");
    expect(help!.textContent).toContain("open to everyone in the company");
  });
});

describe("BotIntegrationsSection: revoke failure", () => {
  it("leaves the switch on and shows a friendly error when revoke fails", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess.mockResolvedValueOnce(
      okAccess({
        entries: [{ granteeType: "person", granteeId: "agt_nova", permission: "read" }],
      }),
    );
    adapter.integrations.revokeConnectionAccess.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "http-500",
      message: "SERVER BOOM: raw backend trace",
    } satisfies FailResult);

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("on");

    button!.click();
    await settle();

    const after = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(after!.getAttribute("data-state")).toBe("on");
    expect(after!.disabled).toBe(false);

    const alert = host
      .querySelector("[data-testid='bot-integrations-row']")!
      .querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Could not turn this app off");
    expect(alert!.textContent).not.toContain("SERVER BOOM");
    expect(alert!.textContent).not.toContain("raw backend trace");
    expect(alert!.textContent).not.toContain("http-500");

    // Nothing stale got written: the second getConnectionAccess call never happened.
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledTimes(1);
  });
});

describe("BotIntegrationsSection: heal path when reload fails after a successful mutation", () => {
  it("marks the row with the reopen-the-panel message when the follow-up read returns null", async () => {
    const adapter = makeAdapter();
    adapter.integrations.getConnectionAccess
      .mockResolvedValueOnce(okAccess({ entries: [] }))
      .mockResolvedValueOnce({
        ok: false,
        reason: "error",
        code: "http-502",
        message: "RAW: reload failed",
      } satisfies FailResult);

    mountSection({ adapter });
    await settle();

    const button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("off");

    button!.click();
    await settle();

    expect(adapter.integrations.grantConnectionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledTimes(2);

    const alert = host
      .querySelector("[data-testid='bot-integrations-row']")!
      .querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("Saved, but HQ could not re-read");
    expect(alert!.textContent).toContain("Reopen the panel");
    expect(alert!.textContent).not.toContain("RAW");
    expect(alert!.textContent).not.toContain("http-502");

    const after = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(after!.disabled).toBe(false);
  });
});

describe("BotIntegrationsSection: bot change under a live panel", () => {
  it("reloads rows and routes toggles to the new bot when botUid changes", async () => {
    const adapter = makeAdapter();
    // Three sequential getConnectionAccess calls: first bot (A), second bot (B)
    // after the prop change, plus the follow-up read after toggle.
    adapter.integrations.getConnectionAccess
      .mockResolvedValueOnce(
        okAccess({
          entries: [{ granteeType: "person", granteeId: "agt_a", permission: "read" }],
        }),
      )
      .mockResolvedValueOnce(okAccess({ entries: [] }))
      .mockResolvedValueOnce(
        okAccess({
          entries: [{ granteeType: "person", granteeId: "agt_b", permission: "read" }],
        }),
      );

    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(BotIntegrationsSectionHarness, {
      target: host,
      props: {
        initialCompanyUid: "cmp_acme",
        initialBotUid: "agt_a",
        initialBotRole: "member",
        initialFlagEnabled: true,
        adapter: adapter as unknown,
      },
    });
    const harness = component as unknown as {
      setBotUid: (value: string | null) => void;
    };
    flushSync();
    await settle();

    // Bot A: shared, with A on, switch reads "on".
    let button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("on");
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.integrations.listConnections).toHaveBeenCalledTimes(1);

    // Change the bot under the live panel.
    harness.setBotUid("agt_b");
    flushSync();
    await settle();

    // Reload fires: listConnections AND getConnectionAccess called again.
    expect(adapter.integrations.listConnections).toHaveBeenCalledTimes(2);
    expect(adapter.integrations.getConnectionAccess).toHaveBeenCalledTimes(2);

    // Bot B: shared, no entries → switch reads "off".
    button = host.querySelector<HTMLButtonElement>(
      "[data-testid='bot-integrations-switch']",
    );
    expect(button!.getAttribute("data-state")).toBe("off");

    // Toggling now must target bot B, not bot A.
    button!.click();
    await settle();

    expect(adapter.integrations.grantConnectionAccess).toHaveBeenCalledTimes(1);
    expect(adapter.integrations.grantConnectionAccess).toHaveBeenCalledWith({
      companyUid: "cmp_acme",
      connectionId: "acct_linear",
      granteeUid: "agt_b",
    });
  });
});

describe("BotIntegrationsSection: list failure", () => {
  it("shows a heal-path error without raw server text when the list fails", async () => {
    const adapter = makeAdapter();
    adapter.integrations.listConnections.mockResolvedValueOnce({
      ok: false,
      reason: "error",
      code: "http-500",
      message: "INTERNAL: raw backend detail",
    } satisfies FailResult);

    mountSection({ adapter });
    await settle();

    const error = host.querySelector("[data-testid='bot-integrations-error']");
    expect(error).not.toBeNull();
    expect(error!.textContent).toContain("could not load connected apps");
    expect(error!.textContent).not.toContain("INTERNAL");
    expect(error!.textContent).not.toContain("http-500");
    expect(error!.textContent).not.toContain("raw backend detail");
  });
});
