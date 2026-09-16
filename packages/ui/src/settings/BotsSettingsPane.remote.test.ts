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
import {
  ok,
  type LocalBotRow,
  type LocalBotsApi,
  type PlatformAdapter,
  type RemoteBotRow,
} from "@hq/platform";

import BotsSettingsPane from "./BotsSettingsPane.svelte";
import {
  BOT_RESTORE_CLOUD_UNREACHABLE,
  BOT_RESTORE_NEEDS_NEWER_CLOUD,
} from "../chat/bot-restore.js";

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

/**
 * Every test here mounts the pane against a host that HAS the local-bots
 * group, so the fake pins `bots` as present. That is what lets a test drop an
 * optional command (`listRemote`, `adopt`, `restore`) to play an older host
 * without casting the real adapter away.
 */
type FakeAdapter = PlatformAdapter & { bots: LocalBotsApi };

function fakeAdapter(bots: Partial<LocalBotsApi> = {}): FakeAdapter {
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
  } as unknown as FakeAdapter;
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
      fakeAdapter({ adopt, listRemote: vi.fn(async () => ok({ bots: [remote()] })) }),
    );
    await settle(14);

    q<HTMLButtonElement>('[data-testid="settings-remote-bot-scout-start"]')!.click();
    await settle(14);

    const status = q('[data-testid="settings-bots-status"]');
    expect(status?.textContent).toContain("Could not bring scout back to this Mac");
    expect(status?.textContent).not.toContain("403");
    expect(status?.textContent).not.toContain("/v1/");
  });

  it("explains itself instead of going blank when HQ Cloud cannot list them", async () => {
    // The owner's VM: production HQ Cloud has no listing route, so the pane
    // simply showed nothing at all — no rows, no restore, no reason.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () => ({
          ok: false as const,
          reason: "error" as const,
          message: "HQ API /v1/agents/mine → 404: Not found",
        })),
      }),
    );
    await settle(14);

    const card = q('[data-testid="settings-bots-remote-unavailable"]');
    expect(card?.textContent).toContain(BOT_RESTORE_NEEDS_NEWER_CLOUD);
    expect(card?.textContent).not.toContain("404");
    expect(card?.textContent).not.toContain("/v1/");
    // Nothing that could not work is offered, and nothing is claimed about
    // any bot: the rows this Mac DOES have are exactly as before.
    expect(q('[data-testid="settings-bots-restore-all"]')).toBeNull();
    expect(q('[data-testid="settings-bots-remote-recheck"]'), "no retry for a route that is absent").toBeNull();
    expect(q('[data-testid="settings-bot-assistant"]')).toBeTruthy();
  });

  it("reads the real CLI's failure document, and offers no Check again (defect 4)", async () => {
    // VERBATIM from the VM: the failing CLI writes this document on stdout and
    // the same sentence on stderr. Settings showed the network sentence AND a
    // "Check again" button for a route this HQ Cloud does not have.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () => ({
          ok: false as const,
          reason: "error" as const,
          message: JSON.stringify({
            ok: false,
            reason: "server-unsupported",
            message:
              "Your HQ Cloud cannot list the bots you own yet, so there is nothing to bring back from here. Update HQ Cloud, or try again later.",
            bots: [],
          }),
        })),
      }),
    );
    await settle(14);

    const card = q('[data-testid="settings-bots-remote-unavailable"]');
    expect(card?.textContent).toContain(BOT_RESTORE_NEEDS_NEWER_CLOUD);
    expect(card?.textContent).not.toContain(BOT_RESTORE_CLOUD_UNREACHABLE);
    expect(card?.textContent).not.toContain("Update HQ Cloud");
    expect(q('[data-testid="settings-bots-remote-recheck"]'), "no retry for a route that is absent").toBeNull();
    expect(q('[data-testid="settings-bots-restore-all"]')).toBeNull();
    expect(q('[data-testid="settings-bot-assistant"]')).toBeTruthy();
  });

  it("reads the CLI's sentence the same way when only stderr reaches the pane", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () => ({
          ok: false as const,
          reason: "error" as const,
          message:
            "Your HQ Cloud cannot list the bots you own yet, so there is nothing to bring back from here. Update HQ Cloud, or try again later.",
        })),
      }),
    );
    await settle(14);
    expect(q('[data-testid="settings-bots-remote-unavailable"]')?.textContent).toContain(
      BOT_RESTORE_NEEDS_NEWER_CLOUD,
    );
    expect(q('[data-testid="settings-bots-remote-recheck"]')).toBeNull();
  });

  it("still offers Check again when the CLI's document says network", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () => ({
          ok: false as const,
          reason: "error" as const,
          message: JSON.stringify({
            ok: false,
            reason: "network",
            message: "HQ Cloud could not be reached just now.",
            bots: [],
          }),
        })),
      }),
    );
    await settle(14);
    expect(q('[data-testid="settings-bots-remote-unavailable"]')?.textContent).toContain(
      BOT_RESTORE_CLOUD_UNREACHABLE,
    );
    expect(q('[data-testid="settings-bots-remote-recheck"]')).toBeTruthy();
  });

  it("offers Check again when the listing could not be reached, and recovers", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let reachable = false;
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () =>
          reachable
            ? ok({ bots: [remote()] })
            : {
                ok: false as const,
                reason: "error" as const,
                message: "hq bot list --remote did not finish within 60s",
              },
        ),
      }),
    );
    await settle(14);
    expect(q('[data-testid="settings-bots-remote-unavailable"]')?.textContent).toContain(
      BOT_RESTORE_CLOUD_UNREACHABLE,
    );

    reachable = true;
    q<HTMLButtonElement>('[data-testid="settings-bots-remote-recheck"]')!.click();
    await settle(16);
    expect(q('[data-testid="settings-bots-remote-unavailable"]')).toBeNull();
    expect(q('[data-testid="settings-remote-bot-scout-start"]')).toBeTruthy();
  });

  it("stays quiet on a host with no remote listing at all (older app, web build)", async () => {
    const adapter = fakeAdapter();
    // An older host simply has no such command.
    delete adapter.bots.listRemote;
    delete adapter.bots.adopt;
    delete adapter.bots.restore;
    await mountPane(adapter);
    await settle(14);
    expect(q('[data-testid="settings-bots-elsewhere"]')).toBeNull();
    expect(q('[data-testid="settings-bot-assistant"]')).toBeTruthy();
  });
});

/**
 * ROUND 4 — Defect 7 and Observation B.
 *
 * The banner is one-shot, so after the first adopt the person's only remaining
 * way back was per-bot, through each DM. Settings is the durable home for it:
 * the "On another computer" section stands as long as the account owns a bot
 * this Mac could run, with the same restore the banner offered.
 *
 * And it must offer it only for bots this Mac CAN run. `hq bot restore`
 * brought a company bot back as a personal local bot, credentialed it, gave it
 * a startup agent, counted it as restored — and its runtime refused it at
 * every login, under a Settings card telling the person to check a sign-in
 * that six sibling bots were already online on.
 */
describe("the durable restore home in Settings", () => {
  it("keeps the section and its Restore my bots after a bot has been brought back", async () => {
    // Two owned bots away; one comes back. The banner is gone by now — this
    // section is the only entry point left, and it stays.
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () =>
          ok({
            bots: [
              remote({ name: "assistant", agentUid: "agt_here", here: true }),
              remote(),
              remote({ name: "setup", agentUid: "agt_setup" }),
            ],
          }),
        ),
      }),
    );
    await settle(14);

    expect(q('[data-testid="settings-bots-elsewhere"]')).toBeTruthy();
    expect(q('[data-testid="settings-bots-restore-all"]')?.textContent).toContain("Restore my bots");
    expect(q('[data-testid="settings-remote-bot-scout"]')).toBeTruthy();
    expect(q('[data-testid="settings-remote-bot-setup"]')).toBeTruthy();
    // The per-bot action says exactly what the DM's does.
    expect(q('[data-testid="settings-remote-bot-scout-start"]')?.textContent).toContain(
      "Start on this computer",
    );
  });

  it("never offers to bring a company bot back, and never counts it", async () => {
    const adopt = vi.fn(async () => ok({ ok: true }));
    await mountPane(
      fakeAdapter({
        adopt,
        listRemote: vi.fn(async () =>
          ok({
            bots: [remote(), remote({ name: "cobot", agentUid: "agt_cobot", kind: "company" })],
          }),
        ),
      }),
    );
    await settle(14);

    expect(q('[data-testid="settings-remote-bot-scout"]')).toBeTruthy();
    expect(q('[data-testid="settings-remote-bot-cobot"]'), "a company bot is not brought back").toBeNull();
    expect(q('[data-testid="settings-remote-bot-cobot-start"]')).toBeNull();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("reads the CLI's runnable marker when it sends one", async () => {
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () =>
          ok({
            bots: [
              remote({ name: "cobot", agentUid: "agt_cobot", runnable: false, reason: "company-bot" }),
              remote({ name: "scout", agentUid: "agt_scout", runnable: true }),
            ],
          }),
        ),
      }),
    );
    await settle(14);
    expect(q('[data-testid="settings-remote-bot-scout"]')).toBeTruthy();
    expect(q('[data-testid="settings-remote-bot-cobot"]')).toBeNull();
  });

  it("drops the section when the only bot away is one this Mac can never run", async () => {
    await mountPane(
      fakeAdapter({
        listRemote: vi.fn(async () =>
          ok({ bots: [remote({ name: "cobot", agentUid: "agt_cobot", kind: "company" })] }),
        ),
      }),
    );
    await settle(14);
    expect(q('[data-testid="settings-bots-elsewhere"]')).toBeNull();
  });

  it("says a refused bring-back is permanent instead of 'please try again'", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adopt = vi.fn(async () => ({
      ok: false as const,
      reason: "error" as const,
      message: '{"ok":false,"reason":"not-runnable-here","message":"cobot is a company bot"}',
    }));
    await mountPane(
      fakeAdapter({ adopt, listRemote: vi.fn(async () => ok({ bots: [remote()] })) }),
    );
    await settle(14);

    q<HTMLButtonElement>('[data-testid="settings-remote-bot-scout-start"]')!.click();
    await settle(14);

    const status = q('[data-testid="settings-bots-status"]');
    expect(status?.textContent).toContain("runs in HQ Cloud");
    expect(status?.textContent).not.toContain("Please try again");
    expect(status?.textContent).not.toContain("not-runnable-here");
  });
});

describe("the one sentence under a bot that stopped", () => {
  const STOPPED: LocalBotRow = {
    ...HERE,
    name: "cobot",
    agentUid: "agt_cobot",
    state: "failed",
    pid: null,
    processAlive: false,
    online: false,
  };

  it("does not blame a sign-in for a bot whose identity cannot run here", async () => {
    // The VM's card: "Check that Claude Code is signed in, then start it
    // again" — on a bot that could never run, while six siblings were online
    // on that very sign-in.
    await mountPane(
      fakeAdapter({
        list: vi.fn(async () => ok({ bots: [STOPPED] })),
        listRemote: vi.fn(async () =>
          ok({ bots: [remote({ name: "cobot", agentUid: "agt_cobot", kind: "company", here: true })] }),
        ),
      }),
    );
    await settle(14);

    const sentence = q('[data-testid="settings-bot-cobot-stopped"]')?.textContent ?? "";
    expect(sentence).toContain("This bot runs in HQ Cloud, not on this Mac.");
    expect(sentence).not.toContain("signed in");
  });

  it("keeps the sign-in sentence for a bot whose runtime really needs one", async () => {
    await mountPane(
      fakeAdapter({
        list: vi.fn(async () =>
          ok({
            bots: [
              {
                ...STOPPED,
                name: "scout",
                agentUid: "agt_scout",
                runtimeSignIn: { state: "expired" as const, runtime: "claude" as const, since: new Date().toISOString() },
              } as LocalBotRow,
            ],
          }),
        ),
        listRemote: vi.fn(async () =>
          ok({ bots: [remote({ name: "scout", agentUid: "agt_scout", here: true })] }),
        ),
      }),
    );
    await settle(14);

    expect(q('[data-testid="settings-bot-scout-stopped"]')?.textContent).toContain(
      "Check that Claude Code is signed in",
    );
  });

  it("claims nothing it cannot know when the account listing has not been read", async () => {
    await mountPane(
      fakeAdapter({
        list: vi.fn(async () => ok({ bots: [STOPPED] })),
        listRemote: undefined,
      }),
    );
    await settle(14);

    const sentence = q('[data-testid="settings-bot-cobot-stopped"]')?.textContent ?? "";
    expect(sentence).toContain("stopped after repeated errors");
    expect(sentence).not.toContain("signed in");
    expect(sentence).not.toContain("HQ Cloud");
  });
});
