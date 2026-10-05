// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import BotsSettingsPane from "./BotsSettingsPane.svelte";
import { cloudBotsFromRoster, cloudBotStatusLabel } from "./cloud-bots.js";

const CLOUD_UID = "agt_374A1JY3NE63KSYBN97PND4QGC";
const OTHER_UID = "agt_0000000000000000000000OTHR";

const LOCAL_BOT: LocalBotRow = {
  name: "assistant",
  agentUid: "agt_LOCAL000000000000000000001",
  ownerUid: "prs_me",
  runtime: "claude",
  model: "opus",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: new Date().toISOString(),
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/tmp/HQ/personal/workers/assistant",
};

const ROSTER = {
  agents: [
    {
      agentUid: CLOUD_UID,
      uid: CLOUD_UID,
      companyUid: "cmp_indigo",
      name: "izzy",
      displayName: "Izzy",
      status: "ready",
      setupPhase: "ready",
    },
    {
      agentUid: OTHER_UID,
      uid: OTHER_UID,
      companyUid: "cmp_other",
      name: "rex",
      displayName: "Rex",
      status: "provisioning",
      setupPhase: "provisioning",
    },
  ],
};

const COMPANIES = [
  {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_indigo",
    role: "owner",
    membershipStatus: "active",
  },
  {
    slug: "other",
    displayName: "Other Co",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_other",
    role: "member",
    membershipStatus: "active",
  },
] as unknown as NonNullable<Parameters<typeof cloudBotsFromRoster>[1]>["companies"];

function fakeAdapter(input: {
  bots?: Partial<NonNullable<PlatformAdapter["bots"]>> | null;
  agents?: Partial<PlatformAdapter["agents"]>;
}): PlatformAdapter {
  const agents = {
    listMobileRoster: vi.fn(async () => ok(ROSTER)),
    stop: vi.fn(async () => ok({})),
    start: vi.fn(async () => ok({})),
    deprovision: vi.fn(async () => ok({})),
    ...input.agents,
  };
  const bots =
    input.bots === null
      ? undefined
      : {
          list: vi.fn(async () => ok({ bots: [LOCAL_BOT] })),
          create: vi.fn(async () => ok({})),
          start: vi.fn(async () => ok({})),
          stop: vi.fn(async () => ok({})),
          remove: vi.fn(async () => ok({})),
          ...input.bots,
        };
  return {
    kind: bots ? "tauri" : "web",
    isAvailable: () => false,
    capabilities: {},
    agents,
    bots,
    sessions: {},
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function mountPane(adapter: PlatformAdapter, extra: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(BotsSettingsPane, {
    target: host,
    props: { adapter, companies: COMPANIES as never, ...extra },
  });
  await tick();
}

/** Let the flow's effects and the pane's awaits land. */
async function settleFlow(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: resolve! };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Settings → Bots (Work shell)", () => {
  it("is a first-class ShellSettings nav item on desktop, right after AI tools", () => {
    const shell = readFileSync(
      join(import.meta.dirname, "ShellSettings.svelte"),
      "utf8",
    );
    expect(shell).toContain('{ id: "bots", label: "Bots" }');
    expect(shell.indexOf('{ id: "bots"')).toBeGreaterThan(shell.indexOf('{ id: "agents"'));
    expect(shell).toContain("BotsSettingsPane");
    expect(shell).toContain(
      'if (section.id === "bots") return Boolean(adapter?.bots || adapter?.agents);',
    );
  });

  it("drives every local action through the adapter's desktop-only bots group", () => {
    const pane = readFileSync(
      join(import.meta.dirname, "BotsSettingsPane.svelte"),
      "utf8",
    );
    for (const call of ["api.list()", "api.create(input)", "api[verb](name)"]) {
      expect(pane).toContain(call);
    }
    expect(pane).not.toContain("@tauri-apps");
    expect(pane).not.toContain("fetch(");
  });

  it("New bot opens the same three-step flow the sidebar uses and creates through the adapter", async () => {
    const create = vi.fn(async () => ok({}));
    const adapter = fakeAdapter({ bots: { create, workers: vi.fn(async () => ok({ workers: [] })) } });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-create-button"]')).not.toBeNull();
    });

    host.querySelector<HTMLButtonElement>('[data-testid="settings-bots-create-button"]')!.click();
    await settleFlow();
    expect(host.querySelector('[data-testid="settings-bots-create-dialog"]')).not.toBeNull();
    // The flow itself, not a one-off form.
    expect(host.querySelector('[data-testid="create-bot-kind-step"]')).not.toBeNull();

    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]')!.click();
    await settleFlow();
    expect(host.querySelector('[data-testid="create-bot-home-step"]')).not.toBeNull();
    host.querySelector<HTMLButtonElement>('[data-testid="create-bot-next"]')!.click();
    await settleFlow();
    // "assistant" is taken by the bot already on this Mac, so the flow moved on.
    expect(host.querySelector<HTMLInputElement>('[data-testid="chat-bot-name"]')?.value).toBe("scout");

    host.querySelector<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.click();
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith({ name: "scout", runtime: "claude", autoApprove: true });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-create-dialog"]')).toBeNull();
    });
    expect(host.querySelector('[data-testid="settings-bots-status"]')?.textContent).toContain("scout");
  });

  it("with a host modal, New bot opens the shared Messages modal instead of its own dialog", async () => {
    const onnewbot = vi.fn();
    const adapter = fakeAdapter({ bots: { workers: vi.fn(async () => ok({ workers: [] })) } });
    await mountPane(adapter, { onnewbot });
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-create-button"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>('[data-testid="settings-bots-create-button"]')!.click();
    await settleFlow();
    expect(onnewbot).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="settings-bots-create-dialog"]')).toBeNull();
    expect(host.querySelector('[data-testid="create-bot-kind-step"]')).toBeNull();
  });

  it("labels a local bot with its display name, falling back to the handle", async () => {
    window.localStorage.setItem(
      "hq.bot-display-names.v1",
      JSON.stringify({ [LOCAL_BOT.agentUid]: "Dr Love" }),
    );
    try {
      const adapter = fakeAdapter({});
      await mountPane(adapter);
      await vi.waitFor(() => {
        expect(host.querySelector('[data-testid="settings-bot-assistant-label"]')).not.toBeNull();
      });
      // The row is still keyed by the handle; only the label changes.
      expect(host.querySelector('[data-testid="settings-bot-assistant-label"]')?.textContent).toBe("Dr Love");
    } finally {
      window.localStorage.removeItem("hq.bot-display-names.v1");
    }
  });

  it("renders the Local group from adapter.bots and the Cloud group from adapter.agents", async () => {
    const adapter = fakeAdapter({});
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bot-assistant"]')).not.toBeNull();
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).not.toBeNull();
    });
    // QA-080: one scoped request per company, never the unscoped all-company scan.
    expect(adapter.agents.listMobileRoster).toHaveBeenCalledWith("cmp_indigo");
    expect(adapter.agents.listMobileRoster).toHaveBeenCalledWith("cmp_other");
    expect(adapter.agents.listMobileRoster).not.toHaveBeenCalledWith(null);

    const local = host.querySelector('[data-testid="settings-bots-local"]')!;
    // No display name stored → the row reads as its handle, as it always did.
    expect(local.querySelector('[data-testid="settings-bot-assistant-label"]')?.textContent).toBe("assistant");
    expect(local.textContent).toContain("assistant");
    expect(local.textContent).toContain("Claude Code");
    expect(local.querySelector('[data-testid="settings-bots-create"]')).not.toBeNull();
    const localChip = local.querySelector('[data-testid="settings-bot-assistant"] [data-testid="bot-kind-chip"]');
    expect(localChip?.getAttribute("data-kind")).toBe("local");
    expect(localChip?.textContent?.trim()).toBe("Local · Claude Code");

    const cloud = host.querySelector('[data-testid="settings-bots-cloud"]')!;
    const izzy = cloud.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)!;
    expect(izzy.textContent).toContain("Izzy");
    expect(izzy.textContent).toContain("Indigo");
    expect(izzy.textContent).toContain("Idle");
    expect(izzy.querySelector('[data-testid="bot-kind-chip"]')?.getAttribute("data-kind")).toBe("cloud");
    // Owner of Indigo → can manage Izzy.
    expect(izzy.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`)).not.toBeNull();
    expect(izzy.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`)).not.toBeNull();
    // Plain member of Other Co → read-only row, plain-word status.
    const rex = cloud.querySelector(`[data-testid="settings-cloud-bot-${OTHER_UID}"]`)!;
    expect(rex.textContent).toContain("Other Co");
    expect(rex.textContent).toContain("Setting up");
    expect(rex.querySelector("button")).toBeNull();
  });

  it("labels each local bot's kind in the list, and nothing for rows without one (bot-kinds)", async () => {
    const adapter = fakeAdapter({
      bots: {
        list: vi.fn(async () =>
          ok({
            bots: [
              { ...LOCAL_BOT, name: "buddy", agentUid: "agt_LOCAL000000000000000000002", kind: "personal" as const },
              { ...LOCAL_BOT, name: "scout", agentUid: "agt_LOCAL000000000000000000003", kind: "company" as const, companies: ["indigo", "ridge"] },
              LOCAL_BOT,
            ],
          }),
        ),
      },
    });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bot-scout-kind"]')).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="settings-bot-buddy-kind"]')?.textContent).toBe("Personal · acts as you");
    expect(host.querySelector('[data-testid="settings-bot-scout-kind"]')?.textContent).toBe("Company · indigo, ridge");
    expect(host.querySelector('[data-testid="settings-bot-assistant-kind"]')).toBeNull();
  });

  function removeDialog(): HTMLElement {
    const dialog = document.querySelector<HTMLElement>('[data-testid="settings-bot-remove-dialog"]');
    expect(dialog).not.toBeNull();
    return dialog!;
  }

  function removeConfirm(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="settings-bot-remove-dialog-confirm"]');
    expect(button).not.toBeNull();
    return button!;
  }

  it("opens a themed removal dialog and returns focus when Escape cancels", async () => {
    const adapter = fakeAdapter({});
    await mountPane(adapter);
    const remove = await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(el).not.toBeNull();
      return el!;
    });
    remove.focus();
    remove.click();
    await tick();
    expect(document.querySelector('[data-testid="card-modal-title"]')?.textContent).toBe("Say goodbye to Izzy?");
    expect(removeDialog().textContent).toContain("Izzy runs on its own cloud machine");
    expect(document.querySelector('[data-testid="settings-bot-remove-dialog-keep"]')?.textContent).toBe("Keep Izzy");
    expect(removeConfirm().textContent).toBe("Remove Izzy");
    expect(document.querySelector('[data-testid="settings-bot-remove-dialog-avatar"]')?.textContent).toBe("I");
    expect(document.querySelector<HTMLElement>('[data-testid="card-modal"]')?.dataset.appearance).toBe("surface");
    expect(document.querySelectorAll('.card-modal-art')).toHaveLength(2);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await tick();
    expect(document.querySelector('[data-testid="settings-bot-remove-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(remove);
  });

  it("confirms cloud removal, switches the same dialog for a protected machine, and sends its id", async () => {
    const instanceId = "i-0abc1234def567890";
    const deprovision = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, reason: "error" as const, code: "AGENTS_V2_BOX_PROTECTED", instanceId })
      .mockResolvedValueOnce(ok({}));
    await mountPane(fakeAdapter({ agents: { deprovision } }));
    (await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(button).not.toBeNull();
      return button!;
    })).click();
    await tick();
    removeConfirm().click();
    await vi.waitFor(() => expect(removeDialog().dataset.machine).toBe("true"));
    expect(removeDialog().textContent).toContain("runs on its own cloud machine");
    expect(deprovision).toHaveBeenLastCalledWith(CLOUD_UID);
    removeConfirm().click();
    await vi.waitFor(() => expect(deprovision).toHaveBeenLastCalledWith(CLOUD_UID, { confirmDestroyInstanceId: instanceId }));
    await vi.waitFor(() => expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).toBeNull());
  });

  it("keeps the dialog open while removing and leaves a friendly retry in it on failure", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<NonNullable<PlatformAdapter["agents"]>["deprovision"]>>>>();
    const deprovision = vi.fn(() => pending.promise);
    await mountPane(fakeAdapter({ agents: { deprovision } }));
    (await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(button).not.toBeNull();
      return button!;
    })).click();
    await tick();
    removeConfirm().click();
    await vi.waitFor(() => {
      expect(removeConfirm().textContent).toBe("Removing Izzy…");
      expect(document.querySelector<HTMLButtonElement>('[data-testid="settings-bot-remove-dialog-keep"]')?.disabled).toBe(true);
      expect(removeConfirm().disabled).toBe(true);
    });
    pending.resolve({ ok: false as const, reason: "error" as const, message: "raw transport failure" });
    await vi.waitFor(() =>
      expect(removeDialog().querySelector('[data-testid="card-modal-status"]')?.textContent?.trim()).toBe(
        "Couldn't remove Izzy. Check your connection and try again.",
      ),
    );
    // The line names the cause; only the button says "Try again".
    expect(removeDialog().textContent).not.toContain("Try again");
    expect(removeDialog().textContent).not.toContain("raw transport failure");
    expect(removeConfirm().textContent).toBe("Try again");
    expect(removeConfirm().classList.contains("is-danger")).toBe(true);
    expect(removeConfirm().disabled).toBe(false);
    expect(document.querySelector<HTMLButtonElement>('[data-testid="settings-bot-remove-dialog-keep"]')?.disabled).toBe(false);
    removeConfirm().click();
    await vi.waitFor(() => expect(deprovision).toHaveBeenCalledTimes(2));
  });

  it("keeps the full bot name accessible while constraining a long dialog action label", async () => {
    const longName = "Scout with an exceptionally long name that must not stretch the dialog";
    const adapter = fakeAdapter({
      agents: {
        listMobileRoster: vi.fn(async () =>
          ok({ agents: [{ ...ROSTER.agents[0], displayName: longName }] }),
        ),
      },
    });
    await mountPane(adapter);
    (await vi.waitFor(() => {
      const button = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(button).not.toBeNull();
      return button!;
    })).click();
    await tick();
    expect(document.querySelector('[data-testid="card-modal-title"]')?.textContent).toBe(`Say goodbye to ${longName}?`);
    expect(removeConfirm().getAttribute("aria-label")).toBe(`Remove ${longName}`);
    // One truncating label per button, so the words keep a single space and
    // the ellipsis comes from the label's own overflow.
    expect(removeConfirm().querySelectorAll(".remove-dialog-button-label")).toHaveLength(1);
    expect(removeConfirm().querySelector(".remove-dialog-button-label")?.textContent).toBe(`Remove ${longName}`);
    const keep = document.querySelector<HTMLButtonElement>('[data-testid="settings-bot-remove-dialog-keep"]')!;
    expect(keep.querySelector(".remove-dialog-button-label")?.textContent).toBe(`Keep ${longName}`);
    // Both actions share one row container.
    expect(keep.parentElement).toBe(removeConfirm().parentElement);
    expect(keep.parentElement?.classList.contains("remove-dialog-actions")).toBe(true);
  });

  it("uses the same roster avatar in the row and removal dialog", async () => {
    const avatarUrl = "data:image/png;base64,AA==";
    const adapter = fakeAdapter({
      agents: {
        listMobileRoster: vi.fn(async () =>
          ok({ agents: [{ ...ROSTER.agents[0], displayName: "Scout", avatarUrl }] }),
        ),
      },
    });
    await mountPane(adapter);
    const rowAvatar = await vi.waitFor(() => {
      const image = host.querySelector<HTMLImageElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}"] .bot-avatar`);
      expect(image).not.toBeNull();
      return image!;
    });
    host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`)!.click();
    await tick();
    const dialogAvatar = document.querySelector<HTMLImageElement>('[data-testid="settings-bot-remove-dialog-avatar"] img');
    expect(dialogAvatar?.getAttribute("src")).toBe(rowAvatar.getAttribute("src"));
  });

  it("uses the same dialog for local removal and hides the row after a successful refresh", async () => {
    let localBots = [LOCAL_BOT];
    const remove = vi.fn(async () => ok({}));
    await mountPane(fakeAdapter({ bots: { list: vi.fn(async () => ok({ bots: localBots })), remove } }));
    const row = await vi.waitFor(() => {
      const element = host.querySelector<HTMLElement>(`[data-testid="settings-bot-${LOCAL_BOT.name}"]`);
      expect(element).not.toBeNull();
      return element!;
    });
    row.querySelector<HTMLButtonElement>(`[data-testid="settings-bot-${LOCAL_BOT.name}-remove"]`)!.click();
    await tick();
    expect(removeDialog().textContent).toContain("assistant will stop working and leave your bots.");
    localBots = [];
    removeConfirm().click();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledWith(LOCAL_BOT.name));
    await vi.waitFor(() => expect(host.querySelector(`[data-testid="settings-bot-${LOCAL_BOT.name}"]`)).toBeNull());
  });

  it("keeps pause and resume failures on the cloud bot row", async () => {
    const stop = vi.fn(async () => ({ ok: false as const, reason: "error" as const }));
    const adapter = fakeAdapter({ agents: { stop } });
    await mountPane(adapter);

    (await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`);
      expect(el).not.toBeNull();
      return el!;
    })).click();
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-action-status"]`)?.textContent).toBe("Could not pause Izzy. Try again.");
    });

    const start = vi.fn(async () => ({ ok: false as const, reason: "error" as const }));
    const resumeAdapter = fakeAdapter({ agents: { stop: vi.fn(async () => ok({})), start } });
    await unmount(component!);
    component = null;
    host.remove();
    await mountPane(resumeAdapter);
    (await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`);
      expect(el).not.toBeNull();
      return el!;
    })).click();
    (await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-resume"]`);
      expect(el).not.toBeNull();
      return el!;
    })).click();
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}-action-status"]`)?.textContent).toBe("Could not resume Izzy. Try again.");
    });
  });

  it("treats a 404 cloud delete as already removed", async () => {
    const deprovision = vi.fn(async () => ({ ok: false as const, reason: "error" as const, status: 404 }));
    const adapter = fakeAdapter({ agents: { deprovision } });
    await mountPane(adapter);

    (await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(el).not.toBeNull();
      return el!;
    })).click();
    await tick();
    removeConfirm().click();
    await vi.waitFor(() => expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).toBeNull());
  });

  it("shows Removing in the same dialog after the protected-machine confirmation", async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<NonNullable<PlatformAdapter["agents"]>["deprovision"]>>>>();
    const deprovision = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        reason: "error" as const,
        code: "AGENTS_V2_BOX_PROTECTED",
        instanceId: "i-0abc1234def567890",
      })
      .mockImplementationOnce(() => pending.promise);
    const adapter = fakeAdapter({ agents: { deprovision } });
    await mountPane(adapter);

    (await vi.waitFor(() => {
      const el = host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`);
      expect(el).not.toBeNull();
      return el!;
    })).click();
    await tick();
    removeConfirm().click();
    const confirm = await vi.waitFor(() => {
      expect(removeDialog().dataset.machine).toBe("true");
      return removeConfirm();
    });
    confirm.click();
    await vi.waitFor(() => expect(confirm.textContent).toBe("Removing Izzy…"));
    pending.resolve(ok({}));
    await vi.waitFor(() => expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).toBeNull());
  });

  it("shows a row again when a later roster still contains the removed bot", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const adapter = fakeAdapter({});
      await mountPane(adapter);
      await settleFlow();

      host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-remove"]`)!.click();
      await tick();
      removeConfirm().click();
      await settleFlow();
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).toBeNull();

      await vi.advanceTimersByTimeAsync(60_000);
      await settleFlow();
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears successful start, stop, pause, and resume notes after a few seconds", async () => {
    const adapter = fakeAdapter({});
    await mountPane(adapter);
    vi.useFakeTimers();
    try {
      const localRow = await vi.waitFor(() => {
        const el = host.querySelector(`[data-testid="settings-bot-${LOCAL_BOT.name}"]`);
        expect(el).not.toBeNull();
        return el!;
      });
      localRow.querySelector<HTMLButtonElement>("button")!.click();
      await settleFlow();
      expect(localRow.textContent).toContain("Stopped.");
      await vi.advanceTimersByTimeAsync(4_000);
      await settleFlow();
      expect(localRow.textContent).not.toContain("Stopped.");

      await unmount(component!);
      component = null;
      host.remove();
      await mountPane(
        fakeAdapter({
          bots: { list: vi.fn(async () => ok({ bots: [{ ...LOCAL_BOT, processAlive: false }] })) },
        }),
      );
      const stoppedLocalRow = await vi.waitFor(() => {
        const el = host.querySelector(`[data-testid="settings-bot-${LOCAL_BOT.name}"]`);
        expect(el).not.toBeNull();
        return el!;
      });
      stoppedLocalRow.querySelector<HTMLButtonElement>("button")!.click();
      await settleFlow();
      expect(stoppedLocalRow.textContent).toContain("Started.");
      await vi.advanceTimersByTimeAsync(4_000);
      await settleFlow();
      expect(stoppedLocalRow.textContent).not.toContain("Started.");

      host.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-pause"]`)!.click();
      await settleFlow();
      const cloudRow = host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)!;
      expect(cloudRow.textContent).toContain("Paused.");
      await vi.advanceTimersByTimeAsync(4_000);
      await settleFlow();
      expect(cloudRow.textContent).not.toContain("Paused.");

      cloudRow.querySelector<HTMLButtonElement>(`[data-testid="settings-cloud-bot-${CLOUD_UID}-resume"]`)!.click();
      await settleFlow();
      expect(cloudRow.textContent).toContain("Resumed.");
      await vi.advanceTimersByTimeAsync(4_000);
      await settleFlow();
      expect(cloudRow.textContent).not.toContain("Resumed.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the Cloud group alone on the web adapter (no adapter.bots)", async () => {
    const adapter = fakeAdapter({ bots: null });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector(`[data-testid="settings-cloud-bot-${CLOUD_UID}"]`)).not.toBeNull();
    });
    expect(host.querySelector('[data-testid="settings-bots-local-unavailable"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-list"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-create"]')).toBeNull();
    expect(host.querySelector('[data-testid="settings-bots-error"]')).toBeNull();
  });

  it("shows per-group empty states", async () => {
    const adapter = fakeAdapter({
      bots: { list: vi.fn(async () => ok({ bots: [] })) },
      agents: { listMobileRoster: vi.fn(async () => ok({ agents: [] })) },
    });
    await mountPane(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-bots-empty"]')?.textContent).toContain("No local bots yet");
      expect(host.querySelector('[data-testid="settings-bots-cloud-empty"]')?.textContent).toContain(
        "No cloud bots yet — add one from a company channel with Add bot.",
      );
    });
  });
});

describe("cloudBotsFromRoster", () => {
  it("normalizes rows, names companies, drops deprovisioned bots, and gates management by role", () => {
    const rows = cloudBotsFromRoster(
      {
        agents: [
          ...ROSTER.agents,
          { uid: "agt_GONE", displayName: "Gone", companyUid: "cmp_indigo", setupPhase: "deprovisioned" },
          { uid: CLOUD_UID, displayName: "Izzy dup", companyUid: "cmp_indigo", setupPhase: "ready" },
        ],
      },
      { companies: COMPANIES },
    );
    expect(rows.map((r) => r.uid)).toEqual([CLOUD_UID, OTHER_UID]);
    expect(rows[0]).toMatchObject({ displayName: "Izzy", companyLabel: "Indigo", status: "IDLE", canManage: true });
    expect(rows[1]).toMatchObject({ displayName: "Rex", companyLabel: "Other Co", status: "PROVISIONING", canManage: false });
  });

  it("maps statuses to plain words", () => {
    expect(cloudBotStatusLabel("WORKING")).toBe("Working");
    expect(cloudBotStatusLabel("IDLE")).toBe("Idle");
    expect(cloudBotStatusLabel("PROVISIONING", "provisioning")).toBe("Setting up");
    expect(cloudBotStatusLabel("PROVISIONING", "failed")).toBe("Setup failed");
  });
});
