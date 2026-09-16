// @vitest-environment happy-dom

/**
 * Settings → Bots after a reinstall.
 *
 * `hq bot list` only knows this Mac, so a bot the account owns simply vanished
 * from this pane once its local half was gone — the person had no way to see
 * that it still existed, let alone bring it back. `hq bot list --remote` puts
 * those bots in their own group with the one action that fixes them, and
 * re-offers the restore a person may have turned down at launch.
 *
 * Rows that DO run here are untouched: same markup, same Start/Stop/Remove.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter, type RemoteBotRow } from "@hq/platform";

import BotsSettingsPane from "./BotsSettingsPane.svelte";

const HERE: LocalBotRow = {
  name: "assistant",
  agentUid: "agt_here",
  ownerUid: "prs_me",
  runtime: "claude",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: new Date().toISOString(),
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/assistant",
};

function remote(over: Partial<RemoteBotRow> = {}): RemoteBotRow {
  return {
    name: "scout",
    agentUid: "agt_scout",
    kind: "personal",
    online: false,
    lastHeartbeatAt: null,
    here: false,
    settings: "claude, synced memory",
    ...over,
  };
}

function fakeAdapter(bots: Partial<NonNullable<PlatformAdapter["bots"]>> = {}): PlatformAdapter {
  return {
    kind: "tauri",
    isAvailable: () => false,
    capabilities: {},
    agents: { listMobileRoster: vi.fn(async () => ok({ agents: [] })) },
    sessions: {},
    bots: {
      list: vi.fn(async () => ok({ bots: [HERE] })),
      create: vi.fn(async () => ok({})),
      start: vi.fn(async () => ok({})),
      stop: vi.fn(async () => ok({})),
      remove: vi.fn(async () => ok({})),
      listRemote: vi.fn(async () => ok({ bots: [remote({ name: "assistant", agentUid: "agt_here", here: true })] })),
      adopt: vi.fn(async () => ok({ ok: true })),
      restore: vi.fn(async () =>
        ok({ ok: true, dryRun: false, restored: 0, repaired: 0, skipped: 0, failed: 0, bots: [] }),
      ),
      ...bots,
    },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function mountPane(adapter: PlatformAdapter): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotsSettingsPane, { target: host, props: { adapter, companies: null } });
  await tick();
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

describe("bots that live on another computer", () => {
  it("get their own row with a Start here, and the rows already here are unchanged", async () => {
    const adopt = vi.fn(async () => ok({ ok: true }));
    await mountPane(
      fakeAdapter({
        adopt,
        listRemote: vi.fn(async () =>
          ok({
            bots: [remote({ name: "assistant", agentUid: "agt_here", here: true }), remote()],
          }),
        ),
      }),
    );
    await settle(14);

    // The bot that runs here keeps exactly the row it always had.
    expect(q('[data-testid="settings-bot-assistant"]')).toBeTruthy();
    // The one that does not is no longer invisible.
    const row = q('[data-testid="settings-remote-bot-scout"]');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("Set up on another computer");
    // It is listed once, in the elsewhere group — not as a local row.
    expect(q('[data-testid="settings-bot-scout"]')).toBeNull();

    q<HTMLButtonElement>('[data-testid="settings-remote-bot-scout-start"]')!.click();
    await settle(14);
    expect(adopt).toHaveBeenCalledWith("scout");
  });

  it("re-offers the restore a person turned down at launch", async () => {
    const restore = vi.fn(async () =>
      ok({
        ok: true,
        dryRun: false,
        restored: 1,
        repaired: 0,
        skipped: 0,
        failed: 0,
        bots: [{ name: "scout", agentUid: "agt_scout", action: "restored" as const, detail: "claude" }],
      }),
    );
    await mountPane(fakeAdapter({ restore, listRemote: vi.fn(async () => ok({ bots: [remote()] })) }));
    await settle(14);

    const button = q<HTMLButtonElement>('[data-testid="settings-bots-restore-all"]');
    expect(button?.textContent).toContain("Restore my bots");
    button!.click();
    await settle(16);

    expect(restore).toHaveBeenCalledWith({ all: true });
    expect(q('[data-testid="settings-bots-restore-result"]')?.textContent).toContain(
      "One bot is back on this computer.",
    );
    expect(q('[data-testid="settings-bots-restore-row-scout"]')?.textContent).toContain("is back");
  });

  it("says nothing extra when every owned bot is already here", async () => {
    await mountPane(fakeAdapter());
    await settle(14);
    expect(q('[data-testid="settings-bots-elsewhere"]')).toBeNull();
  });

  it("never renders the CLI's own words when a bring-back fails", async () => {
    const adopt = vi.fn(async () => ({
      ok: false as const,
      reason: "unavailable" as const,
      message: 'HQ API /v1/agents/agt_scout/credentials → 403: {"code":"NOT_OWNER"}',
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountPane(
      fakeAdapter({ adopt: adopt as never, listRemote: vi.fn(async () => ok({ bots: [remote()] })) }),
    );
    await settle(14);

    q<HTMLButtonElement>('[data-testid="settings-remote-bot-scout-start"]')!.click();
    await settle(14);

    const status = q('[data-testid="settings-bots-status"]');
    expect(status?.textContent).toContain("Could not bring scout back to this Mac");
    expect(status?.textContent).not.toContain("403");
    expect(status?.textContent).not.toContain("/v1/");
  });

  it("stays quiet on a host with no remote listing at all (older app, web build)", async () => {
    const adapter = fakeAdapter();
    // An older host simply has no such command.
    delete (adapter.bots as Record<string, unknown>).listRemote;
    delete (adapter.bots as Record<string, unknown>).adopt;
    delete (adapter.bots as Record<string, unknown>).restore;
    await mountPane(adapter);
    await settle(14);
    expect(q('[data-testid="settings-bots-elsewhere"]')).toBeNull();
    expect(q('[data-testid="settings-bot-assistant"]')).toBeTruthy();
  });
});
