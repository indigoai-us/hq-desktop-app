// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import {
  ensureHqAnywhereGlobalRuntime,
  failure,
  ok,
  type AdapterResult,
  type PlatformAdapter,
} from "@hq/platform";
import HqAnywhereSettingRow from "./HqAnywhereSettingRow.svelte";

type ResolveFeatureFlag = NonNullable<PlatformAdapter["identity"]["resolveFeatureFlagStatus"]>;
type SubscribeFeature = NonNullable<PlatformAdapter["identity"]["subscribeFeature"]>;

function createAdapter(options: {
  enabled?: boolean;
  configured?: boolean;
  resolveFlag?: ResolveFeatureFlag;
  subscribeFeature?: SubscribeFeature;
  initialValue?: boolean;
  getSetting?: PlatformAdapter["settings"]["getHqAnywherePersonSetting"];
  putSetting?: PlatformAdapter["settings"]["putHqAnywherePersonSetting"];
  syncRuntime?: PlatformAdapter["settings"]["syncHqAnywhereGlobal"];
}) {
  const getHqAnywherePersonSetting = vi.fn(
    options.getSetting ?? (async () => ok(options.initialValue ?? false)),
  );
  const putHqAnywherePersonSetting = vi.fn(
    options.putSetting ?? (async () => ok(undefined)),
  );
  const syncHqAnywhereGlobal = vi.fn(
    options.syncRuntime ?? (async () => ok(undefined)),
  );
  const resolveFeatureFlagStatus = vi.fn(
    options.resolveFlag ??
      (async () => ok({ enabled: options.enabled ?? true, configured: options.configured ?? true })),
  );
  const adapter = {
    identity: { resolveFeatureFlagStatus, subscribeFeature: options.subscribeFeature },
    settings: {
      getHqAnywherePersonSetting,
      putHqAnywherePersonSetting,
      syncHqAnywhereGlobal,
    },
  } as unknown as PlatformAdapter;
  return {
    adapter,
    getHqAnywherePersonSetting,
    putHqAnywherePersonSetting,
    syncHqAnywhereGlobal,
    resolveFeatureFlagStatus,
    subscribeFeature: options.subscribeFeature,
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

function render(adapter: PlatformAdapter) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(HqAnywhereSettingRow, { target: host, props: { adapter } });
}

const unavailableRow = () =>
  host.querySelector('[data-testid="hq-anywhere-setting-unavailable"]');

const toggle = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="hq-anywhere-setting-toggle"]');

describe("Settings > HQ Anywhere", () => {
  it("hides the row when the adapter has no identity capability", async () => {
    const adapterWithoutIdentity = { settings: {} } as unknown as PlatformAdapter;
    render(adapterWithoutIdentity);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector('[data-testid="hq-anywhere-setting-row"]')).toBeNull();
  });

  it("loads the signed-in person's current setting", async () => {
    const { adapter, getHqAnywherePersonSetting, putHqAnywherePersonSetting } = createAdapter({
      initialValue: true,
    });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(getHqAnywherePersonSetting).toHaveBeenCalledTimes(1);
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(host.textContent).toContain(
      "Use your HQ context in Claude Code, Codex, ChatGPT and Grok",
    );
  });

  it("turns the setting on", async () => {
    const { adapter, putHqAnywherePersonSetting, syncHqAnywhereGlobal } = createAdapter({ initialValue: false });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(true);
    await vi.waitFor(() => expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(true, true));
  });

  it("turns the setting off", async () => {
    const { adapter, putHqAnywherePersonSetting, syncHqAnywhereGlobal } = createAdapter({ initialValue: true });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));

    toggle()!.click();

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(false);
    await vi.waitFor(() => expect(syncHqAnywhereGlobal).toHaveBeenCalledWith(false, true));
  });

  it("keeps the toggle optimistic and shows a muted setup hint while install runs", async () => {
    let completeSetup!: (result: AdapterResult<void>) => void;
    const syncRuntime = vi.fn(
      () => new Promise<AdapterResult<void>>((resolve) => { completeSetup = resolve; }),
    );
    const { adapter } = createAdapter({ initialValue: false, syncRuntime });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(host.textContent).toContain("Setting up…"));
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    completeSetup(ok(undefined));
    await vi.waitFor(() => expect(host.textContent).not.toContain("Setting up…"));
  });

  it("rolls back after automatic retries and offers a manual retry", async () => {
    const putSetting = vi
      .fn()
      .mockResolvedValue(failure("network", "raw transport detail"));
    const { adapter } = createAdapter({ initialValue: false, putSetting });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(putSetting).toHaveBeenCalledTimes(3), { timeout: 3000 });
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
    const retry = host.querySelector<HTMLButtonElement>(
      '[data-testid="hq-anywhere-setting-retry"]',
    );
    expect(retry?.textContent).toContain("Tap to retry");
    expect(host.textContent).not.toContain("raw transport detail");
    expect(toggle()?.disabled).toBe(false);

    putSetting.mockResolvedValue(ok(undefined));
    retry!.click();
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(putSetting).toHaveBeenCalledTimes(4);
    expect(host.querySelector('[data-testid="hq-anywhere-setting-retry"]')).toBeNull();
  });

  it("retries global setup three times, then offers Tap to retry without exposing the error", async () => {
    const syncRuntime = vi.fn<() => Promise<AdapterResult<void>>>(async () =>
      failure("network", "raw setup transport detail"),
    );
    const { adapter } = createAdapter({ initialValue: false, syncRuntime });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(syncRuntime).toHaveBeenCalledTimes(3), { timeout: 4000 });
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Tap to retry");
    expect(host.textContent).not.toContain("raw setup transport detail");
    expect(warn).toHaveBeenCalled();

    syncRuntime.mockResolvedValue(ok(undefined));
    host.querySelector<HTMLButtonElement>('[data-testid="hq-anywhere-setting-retry"]')!.click();
    await vi.waitFor(() => expect(syncRuntime).toHaveBeenCalledTimes(4));
    expect(host.querySelector('[data-testid="hq-anywhere-setting-retry"]')).toBeNull();
    warn.mockRestore();
  });

  it("shows a still-setting-up state with Retry while first-run setup installs hq", async () => {
    const syncRuntime = vi.fn<() => Promise<AdapterResult<void>>>(async () =>
      failure("invoke", "setup_pending: HQ Anywhere waits for HQ setup to finish installing hq"),
    );
    const { adapter } = createAdapter({ initialValue: false, syncRuntime });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="hq-anywhere-setting-pending"]')).not.toBeNull(),
    );
    expect(syncRuntime).toHaveBeenCalledTimes(1);
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("HQ is still finishing setup. This continues on its own.");
    expect(host.textContent).not.toContain("Tap to retry");
    expect(host.textContent).not.toContain("setup_pending");

    syncRuntime.mockResolvedValue(ok(undefined));
    host.querySelector<HTMLButtonElement>('[data-testid="hq-anywhere-setting-retry"]')!.click();
    await vi.waitFor(() => expect(syncRuntime).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="hq-anywhere-setting-pending"]')).toBeNull(),
    );
    expect(host.querySelector('[data-testid="hq-anywhere-setting-retry"]')).toBeNull();
  });

  it("shows a startup reconciliation failure in the row retry hint", async () => {
    const syncRuntime = vi.fn<() => Promise<AdapterResult<void>>>(async () =>
      failure("network", "raw startup setup detail"),
    );
    const { adapter } = createAdapter({ initialValue: true, syncRuntime });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));

    const result = await ensureHqAnywhereGlobalRuntime(
      adapter.identity,
      adapter.settings,
      { pause: async () => {} },
    );

    expect(result.ok).toBe(false);
    expect(syncRuntime).toHaveBeenCalledTimes(3);
    expect(host.textContent).toContain("Tap to retry");
    expect(host.textContent).not.toContain("raw startup setup detail");

    syncRuntime.mockResolvedValue(ok(undefined));
    host.querySelector<HTMLButtonElement>('[data-testid="hq-anywhere-setting-retry"]')!.click();
    await vi.waitFor(() => expect(syncRuntime).toHaveBeenCalledTimes(4));
    expect(host.querySelector('[data-testid="hq-anywhere-setting-retry"]')).toBeNull();
  });

  it("shows one unavailable line and skips every setting call when the kill switch is explicitly false", async () => {
    let releaseFlag!: () => void;
    let flagSettled = false;
    const flagWait = new Promise<void>((resolve) => {
      releaseFlag = resolve;
    });
    const {
      adapter,
      getHqAnywherePersonSetting,
      putHqAnywherePersonSetting,
      syncHqAnywhereGlobal,
      resolveFeatureFlagStatus,
    } = createAdapter({
      resolveFlag: async () => {
        await flagWait;
        flagSettled = true;
        return ok({ enabled: false, configured: true });
      },
    });
    render(adapter);

    await vi.waitFor(() => expect(resolveFeatureFlagStatus).toHaveBeenCalledTimes(1));
    expect(host.querySelector('[data-testid="hq-anywhere-setting-row"]')).toBeNull();
    releaseFlag();
    await vi.waitFor(() => expect(flagSettled).toBe(true));

    expect(host.querySelector('[data-testid="hq-anywhere-setting-row"]')).toBeNull();
    await vi.waitFor(() => expect(unavailableRow()).not.toBeNull());
    expect(unavailableRow()?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "HQ Anywhere HQ Anywhere is turned off for your account right now.",
    );
    expect(unavailableRow()?.querySelector("button")).toBeNull();
    expect(toggle()).toBeNull();
    expect(getHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(syncHqAnywhereGlobal).not.toHaveBeenCalled();
  });

  it("switches to the unavailable line when the kill switch turns off while Settings stays open", async () => {
    let flagState = ok({ enabled: true, configured: true });
    let onFeatureChange: ((result: AdapterResult<boolean>) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribeFeature: SubscribeFeature = vi.fn((_flag, onChange) => {
      onFeatureChange = onChange;
      return unsubscribe;
    });
    const resolveFlag: ResolveFeatureFlag = vi.fn(async () => flagState);
    const {
      adapter,
      getHqAnywherePersonSetting,
      putHqAnywherePersonSetting,
    } = createAdapter({ resolveFlag, subscribeFeature });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    expect(subscribeFeature).toHaveBeenCalledWith(
      "hq-anywhere-runtime",
      expect.any(Function),
    );

    flagState = ok({ enabled: false, configured: true });
    if (!onFeatureChange) throw new Error("runtime flag subscription was not registered");
    onFeatureChange(ok(false));

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="hq-anywhere-setting-row"]')).toBeNull(),
    );
    expect(unavailableRow()).not.toBeNull();
    expect(getHqAnywherePersonSetting).toHaveBeenCalledTimes(1);
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();

    if (component) await unmount(component);
    component = null;
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the flag is missing", async () => ok({ enabled: false, configured: false })],
    ["the flag lookup fails", async () => failure("network", "down")],
    [
      "the flag lookup throws",
      async () => {
        throw new Error("flag service down");
      },
    ],
  ] as Array<[string, ResolveFeatureFlag]>)("keeps the toggle on offer when %s", async (_case, resolveFlag) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, getHqAnywherePersonSetting } = createAdapter({ resolveFlag });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
    expect(unavailableRow()).toBeNull();
    expect(getHqAnywherePersonSetting).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not add a line about removing an install", async () => {
    const { adapter } = createAdapter({ initialValue: true });
    render(adapter);

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(host.querySelector('[data-testid="hq-anywhere-setting-adopted-off"]')).toBeNull();
    expect(host.textContent).not.toContain("Turning this off removes that install.");
    expect(host.textContent).toContain(
      "Use your HQ context in Claude Code, Codex, ChatGPT and Grok",
    );
  });
});
