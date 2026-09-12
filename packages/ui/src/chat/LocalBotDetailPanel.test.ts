// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { failure, ok, type LocalBotRow, type PlatformAdapter } from "@hq/platform";

import LocalBotDetailPanel from "./LocalBotDetailPanel.svelte";

function bot(patch: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "assistant",
    agentUid: "agt_LOCAL000000000000000000001",
    ownerUid: "prs_me",
    runtime: "claude",
    model: "opus",
    state: "running",
    pid: 42,
    processAlive: true,
    online: true,
    lastHeartbeatAt: new Date(Date.now() - 12_000).toISOString(),
    daemonInstalled: true,
    daemonLoaded: true,
    dir: "/tmp/HQ/personal/workers/assistant",
    ...patch,
  };
}

function botsApi(patch: Partial<NonNullable<PlatformAdapter["bots"]>> = {}) {
  return {
    list: vi.fn(async () => ok({ bots: [] })),
    create: vi.fn(async () => ok({})),
    start: vi.fn(async () => ok({})),
    stop: vi.fn(async () => ok({})),
    remove: vi.fn(async () => ok({})),
    ...patch,
  } as unknown as NonNullable<PlatformAdapter["bots"]>;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.querySelectorAll('[data-testid="confirm-dialog"]').forEach((n) => n.remove());
});

function mountPanel(props: {
  bot: LocalBotRow;
  bots?: NonNullable<PlatformAdapter["bots"]> | undefined;
  onclose?: () => void;
  onchanged?: () => void;
}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(LocalBotDetailPanel, {
    target: host,
    props: {
      bot: props.bot,
      adapter: { bots: props.bots },
      onclose: props.onclose,
      onchanged: props.onchanged,
    },
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);

describe("LocalBotDetailPanel", () => {
  it("renders the bot's name, Local · runtime chip, presence, model, worker, and memory folder", async () => {
    mountPanel({
      bot: bot({ workerId: "iris-cx", companySlug: "indigo" }),
      bots: botsApi(),
    });
    await tick();
    const panel = q('[data-testid="local-bot-detail"]');
    expect(panel).not.toBeNull();
    expect(q('[data-testid="agent-detail-panel"]')).toBeNull();
    expect(q('[data-testid="local-bot-detail-name"]')?.textContent).toContain("assistant");
    const chip = q('[data-testid="local-bot-detail-name"] [data-testid="bot-kind-chip"]');
    expect(chip?.getAttribute("data-kind")).toBe("local");
    expect(chip?.textContent?.trim()).toBe("Local · Claude Code");
    const presence = q('[data-testid="local-bot-detail-presence"]');
    expect(presence?.getAttribute("data-presence")).toBe("online");
    expect(presence?.textContent).toContain("Online");
    expect(presence?.textContent).toContain("checked in 12s ago");
    expect(q('[data-testid="local-bot-detail-notice"]')).toBeNull();
    expect(q('[data-testid="local-bot-detail-runtime"]')?.textContent).toBe("Claude Code");
    expect(q('[data-testid="local-bot-detail-model"]')?.textContent).toBe("Opus · thinking Medium");
    expect(q('[data-testid="local-bot-detail-worker"]')?.textContent).toBe("iris-cx · indigo");
    expect(q('[data-testid="local-bot-detail-memory"]')?.textContent).toBe(
      "personal/workers/assistant/memory",
    );
    expect(q('[data-testid="local-bot-detail-stop"]')).not.toBeNull();
    expect(q('[data-testid="local-bot-detail-start"]')).toBeNull();
  });

  it("shows the offline notice and Start for a stopped bot; omits worker when unset", async () => {
    mountPanel({
      bot: bot({ processAlive: false, online: false, state: "stopped", lastHeartbeatAt: null }),
      bots: botsApi(),
    });
    await tick();
    expect(q('[data-testid="local-bot-detail-presence"]')?.getAttribute("data-presence")).toBe("offline");
    expect(q('[data-testid="local-bot-detail-notice"]')?.textContent).toContain(
      "assistant is offline — its computer is off or the bot is stopped.",
    );
    expect(q('[data-testid="local-bot-detail-worker"]')).toBeNull();
    expect(q('[data-testid="local-bot-detail-start"]')).not.toBeNull();
  });

  it("never claims online from local process state alone", async () => {
    mountPanel({ bot: bot({ online: null, processAlive: true }), bots: botsApi() });
    await tick();
    expect(q('[data-testid="local-bot-detail-presence"]')?.getAttribute("data-presence")).toBe("offline");
    expect(q('[data-testid="local-bot-detail-presence"]')?.textContent).toContain("Starting up");
    expect(q('[data-testid="local-bot-detail-notice"]')?.textContent).toContain("starting up");
  });

  it("stops and starts through adapter.bots and notifies the host", async () => {
    const bots = botsApi();
    const onchanged = vi.fn();
    mountPanel({ bot: bot(), bots, onchanged });
    await tick();
    q<HTMLButtonElement>('[data-testid="local-bot-detail-stop"]')!.click();
    await vi.waitFor(() => expect(bots.stop).toHaveBeenCalledWith("assistant"));
    await vi.waitFor(() => expect(onchanged).toHaveBeenCalledTimes(1));
    expect(q('[data-testid="local-bot-detail-error"]')).toBeNull();
  });

  it("surfaces a failed action without closing", async () => {
    const bots = botsApi({ stop: vi.fn(async () => failure("cli", "hq bot stop failed")) });
    const onclose = vi.fn();
    const onchanged = vi.fn();
    mountPanel({ bot: bot(), bots, onclose, onchanged });
    await tick();
    q<HTMLButtonElement>('[data-testid="local-bot-detail-stop"]')!.click();
    await vi.waitFor(() =>
      expect(q('[data-testid="local-bot-detail-error"]')?.textContent).toContain("hq bot stop failed"),
    );
    expect(onchanged).not.toHaveBeenCalled();
    expect(onclose).not.toHaveBeenCalled();
  });

  it("removes only after confirm, then notifies and closes", async () => {
    const bots = botsApi();
    const onclose = vi.fn();
    const onchanged = vi.fn();
    mountPanel({ bot: bot(), bots, onclose, onchanged });
    await tick();
    q<HTMLButtonElement>('[data-testid="local-bot-detail-remove"]')!.click();
    await tick();
    expect(bots.remove).not.toHaveBeenCalled();
    const okBtn = await vi.waitFor(() => {
      const el = q<HTMLButtonElement>('[data-testid="confirm-dialog-ok"]');
      expect(el).not.toBeNull();
      return el!;
    });
    okBtn.click();
    await vi.waitFor(() => expect(bots.remove).toHaveBeenCalledWith("assistant"));
    await vi.waitFor(() => {
      expect(onchanged).toHaveBeenCalledTimes(1);
      expect(onclose).toHaveBeenCalledTimes(1);
    });
  });

  it("calls onclose from the header close button", async () => {
    const onclose = vi.fn();
    mountPanel({ bot: bot(), bots: botsApi(), onclose });
    await tick();
    q<HTMLButtonElement>('[data-testid="local-bot-detail-close"]')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("hides manage actions when the host has no bots group", async () => {
    mountPanel({ bot: bot(), bots: undefined });
    await tick();
    expect(q('[data-testid="local-bot-detail-stop"]')).toBeNull();
    expect(q('[data-testid="local-bot-detail-remove"]')).toBeNull();
    expect(q('[data-testid="local-bot-detail-actions"]')?.textContent).toContain("HQ desktop app");
  });
});

describe("LocalBotDetailPanel — model and thinking", () => {
  it("shows what the bot thinks with, defaulting to the tool's model at medium", async () => {
    mountPanel({ bot: bot({ model: undefined, effort: "medium", effortIsDefault: true }), bots: botsApi({ configure: vi.fn(async () => ok({})) }) });
    await tick();
    expect(host.querySelector('[data-testid="local-bot-detail-model"]')?.textContent).toBe("Claude Code's default · thinking Medium");
    const model = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-model-select"]')!;
    const effort = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-effort-select"]')!;
    expect(model.value).toBe("");
    expect(Array.from(model.options).map((o) => o.textContent)).toEqual(["Claude Code's default", "Opus", "Sonnet", "Haiku"]);
    expect(effort.value).toBe("medium");
    expect(Array.from(effort.options).map((o) => o.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(Array.from(effort.options).find((o) => o.value === "medium")?.textContent).toBe("Medium (default)");
    expect(host.querySelector<HTMLButtonElement>('[data-testid="local-bot-detail-settings-save"]')!.disabled).toBe(true);
  });

  it("offers each runtime's own thinking levels and keeps a custom model it already uses", async () => {
    mountPanel({ bot: bot({ runtime: "grok", model: "grok-beta-x", effort: "high" }), bots: botsApi({ configure: vi.fn(async () => ok({})) }) });
    await tick();
    const model = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-model-select"]')!;
    expect(model.value).toBe("grok-beta-x");
    expect(Array.from(host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-effort-select"]')!.options).map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("Save sends only what changed; picking the default level or model resets it; then refreshes", async () => {
    const configure = vi.fn(async () => ok({}));
    const onchanged = vi.fn();
    mountPanel({ bot: bot({ model: "opus", effort: "high" }), bots: botsApi({ configure }), onchanged });
    await tick();
    const model = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-model-select"]')!;
    const effort = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-effort-select"]')!;
    const save = host.querySelector<HTMLButtonElement>('[data-testid="local-bot-detail-settings-save"]')!;

    effort.value = "max";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    expect(save.disabled).toBe(false);
    save.click();
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(1));
    expect(configure).toHaveBeenLastCalledWith("assistant", { effort: "max" });
    await vi.waitFor(() => expect(host.querySelector('[data-testid="local-bot-detail-settings-note"]')?.textContent).toContain("next message"));
    expect(onchanged).toHaveBeenCalled();

    model.value = "";
    model.dispatchEvent(new Event("change", { bubbles: true }));
    effort.value = "medium";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    save.click();
    await vi.waitFor(() => expect(configure).toHaveBeenCalledTimes(2));
    expect(configure).toHaveBeenLastCalledWith("assistant", { model: null, effort: null });
  });

  it("a failed save says why and keeps the choice", async () => {
    const configure = vi.fn(async () => failure("unavailable", "--effort for claude must be one of low, medium"));
    mountPanel({ bot: bot({ effort: "medium" }), bots: botsApi({ configure }) });
    await tick();
    const effort = host.querySelector<HTMLSelectElement>('[data-testid="local-bot-detail-effort-select"]')!;
    effort.value = "high";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="local-bot-detail-settings-save"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[data-testid="local-bot-detail-error"]')?.textContent).toContain("must be one of"));
    expect(effort.value).toBe("high");
  });

  it("hosts without configure show the line but no controls", async () => {
    mountPanel({ bot: bot({ effort: "high" }), bots: botsApi() });
    await tick();
    expect(host.querySelector('[data-testid="local-bot-detail-model"]')?.textContent).toBe("Opus · thinking High");
    expect(host.querySelector('[data-testid="local-bot-detail-settings"]')).toBeNull();
  });
});
