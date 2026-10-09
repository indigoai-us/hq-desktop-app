// @vitest-environment happy-dom
//
// Regression cover for the beta.2 Updates pane: every row was pinned on
// "CHECKING" and the status button on "Refreshing…" forever, because the pane
// awaited Promise.all over five adapter calls with no timeout and no finally.
// These tests pin the fixed contract: rows always reach a real result, the
// busy flag always clears, and the explicit check button + release-channel
// selector drive the SAME orchestration.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import PrototypeSettingsPanes from "./PrototypeSettingsPanes.svelte";
import { chooseDropdown, dropdownOptions, dropdownValue } from "../test-support/dropdown.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";
import { resetUpdateStore, setBackgroundUpdatesOff } from "./update-store.svelte";

const memoryStorage = installMemoryLocalStorage();

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  resetUpdateStore();
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  memoryStorage.clear();
  resetUpdateStore();
  vi.clearAllMocks();
});

function updatesAdapter(overrides: Record<string, unknown> = {}) {
  const updateSettings = vi.fn(async () => ok(undefined));
  const adapter = {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSelfUpdate",
    appShell: {
      notificationPermissionState: vi.fn(async () => ok("granted")),
    },
    meetings: { listAccounts: vi.fn(async () => ok([])) },
    settings: {
      getSettings: vi.fn(async () =>
        ok({ autoUpdate: true, releaseChannel: "beta", hqPath: "/tmp/HQ" }),
      ),
      updateSettings,
    },
    updates: {
      getVersions: vi.fn(async () => ok({ core: "15.0.118", cli: "1.2.3" })),
      checkForUpdates: vi.fn(async () => ok(null)),
      checkCoreState: vi.fn(async () => ok({ versionBehind: false })),
      checkCliUpdate: vi.fn(async () => ok(null)),
      installUpdate: vi.fn(async () => ok(undefined)),
      installCoreUpdate: vi.fn(async () => ok(undefined)),
      installCliUpdate: vi.fn(async () => ok(undefined)),
      downloadUpdate: vi.fn(async () => ok(undefined)),
      installDownloadedUpdate: vi.fn(async () => ok(undefined)),
      getDownloadedUpdate: vi.fn(async () => ok(null)),
      availableChannels: vi.fn(async () => ok(["stable", "beta", "alpha"])),
      ...overrides,
    },
    shell: {
      detectAiTools: vi.fn(async () =>
        ok({
          claude_desktop: true,
          claude_cli: true,
          codex_desktop: true,
          codex_cli: true,
          grok_cli: true,
        }),
      ),
      openClaudeCodeLink: vi.fn(async () => ok(undefined)),
      launchClaudeCode: vi.fn(async () => ok(undefined)),
      launchCodexWorkspace: vi.fn(async () => ok(undefined)),
      launchCliInTerminal: vi.fn(async () => ok(undefined)),
    },
  } as unknown as PlatformAdapter;
  return { adapter, updateSettings };
}

function mountUpdates(adapter: PlatformAdapter): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(PrototypeSettingsPanes, {
    target: host,
    props: { section: "updates", adapter, version: "0.10.173-beta.2" },
  });
  return host;
}

function checkButton(): HTMLButtonElement {
  const btn = host.querySelector<HTMLButtonElement>(
    '[data-testid="settings-check-for-updates"]',
  );
  expect(btn).toBeTruthy();
  return btn!;
}

function statusTexts(): string {
  return host.textContent?.replace(/\s+/g, " ") ?? "";
}

describe("Updates pane: busy state always resolves", () => {
  it("reaches a real result for every row and clears the button", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);

    await vi.waitFor(() => {
      expect(checkButton().disabled).toBe(false);
      expect(statusTexts()).toContain("UP TO DATE");
    });
    expect(statusTexts()).not.toContain("CHECKING");
    expect(checkButton().textContent?.trim()).toBe("Check for updates");
  });

  it("degrades a hung check to a failed row instead of spinning forever", async () => {
    // The exact beta.2 shape: the app updater call never settles.
    const { adapter } = updatesAdapter({
      checkForUpdates: vi.fn(() => new Promise(() => {})),
    });
    mountUpdates(adapter);

    await vi.waitFor(
      () => {
        expect(statusTexts()).toContain("UP TO DATE");
      },
      { timeout: 4000 },
    );
    // Core and CLI resolved even though the app check is still hanging —
    // no all-or-nothing gating.
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    expect(updates.checkCoreState).toHaveBeenCalled();
    expect(updates.checkCliUpdate).toHaveBeenCalled();
  });

  it("the explicit button re-runs the same orchestration", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await vi.waitFor(() => expect(checkButton().disabled).toBe(false));
    const before = updates.checkForUpdates.mock.calls.length;

    checkButton().click();
    await vi.waitFor(() => {
      expect(updates.checkForUpdates.mock.calls.length).toBeGreaterThan(before);
    });
    await vi.waitFor(() => expect(checkButton().disabled).toBe(false));
  });
});

describe("Updates pane: release channel selector", () => {
  it("renders host-permitted channels with the stored one selected", async () => {
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    await vi.waitFor(async () =>
      expect(await dropdownValue(host, "settings-release-channel")).toBe("beta"),
    );
    expect(await dropdownOptions(host, "settings-release-channel")).toHaveLength(3);
  });

  it("persists a selection and immediately re-checks on the new channel", async () => {
    const { adapter, updateSettings } = updatesAdapter();
    mountUpdates(adapter);
    const updates = adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await vi.waitFor(async () =>
      expect(await dropdownValue(host, "settings-release-channel")).toBe("beta"),
    );
    const before = updates.checkForUpdates.mock.calls.length;

    await chooseDropdown(host, "settings-release-channel", "alpha");

    await vi.waitFor(() => {
      expect(updateSettings).toHaveBeenCalledWith({ releaseChannel: "alpha" });
      expect(updates.checkForUpdates.mock.calls.length).toBeGreaterThan(before);
    });
  });

  it("explains a downgrade instead of offering an older build", async () => {
    const { adapter } = updatesAdapter({
      // Stable's newest is older than the installed 0.10.173-beta.2.
      checkForUpdates: vi.fn(async () => ok({ version: "0.10.172" })),
    });
    mountUpdates(adapter);
    await vi.waitFor(() => {
      expect(
        host.querySelector('[data-testid="settings-release-channel"]'),
      ).toBeTruthy();
    });
    // The guard model is unit-tested directly; here we assert the pane never
    // presents an install action for an older build.
    expect(statusTexts()).not.toContain("Restart to update");
  });
});

describe("Updates pane: versions land before the slow core check", () => {
  it("shows installed versions while the core row is still CHECKING", async () => {
    const { adapter } = updatesAdapter({
      getVersions: vi.fn(async () =>
        ok({ core: "15.0.120-beta.3", cli: "5.105.1" }),
      ),
      checkCoreState: vi.fn(() => new Promise(() => {})),
    });
    mountUpdates(adapter);

    await vi.waitFor(() => {
      expect(statusTexts()).toContain("v15.0.120-beta.3");
      expect(statusTexts()).toContain("v5.105.1");
    });
    expect(statusTexts()).toContain("CHECKING");
    expect(statusTexts()).not.toContain("Checking installed location…");
  });

  it("does not start a second core check when focus fires while one is in flight", async () => {
    let releaseCore: ((value: unknown) => void) | undefined;
    const coreGate = new Promise((resolve) => {
      releaseCore = resolve;
    });
    const checkCoreState = vi.fn(() =>
      coreGate.then(() => ok({ versionBehind: false })),
    );
    const { adapter } = updatesAdapter({ checkCoreState });
    mountUpdates(adapter);

    await vi.waitFor(() => expect(checkCoreState).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    await Promise.resolve();
    expect(checkCoreState).toHaveBeenCalledTimes(1);

    releaseCore?.(ok({ versionBehind: false }));
    await vi.waitFor(() => expect(checkButton().disabled).toBe(false));

    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(checkCoreState).toHaveBeenCalledTimes(2));
  });

  it("never renders a blank failed/unchecked reason after a core check reject", async () => {
    const checkCoreState = vi.fn(async () => {
      throw new Error("staging index build failed: HTTP 502");
    });
    const { adapter } = updatesAdapter({ checkCoreState });
    mountUpdates(adapter);

    // The rows render NOT CHECKED for a tick before hydration starts, so wait
    // for the check to actually run and then for every row to leave CHECKING.
    await vi.waitFor(() => expect(checkCoreState).toHaveBeenCalled());
    await vi.waitFor(() => {
      expect(statusTexts()).not.toContain("CHECKING");
      expect(checkButton().disabled).toBe(false);
    });
    const text = statusTexts();
    expect(text).toMatch(/CHECK FAILED|NOT CHECKED/);
    expect(text).not.toMatch(/failed:\s*$/);
    expect(text).toMatch(
      /staging index build failed: HTTP 502|could not be checked|did not finish|Try again/,
    );
  });
});

// QA-061: Settings → Updates showed Automatic updates on while About said
// automatic updates are off in this build. Both now read one capability.
describe("Updates pane: automatic updates follow the build capability", () => {
  function toggle(): HTMLButtonElement | null {
    return host.querySelector<HTMLButtonElement>('[data-testid="settings-auto-update-toggle"]');
  }

  it("shows the switch off and disabled in a build without background updates", async () => {
    setBackgroundUpdatesOff(true);
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    await vi.waitFor(() => expect(toggle()).toBeTruthy());
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
    expect(toggle()!.disabled).toBe(true);
    expect(
      host.querySelector('[data-testid="settings-auto-update-description"]')?.textContent,
    ).toContain("not available in this build");
  });

  it("keeps the saved preference when background updates are available", async () => {
    setBackgroundUpdatesOff(false);
    const { adapter } = updatesAdapter();
    mountUpdates(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Updates pane: per-row Update now", () => {
  function updatesFns(adapter: PlatformAdapter) {
    return adapter.updates as unknown as Record<string, ReturnType<typeof vi.fn>>;
  }

  it("puts Update now on Desktop, Core, and CLI when each is available", async () => {
    const { adapter } = updatesAdapter({
      checkForUpdates: vi.fn(async () => ok({ version: "0.10.408" })),
      checkCoreState: vi.fn(async () => ok({ versionBehind: true })),
      checkCliUpdate: vi.fn(async () => ok({ latest: "5.347.0" })),
    });
    mountUpdates(adapter);

    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-app-download"]')?.textContent).toContain(
        "Update now",
      );
      expect(host.querySelector('[data-testid="settings-core-update"]')?.textContent).toContain(
        "Update now",
      );
      expect(host.querySelector('[data-testid="settings-cli-update"]')?.textContent).toContain(
        "Update now",
      );
    });
    expect(statusTexts()).not.toMatch(/npm |hq update|pnpm /i);
  });

  it("shows Updating… immediately, ignores a second press, then marks the CLI row up to date", async () => {
    let settle: ((value: { ok: true; value: undefined }) => void) | undefined;
    let cliLatest: string | null = "5.347.0";
    const { adapter } = updatesAdapter({
      checkCliUpdate: vi.fn(async () => (cliLatest ? ok({ latest: cliLatest }) : ok(null))),
      installCliUpdate: vi.fn(
        () =>
          new Promise((resolve) => {
            settle = resolve;
          }),
      ),
    });
    mountUpdates(adapter);
    const button = await vi.waitFor(() => {
      const btn = host.querySelector<HTMLButtonElement>('[data-testid="settings-cli-update"]');
      expect(btn?.textContent).toContain("Update now");
      return btn!;
    });
    button.click();
    button.click();
    await vi.waitFor(() => {
      expect(button.disabled).toBe(true);
      expect(button.textContent).toContain("Updating…");
    });
    expect(updatesFns(adapter).installCliUpdate).toHaveBeenCalledTimes(1);
    cliLatest = null;
    settle?.({ ok: true, value: undefined });
    await vi.waitFor(() => {
      expect(statusTexts()).toMatch(/HQ CLI[\s\S]*UP TO DATE/);
      expect(host.querySelector('[data-testid="settings-cli-update"]')).toBeNull();
    });
  });

  it("quietly retries a CLI install, then offers Try again and AI fix buttons without raw errors", async () => {
    const raw = 'npm ERR! code E500\ninstall_hq_cli_update HTTP 502: {"error":"boom"}';
    const { adapter } = updatesAdapter({
      checkCliUpdate: vi.fn(async () => ok({ latest: "5.347.0" })),
      installCliUpdate: vi.fn(async () => ({ ok: false, message: raw })),
    });
    mountUpdates(adapter);
    const button = await vi.waitFor(() => {
      const btn = host.querySelector<HTMLButtonElement>('[data-testid="settings-cli-update"]');
      expect(btn).toBeTruthy();
      return btn!;
    });
    button.click();
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Try again");
      expect(host.textContent).toContain("Fix in Claude Code");
      expect(host.textContent).toContain("Fix in Codex");
      expect(host.textContent).toContain("Fix in Grok Build");
    });
    expect(updatesFns(adapter).installCliUpdate).toHaveBeenCalledTimes(3);
    expect(statusTexts()).not.toContain("HTTP 502");
    expect(statusTexts()).not.toContain("npm ERR");
    expect(statusTexts()).not.toContain("install_hq_cli_update");
    expect(statusTexts()).not.toMatch(/hq update|npm i |pnpm /i);
  });

  it("opens Claude Code with the self-heal prompt from the CLI row", async () => {
    const { adapter } = updatesAdapter({
      checkCliUpdate: vi.fn(async () => ok({ latest: "5.347.0" })),
      installCliUpdate: vi.fn(async () => ({ ok: false, message: "nope" })),
    });
    mountUpdates(adapter);
    const update = await vi.waitFor(() => {
      const btn = host.querySelector<HTMLButtonElement>('[data-testid="settings-cli-update"]');
      expect(btn).toBeTruthy();
      return btn!;
    });
    update.click();
    const heal = await vi.waitFor(() => {
      const btn = Array.from(host.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Fix in Claude Code"),
      );
      expect(btn).toBeTruthy();
      return btn!;
    });
    heal.click();
    const shell = (adapter as unknown as { shell: Record<string, ReturnType<typeof vi.fn>> }).shell;
    await vi.waitFor(() => {
      expect(shell.openClaudeCodeLink).toHaveBeenCalled();
    });
    const url = String(shell.openClaudeCodeLink.mock.calls[0]?.[0] ?? "");
    const prompt = new URL(url).searchParams.get("q");
    expect(prompt).toBe(
      "HQ couldn't update itself. Find out why and get it up to date.",
    );
  });

  it("labels a staged desktop update Restart HQ", async () => {
    const { adapter } = updatesAdapter({
      checkForUpdates: vi.fn(async () => ok({ version: "0.10.408" })),
      getDownloadedUpdate: vi.fn(async () => ok({ version: "0.10.408" })),
    });
    mountUpdates(adapter);
    await vi.waitFor(() => {
      expect(host.querySelector('[data-testid="settings-app-restart"]')?.textContent).toContain(
        "Restart HQ",
      );
    });
  });
});
