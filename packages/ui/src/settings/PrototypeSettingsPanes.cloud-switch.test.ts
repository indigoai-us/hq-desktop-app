// @vitest-environment happy-dom
//
// usage-only-pricing US-016: Settings › Sync lists the personal vault and
// every company vault, each with its own switch, plus one "Turn off all cloud
// sync" switch. Each switch says what turning it off does; an off vault shows
// "Sync is off for <vault>" and how to turn it back on. The choices come from
// the host (persisted outside the app bundle), with a cache-first paint for
// the all-off switch.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import {
  CLOUD_SWITCH_CACHE_KEY,
  CLOUD_SWITCH_EVENT,
} from "./cloud-switch.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  vi.clearAllMocks();
});

function cloudAdapter(options: {
  settings?: Record<string, unknown>;
  setCloudEnabled?: (enabled: boolean) => ReturnType<
    NonNullable<PlatformAdapter["sync"]["setCloudEnabled"]>
  >;
  withSwitch?: boolean;
  withVaultSwitches?: boolean;
  vaultSwitches?: { personalEnabled: boolean; companies: Record<string, boolean> };
  cliHonoursSwitches?: boolean | null;
  setVaultSyncEnabled?: (vault: string, enabled: boolean) => ReturnType<
    NonNullable<PlatformAdapter["sync"]["setVaultSyncEnabled"]>
  >;
}) {
  // The host's saved settings: a successful switch change is what the next
  // settings read returns, as with the real settings file.
  const saved: Record<string, unknown> = { ...(options.settings ?? {}) };
  const setCloudEnabled = vi.fn(async (enabled: boolean) => {
    const result = options.setCloudEnabled
      ? await options.setCloudEnabled(enabled)
      : ok({ cloudEnabled: enabled, notice: null });
    if (result.ok) saved.cloudPaused = !result.value.cloudEnabled;
    return result;
  });
  const updateSettings = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(saved, patch);
    return ok(undefined);
  });
  const sync: Record<string, unknown> = {
    getSyncStatus: async () => ok({}),
    daemonSyncStatus: async () => ok(null),
    startDaemon: vi.fn(async () => ok(undefined)),
    stopDaemon: vi.fn(async () => ok(undefined)),
  };
  if (options.withSwitch !== false) {
    sync.setCloudEnabled = setCloudEnabled;
    sync.getCloudEnabled = async () => ok(saved.cloudPaused !== true);
  }
  const vaults = {
    personalEnabled: options.vaultSwitches?.personalEnabled ?? true,
    companies: { ...(options.vaultSwitches?.companies ?? {}) },
  };
  const setVaultSyncEnabled = vi.fn(async (vault: string, enabled: boolean) => {
    const result = options.setVaultSyncEnabled
      ? await options.setVaultSyncEnabled(vault, enabled)
      : ok({ vault, enabled, notice: null });
    if (result.ok) {
      if (vault === "personal") vaults.personalEnabled = enabled;
      else vaults.companies[vault] = enabled;
    }
    return result;
  });
  if (options.withVaultSwitches !== false) {
    sync.setVaultSyncEnabled = setVaultSyncEnabled;
    sync.getVaultSyncSwitches = async () =>
      ok({
        allOff: saved.cloudPaused === true,
        ...vaults,
        companies: { ...vaults.companies },
        cliHonoursSwitches: options.cliHonoursSwitches ?? null,
      });
  }
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSync",
    settings: {
      getSettings: async () => ok({ ...saved }),
      updateSettings,
      getConfig: async () => ok({}),
    },
    appShell: { notificationPermissionState: async () => ok("unsupported") },
    meetings: { listAccounts: async () => ok([]) },
    sync,
  } as unknown as PlatformAdapter;
  return { adapter, setCloudEnabled, setVaultSyncEnabled, updateSettings };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await tick();
  }
}

function workspace(over: Record<string, unknown>) {
  return {
    slug: "acme",
    displayName: "Acme",
    kind: "company",
    state: "synced",
    cloudUid: "cmp_acme",
    bucketName: null,
    hasLocalFolder: true,
    localPath: null,
    membershipStatus: "active",
    role: "member",
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...over,
  };
}

const COMPANIES = [
  workspace({ slug: "personal", displayName: "Personal", kind: "personal", state: "personal", cloudUid: "prs_me" }),
  workspace({ slug: "zeta", displayName: "Zeta", cloudUid: "cmp_zeta" }),
  workspace({ slug: "acme", displayName: "Acme" }),
  workspace({ slug: "local-co", displayName: "Local Co", state: "local-only", cloudUid: null }),
  workspace({ slug: "invited", displayName: "Invited", cloudUid: "cmp_inv", membershipStatus: "pending" }),
];

function mountSync(adapter: PlatformAdapter, companies: unknown[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "sync", adapter, companies: companies as never[] },
  });
}

function q(testid: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testid}"]`);
}

function switchLabels(): string[] {
  return [...host.querySelectorAll('button[role="switch"]')].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );
}

describe("Settings Cloud switch (US-016)", () => {
  it("shows one Turn off all cloud sync switch above the vault and per-sync switches", async () => {
    const { adapter } = cloudAdapter({ settings: { cloudPaused: false } });
    mountSync(adapter);
    await flush();

    const labels = switchLabels();
    expect(labels.filter((label) => label === "Turn off all cloud sync")).toHaveLength(1);
    expect(labels[0]).toBe("Turn off all cloud sync");
    for (const kept of [
      "Sync on launch",
      "Auto-sync",
      "Instant sync",
      "Sync personal vault",
    ]) {
      expect(labels).toContain(kept);
    }
    // Off by default: all cloud sync is on.
    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("false");
    expect(q("settings-cloud-off")).toBeNull();
    const allOff = q("settings-cloud-row")?.textContent ?? "";
    expect(allOff).toContain("its syncs stop counting toward your bill");
    expect(allOff).toContain("Storage and vault fees still apply");
    expect(allOff).not.toMatch(/no more sync charges/i);
  });

  it("turning all cloud sync off calls the host once, shows the off state and how to turn it back on", async () => {
    const { adapter, setCloudEnabled, updateSettings } = cloudAdapter({
      settings: { cloudPaused: false },
    });
    const announced: boolean[] = [];
    const onChange = (event: Event) =>
      announced.push((event as CustomEvent<{ cloudEnabled: boolean }>).detail.cloudEnabled);
    window.addEventListener(CLOUD_SWITCH_EVENT, onChange);
    mountSync(adapter, COMPANIES);
    await flush();

    q("settings-cloud-toggle")!.click();
    await flush();

    expect(setCloudEnabled).toHaveBeenCalledTimes(1);
    expect(setCloudEnabled).toHaveBeenCalledWith(false);
    // The switch goes through the host command, not a bare settings write.
    expect(updateSettings).not.toHaveBeenCalledWith(
      expect.objectContaining({ cloudPaused: expect.anything() }),
    );
    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("true");
    const off = q("settings-cloud-off");
    expect(off?.textContent).toContain("Cloud sync is off for every vault");
    expect(off?.textContent).toContain("switch off Turn off all cloud sync");
    expect(off?.textContent).toContain("Sign-in, messages, deploys and local HQ keep working");
    expect(q("settings-cloud-per-sync-note")?.textContent).toContain(
      "apply when cloud sync is on",
    );
    // Every vault switch reads off and is held until all cloud sync is back on.
    for (const id of ["personal", "acme", "zeta"]) {
      const toggle = q(`settings-vault-toggle-${id}`) as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(toggle.disabled).toBe(true);
    }
    expect(q("settings-vault-row-acme")?.textContent).toContain("Off while all cloud sync is off.");
    expect(announced).toEqual([false]);
    expect(memoryStorage.getItem(CLOUD_SWITCH_CACHE_KEY)).toBe("off");
    window.removeEventListener(CLOUD_SWITCH_EVENT, onChange);
  });

  it("paints the saved all-off state from the host and turns cloud sync back on", async () => {
    const { adapter, setCloudEnabled } = cloudAdapter({
      settings: { cloudPaused: true },
    });
    mountSync(adapter);
    await flush();

    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-cloud-off")).not.toBeNull();

    q("settings-cloud-toggle")!.click();
    await flush();

    expect(setCloudEnabled).toHaveBeenCalledWith(true);
    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("false");
    expect(q("settings-cloud-off")).toBeNull();
  });

  it("paints the cached value before the host answers (cache-first)", async () => {
    memoryStorage.setItem(CLOUD_SWITCH_CACHE_KEY, "off");
    let release!: () => void;
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const { adapter } = cloudAdapter({ settings: { cloudPaused: true } });
    const slow = adapter.settings.getSettings;
    (adapter.settings as { getSettings: typeof slow }).getSettings = async () => {
      await gate;
      return slow();
    };
    mountSync(adapter);
    await tick();
    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-cloud-off")).not.toBeNull();
    release();
    await flush();
    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("true");
  });

  it("rolls the switch back and shows an actionable error when the host refuses", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      setCloudEnabled: async () => failure("error", "disk full"),
    });
    mountSync(adapter);
    await flush();

    q("settings-cloud-toggle")!.click();
    await flush();

    expect(q("settings-cloud-toggle")?.getAttribute("aria-checked")).toBe("false");
    expect(q("settings-cloud-off")).toBeNull();
    const error = q("settings-native-error")?.textContent ?? "";
    expect(error).toContain("Cloud wasn’t saved. Try again.");
    expect(error).not.toContain("disk full");
  });

  it("shows the host's notice when background sync is still stopping", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      setCloudEnabled: async () =>
        ok({
          cloudEnabled: false,
          notice: "Cloud is off. Background sync is still stopping; it will not start again.",
        }),
    });
    mountSync(adapter);
    await flush();
    q("settings-cloud-toggle")!.click();
    await flush();
    expect(q("settings-cloud-notice")?.textContent).toContain(
      "Background sync is still stopping",
    );
  });

  it("hides the all-off switch on a host that has no Cloud command", async () => {
    const { adapter } = cloudAdapter({ withSwitch: false });
    mountSync(adapter);
    await flush();
    expect(q("settings-cloud-row")).toBeNull();
    expect(switchLabels()).toContain("Auto-sync");
    expect(switchLabels()).toContain("Sync personal vault");
  });
});

describe("Settings vault switches (US-016)", () => {
  it("lists the personal vault and every cloud company vault, each with its own switch and plain copy", async () => {
    const { adapter } = cloudAdapter({ settings: { cloudPaused: false } });
    mountSync(adapter, COMPANIES);
    await flush();

    const rows = [...host.querySelectorAll('[data-testid^="settings-vault-row-"]')].map(
      (el) => el.getAttribute("data-testid"),
    );
    // Personal first, then companies by name. Local-only and pending
    // companies have no cloud vault to sync yet.
    expect(rows).toEqual([
      "settings-vault-row-personal",
      "settings-vault-row-acme",
      "settings-vault-row-zeta",
    ]);
    const acme = q("settings-vault-row-acme")?.textContent ?? "";
    expect(acme).toContain("this computer stops syncing this vault");
    expect(acme).toContain("its syncs stop counting toward your bill");
    // Accurate about what keeps costing money (review H1).
    expect(acme).toContain("Storage and the vault fee still apply");
    expect(acme).toContain("teammates who sync still add usage");
    expect(acme).not.toMatch(/no more sync charges|avoid .*fees/i);
    expect(acme).toContain("Files stay on this computer");
    expect(acme).toContain("teammates stop getting this computer's changes");
    expect(q("settings-vault-row-personal")?.textContent).toContain(
      "this computer stops syncing your personal vault",
    );
    expect(q("settings-vault-sync")?.textContent).toContain(
      "This only changes this computer. Teammates keep syncing.",
    );
    for (const id of ["personal", "acme", "zeta"]) {
      expect(q(`settings-vault-toggle-${id}`)?.getAttribute("aria-checked")).toBe("true");
    }
  });

  it("turning one company vault off calls the host for that vault only and shows Sync is off for it", async () => {
    const { adapter, setVaultSyncEnabled, setCloudEnabled } = cloudAdapter({
      settings: { cloudPaused: false },
    });
    const changes: unknown[] = [];
    const onChange = (event: Event) => changes.push((event as CustomEvent).detail);
    window.addEventListener("hq:workspace-sync-enabled-changed", onChange);
    mountSync(adapter, COMPANIES);
    await flush();

    q("settings-vault-toggle-acme")!.click();
    await flush();

    expect(setVaultSyncEnabled).toHaveBeenCalledTimes(1);
    expect(setVaultSyncEnabled).toHaveBeenCalledWith("acme", false);
    expect(setCloudEnabled).not.toHaveBeenCalled();
    expect(q("settings-vault-toggle-acme")?.getAttribute("aria-checked")).toBe("false");
    const off = q("settings-vault-off-acme")?.textContent ?? "";
    expect(off).toContain("Sync is off for Acme");
    expect(off).toContain("turn its switch back on");
    // Personal and the other company keep syncing.
    expect(q("settings-vault-toggle-personal")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-vault-toggle-zeta")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-vault-off-zeta")).toBeNull();
    expect(changes).toEqual([{ slug: "acme", enabled: false }]);
    window.removeEventListener("hq:workspace-sync-enabled-changed", onChange);
  });

  it("paints saved vault switches from the host and turns the personal vault back on", async () => {
    const { adapter, setVaultSyncEnabled } = cloudAdapter({
      settings: { cloudPaused: false, personalSyncEnabled: false },
      vaultSwitches: { personalEnabled: false, companies: { zeta: false } },
    });
    mountSync(adapter, COMPANIES);
    await flush();

    expect(q("settings-vault-toggle-personal")?.getAttribute("aria-checked")).toBe("false");
    expect(q("settings-vault-off-personal")?.textContent).toContain(
      "Sync is off for your personal vault",
    );
    expect(q("settings-vault-toggle-zeta")?.getAttribute("aria-checked")).toBe("false");
    expect(q("settings-vault-toggle-acme")?.getAttribute("aria-checked")).toBe("true");

    q("settings-vault-toggle-personal")!.click();
    await flush();
    expect(setVaultSyncEnabled).toHaveBeenCalledWith("personal", true);
    expect(q("settings-vault-toggle-personal")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-vault-off-personal")).toBeNull();
  });

  it("rolls a vault switch back with an actionable error when the host refuses", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      setVaultSyncEnabled: async () => failure("error", "EACCES menubar.json"),
    });
    mountSync(adapter, COMPANIES);
    await flush();

    q("settings-vault-toggle-zeta")!.click();
    await flush();

    expect(q("settings-vault-toggle-zeta")?.getAttribute("aria-checked")).toBe("true");
    expect(q("settings-vault-off-zeta")).toBeNull();
    const error = q("settings-native-error")?.textContent ?? "";
    expect(error).toContain("Zeta");
    expect(error).not.toContain("EACCES");
  });

  it("shows the host's notice when background sync did not restart", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      setVaultSyncEnabled: async (vault, enabled) =>
        ok({ vault, enabled, notice: "Saved. Background sync did not restart yet; use Sync now or restart HQ." }),
    });
    mountSync(adapter, COMPANIES);
    await flush();
    q("settings-vault-toggle-acme")!.click();
    await flush();
    expect(q("settings-vault-notice")?.textContent).toContain("did not restart yet");
  });

  // Review: with an HQ CLI older than the switches, an off vault can still
  // sync through that tool, so Settings says so.
  it("warns that an out-of-date HQ command line tool can still sync an off vault", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      cliHonoursSwitches: false,
    });
    mountSync(adapter, COMPANIES);
    await flush();
    // Nothing off yet: no warning.
    expect(q("settings-vault-cli-outdated")).toBeNull();

    q("settings-vault-toggle-acme")!.click();
    await flush();
    const notice = q("settings-vault-cli-outdated")?.textContent ?? "";
    expect(notice).toContain("The HQ command line tool on this computer is out of date");
    expect(notice).toContain("can still sync vaults that are off here");
    expect(notice).toContain("Settings › Updates");
  });

  it("shows no CLI warning when the HQ command line tool honours the switches", async () => {
    const { adapter } = cloudAdapter({
      settings: { cloudPaused: false },
      vaultSwitches: { personalEnabled: true, companies: { acme: false } },
      cliHonoursSwitches: true,
    });
    mountSync(adapter, COMPANIES);
    await flush();
    expect(q("settings-vault-off-acme")).not.toBeNull();
    expect(q("settings-vault-cli-outdated")).toBeNull();
  });

  it("falls back to the personal settings write on a host without vault commands", async () => {
    const { adapter, updateSettings } = cloudAdapter({
      settings: { cloudPaused: false, personalSyncEnabled: true },
      withVaultSwitches: false,
    });
    mountSync(adapter, COMPANIES);
    await flush();

    q("settings-vault-toggle-personal")!.click();
    await flush();
    expect(updateSettings).toHaveBeenCalledWith({ personalSyncEnabled: false });
    expect(q("settings-vault-toggle-personal")?.getAttribute("aria-checked")).toBe("false");
  });

  it("styles the off state with a background highlight, no edge stripe, and 13px text", () => {
    const source = readFileSync(
      join(process.cwd(), "src/settings/PrototypeSettingsPanes.svelte"),
      "utf8",
    );
    const blocks = [...source.matchAll(/\.cloud-[a-z-]+(?:,\s*\.cloud-[a-z-]+)*\s*\{[^}]*\}/g)].map(
      (match) => match[0],
    );
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).not.toMatch(/border-left|inset-inline-start|box-shadow:\s*inset/);
      for (const size of block.matchAll(/font-size:\s*([0-9.]+)px/g)) {
        expect(size[1]).toBe("13");
      }
    }
  });
});
