// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import CompaniesSettingsPane from "./CompaniesSettingsPane.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function adapterForSettings(
  getSettings: PlatformAdapter["settings"]["getSettings"],
): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSync",
    settings: { getSettings },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

function mountPane(adapter: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompaniesSettingsPane, {
    target: host,
    props: {
      adapter,
      companies: [],
      personalLabel: "Personal",
    },
  });
}

function personalSyncState(): string | null | undefined {
  return host
    .querySelector('[data-testid="settings-personal-sync-state"]')
    ?.textContent?.trim();
}

describe("CompaniesSettingsPane personal sync status", () => {
  it("shows a neutral checking state until native settings are available", async () => {
    const settings = deferred<ReturnType<typeof ok<Record<string, unknown>>>>();
    mountPane(adapterForSettings(() => settings.promise));

    expect(personalSyncState()).toBe("Checking");
    settings.resolve(ok({ personalSyncEnabled: false }));
    await vi.waitFor(() => expect(personalSyncState()).toBe("Local"));
  });

  it("shows Personal as synced when native sync is enabled", async () => {
    mountPane(adapterForSettings(async () => ok({ personalSyncEnabled: true })));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Synced"));
  });

  it("defaults Personal to synced when the native setting is absent", async () => {
    mountPane(adapterForSettings(async () => ok({})));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Synced"));
  });

  it("shows Personal as local only after an explicit native opt-out", async () => {
    mountPane(adapterForSettings(async () => ok({ personalSyncEnabled: false })));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Local"));
  });

  it("does not misreport Personal as local when native settings cannot be read", async () => {
    mountPane(adapterForSettings(async () => failure("error", "settings-read-failed")));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Unavailable"));
  });

  it("refreshes Personal sync state when the native setting changes", async () => {
    let enabled = true;
    const getSettings = vi.fn(async () => ok({ personalSyncEnabled: enabled }));
    mountPane(adapterForSettings(getSettings));
    await vi.waitFor(() => expect(personalSyncState()).toBe("Synced"));

    enabled = false;
    window.dispatchEvent(new Event("hq:workspace-sync-enabled-changed"));

    await vi.waitFor(() => expect(personalSyncState()).toBe("Local"));
    expect(getSettings).toHaveBeenCalledTimes(2);
  });
});

const cloudCo = {
  slug: "acme",
  displayName: "Acme",
  kind: "company",
  state: "synced",
  cloudUid: "cmp_acme",
  bucketName: "hq-vault-cmp-acme",
  role: "owner",
  membershipStatus: "active",
};
const localCo = {
  slug: "garage",
  displayName: "Garage Co",
  kind: "company",
  state: "local-only",
  cloudUid: null,
  bucketName: null,
  role: null,
  membershipStatus: null,
};

function fullAdapter(overrides: {
  getCompanySyncMode?: ReturnType<typeof vi.fn>;
  setCompanySyncMode?: ReturnType<typeof vi.fn>;
  connectToCloud?: ReturnType<typeof vi.fn>;
  listSyncableWorkspaces?: ReturnType<typeof vi.fn>;
}): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: (capability: string) => capability === "canSync",
    settings: { getSettings: async () => ok({}) },
    sync: {
      getCompanySyncMode:
        overrides.getCompanySyncMode ??
        vi.fn(async () => ok({ membershipId: "m", syncMode: "all", isDefault: true })),
      setCompanySyncMode:
        overrides.setCompanySyncMode ??
        vi.fn(async (_slug: string, mode: string) =>
          ok({ membershipId: "m", syncMode: mode, isDefault: false }),
        ),
      listSyncableWorkspaces:
        overrides.listSyncableWorkspaces ?? vi.fn(async () => ok([])),
    },
    company: {
      connectToCloud: overrides.connectToCloud ?? vi.fn(async () => ok(null)),
    },
  } as unknown as PlatformAdapter;
}

function mountWith(adapter: PlatformAdapter, companies: unknown[]): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CompaniesSettingsPane, {
    target: host,
    props: { adapter, companies: companies as never, retryDelayMs: 0 },
  });
}

function row(slug: string): HTMLElement {
  return host.querySelector<HTMLElement>(`[data-company-slug="${slug}"]`)!;
}

describe("CompaniesSettingsPane companies", () => {
  it("shows role and whether each company is a cloud vault or local only", async () => {
    mountWith(fullAdapter({}), [cloudCo, localCo]);
    await vi.waitFor(() => expect(row("acme")).not.toBeNull());
    const storage = (slug: string) =>
      row(slug).querySelector('[data-testid="settings-company-storage"]')?.textContent?.trim();
    expect(storage("acme")).toBe("Cloud vault");
    expect(storage("garage")).toBe("Local only");
    expect(row("acme").querySelector('[data-testid="settings-company-role"]')?.textContent).toBe("Owner");
    expect(row("garage").querySelector('[data-testid="settings-company-role"]')).toBeNull();
  });

  it("loads the saved sync mode and switches to Sync shared through set_sync_mode", async () => {
    const setCompanySyncMode = vi.fn(async (_slug: string, mode: string) =>
      ok({ membershipId: "m", syncMode: mode, isDefault: false }),
    );
    mountWith(fullAdapter({ setCompanySyncMode }), [cloudCo]);
    const all = () => row("acme").querySelector<HTMLButtonElement>('[data-testid="settings-company-mode-all"]');
    const shared = () => row("acme").querySelector<HTMLButtonElement>('[data-testid="settings-company-mode-shared"]');
    await vi.waitFor(() => expect(all()?.getAttribute("aria-checked")).toBe("true"));

    shared()!.click();

    await vi.waitFor(() => expect(shared()?.getAttribute("aria-checked")).toBe("true"));
    expect(setCompanySyncMode).toHaveBeenCalledWith("acme", "shared");
    expect(row("acme").textContent).toMatch(/Applies on the next sync/);
  });

  it("does not offer a mode choice for a local-only company", async () => {
    const getCompanySyncMode = vi.fn();
    mountWith(fullAdapter({ getCompanySyncMode }), [localCo]);
    await vi.waitFor(() => expect(row("garage")).not.toBeNull());
    expect(row("garage").querySelector('[data-testid="settings-company-mode-all"]')).toBeNull();
    expect(getCompanySyncMode).not.toHaveBeenCalled();
  });

  it("retries a failed mode read, then shows a quiet Tap to retry with no raw error", async () => {
    const getCompanySyncMode = vi.fn(async () => failure("error", "HTTP 500 {\"message\":\"boom\"}"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWith(fullAdapter({ getCompanySyncMode }), [cloudCo]);
    await vi.waitFor(() =>
      expect(row("acme").querySelector('[data-testid="settings-company-mode-retry"]')).not.toBeNull(),
    );
    expect(getCompanySyncMode).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toMatch(/HTTP|boom|\{/);
    expect(host.querySelector('[role="alert"]')).toBeNull();

    getCompanySyncMode.mockImplementation(async () =>
      ok({ membershipId: "m", syncMode: "shared", isDefault: false }) as never,
    );
    row("acme").querySelector<HTMLButtonElement>('[data-testid="settings-company-mode-retry"]')!.click();
    await vi.waitFor(() =>
      expect(
        row("acme").querySelector('[data-testid="settings-company-mode-shared"]')?.getAttribute("aria-checked"),
      ).toBe("true"),
    );
    warn.mockRestore();
  });

  it("tells an owner on Sync shared that owner access does not widen downloads", async () => {
    const getCompanySyncMode = vi.fn(async () => ok({ membershipId: "m", syncMode: "shared", isDefault: false }));
    mountWith(fullAdapter({ getCompanySyncMode }), [cloudCo]);
    await vi.waitFor(() =>
      expect(row("acme").querySelector('[data-testid="settings-company-mode-hint"]')?.textContent).toMatch(
        /owner access/i,
      ),
    );
  });

  it("converts a local-only company only after confirmation, then shows it as a cloud vault", async () => {
    const connectToCloud = vi.fn(async () => ok(null));
    const listSyncableWorkspaces = vi.fn(async () =>
      ok({ workspaces: [{ ...localCo, state: "synced", cloudUid: "cmp_g", bucketName: "b" }] }),
    );
    mountWith(fullAdapter({ connectToCloud, listSyncableWorkspaces }), [localCo]);
    await vi.waitFor(() => expect(row("garage")).not.toBeNull());

    row("garage").querySelector<HTMLButtonElement>('[data-testid="settings-company-convert"]')!.click();
    await tick();
    expect(connectToCloud).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/uploads the Garage Co folder/);

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === "Convert",
    )!;
    confirm.click();

    await vi.waitFor(() =>
      expect(
        row("garage").querySelector('[data-testid="settings-company-storage"]')?.textContent?.trim(),
      ).toBe("Cloud vault"),
    );
    expect(connectToCloud).toHaveBeenCalledWith("garage");
    expect(listSyncableWorkspaces).toHaveBeenCalled();
  });

  it("keeps Convert usable with a quiet hint when the conversion keeps failing", async () => {
    const connectToCloud = vi.fn(async () => failure("error", "[invoke] connect HTTP 403 Forbidden"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mountWith(fullAdapter({ connectToCloud }), [localCo]);
    await vi.waitFor(() => expect(row("garage")).not.toBeNull());
    row("garage").querySelector<HTMLButtonElement>('[data-testid="settings-company-convert"]')!.click();
    await tick();
    [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => b.textContent?.trim() === "Convert")!
      .click();

    await vi.waitFor(() =>
      expect(row("garage").querySelector('[data-testid="settings-company-convert-retry"]')).not.toBeNull(),
    );
    expect(connectToCloud).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toMatch(/invoke|403|Forbidden/);
    expect(
      row("garage").querySelector<HTMLButtonElement>('[data-testid="settings-company-convert"]')!.disabled,
    ).toBe(false);
    warn.mockRestore();
  });
});
