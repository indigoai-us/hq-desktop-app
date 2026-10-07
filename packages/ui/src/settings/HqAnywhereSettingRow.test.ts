// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import HqAnywhereSettingRow from "./HqAnywhereSettingRow.svelte";

type ResolveFeatureFlag = NonNullable<PlatformAdapter["identity"]["resolveFeatureFlagStatus"]>;

function createAdapter(options: {
  enabled?: boolean;
  configured?: boolean;
  resolveFlag?: ResolveFeatureFlag;
  initialValue?: boolean;
  getSetting?: PlatformAdapter["settings"]["getHqAnywherePersonSetting"];
  putSetting?: PlatformAdapter["settings"]["putHqAnywherePersonSetting"];
}) {
  const getHqAnywherePersonSetting = vi.fn(
    options.getSetting ?? (async () => ok(options.initialValue ?? false)),
  );
  const putHqAnywherePersonSetting = vi.fn(
    options.putSetting ?? (async () => ok(undefined)),
  );
  const resolveFeatureFlagStatus = vi.fn(
    options.resolveFlag ??
      (async () => ok({ enabled: options.enabled ?? true, configured: options.configured ?? true })),
  );
  const adapter = {
    identity: { resolveFeatureFlagStatus },
    settings: { getHqAnywherePersonSetting, putHqAnywherePersonSetting },
  } as unknown as PlatformAdapter;
  return {
    adapter,
    getHqAnywherePersonSetting,
    putHqAnywherePersonSetting,
    resolveFeatureFlagStatus,
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

const toggle = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="hq-anywhere-setting-toggle"]');

describe("Settings > HQ Anywhere", () => {
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
    const { adapter, putHqAnywherePersonSetting } = createAdapter({ initialValue: false });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

    toggle()!.click();

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(true);
  });

  it("turns the setting off", async () => {
    const { adapter, putHqAnywherePersonSetting } = createAdapter({ initialValue: true });
    render(adapter);
    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("true"));

    toggle()!.click();

    await vi.waitFor(() => expect(toggle()?.getAttribute("aria-checked")).toBe("false"));
    expect(putHqAnywherePersonSetting).toHaveBeenCalledWith(false);
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

  it("hides the row and skips the person-setting read when the rollout flag is off", async () => {
    let releaseFlag!: () => void;
    let flagSettled = false;
    const flagWait = new Promise<void>((resolve) => {
      releaseFlag = resolve;
    });
    const {
      adapter,
      getHqAnywherePersonSetting,
      putHqAnywherePersonSetting,
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
    expect(getHqAnywherePersonSetting).not.toHaveBeenCalled();
    expect(putHqAnywherePersonSetting).not.toHaveBeenCalled();
  });
});
