// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import FinishingSetupChip from "./FinishingSetupChip.svelte";
import {
  INSTALL_QUEUE_PROGRESS_EVENT,
  createInstallQueueHost,
  finishingSetupLabel,
  finishingSetupVisible,
  installQueueAttentionNotice,
  parseInstallQueueStatus,
  type InstallQueueHost,
  type InstallQueueStatus,
} from "./finishing-setup.js";

const RUNNING: InstallQueueStatus = {
  state: "running",
  current: "GitHub CLI",
  currentId: "gh",
  done: 4,
  total: 11,
  failed: [],
};

type Handler = (event: { payload?: unknown }) => void;

function fakeHost(initial: unknown, retry: () => Promise<unknown> = async () => null) {
  const handlers = new Map<string, Handler>();
  const unlisten = vi.fn();
  const host: InstallQueueHost = {
    getStatus: vi.fn(async () => initial),
    retry: vi.fn(retry),
    listen: vi.fn(async (event: string, handler: Handler) => {
      handlers.set(event, handler);
      return unlisten;
    }),
  };
  const emit = (payload: unknown) => {
    const handler = handlers.get(INSTALL_QUEUE_PROGRESS_EVENT);
    if (!handler) throw new Error("no progress listener registered");
    handler({ payload });
    flushSync();
  };
  return { host, emit, unlisten };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await tick();
  }
  flushSync();
}

let mounted: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

function render(host: InstallQueueHost | null, onattention?: (failed: readonly string[]) => void) {
  target = document.createElement("div");
  document.body.appendChild(target);
  mounted = mount(FinishingSetupChip, { target, props: { host, onattention: onattention ?? null } });
  return target;
}

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  target?.remove();
  target = null;
  vi.restoreAllMocks();
});

describe("FinishingSetupChip", () => {
  it("shows resumed background setup on the desktop after relaunch", async () => {
    const { host, emit } = fakeHost({ ...RUNNING, state: "idle", current: null });
    const el = render(host);
    await settle();
    emit({ ...RUNNING, current: "Vault upload", currentId: "initial-sync" });
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')?.textContent)
      .toContain("Finishing setup: Vault upload");
    emit({ ...RUNNING, state: "complete", current: null, done: 11 });
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("shows the current item and count from the initial status read", async () => {
    const { host } = fakeHost(RUNNING);
    const el = render(host);
    await settle();
    const chip = el.querySelector('[data-testid="finishing-setup-chip"]');
    expect(chip?.textContent).toContain("Finishing setup: GitHub CLI (5 of 11)");
    expect(el.querySelector('[data-testid="finishing-setup-retry"]')).toBeNull();
  });

  it("stays hidden while the queue is idle or complete, and with no host", async () => {
    const idle = fakeHost({ ...RUNNING, state: "idle", current: null, currentId: null });
    const el = render(idle.host);
    await settle();
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();

    idle.emit({ ...RUNNING, state: "complete", current: null, currentId: null, done: 11 });
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();

    unmount(mounted!);
    target!.remove();
    const empty = render(null);
    await settle();
    expect(empty.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("follows install-queue:progress events and hides once the queue completes", async () => {
    const { host, emit } = fakeHost({ ...RUNNING, state: "idle", current: null });
    const el = render(host);
    await settle();
    expect(host.listen).toHaveBeenCalledWith(INSTALL_QUEUE_PROGRESS_EVENT, expect.any(Function));

    emit({ ...RUNNING, current: "qmd", currentId: "qmd", done: 7 });
    expect(el.textContent).toContain("Finishing setup: qmd (8 of 11)");

    emit({ ...RUNNING, state: "complete", current: null, currentId: null, done: 11 });
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("does not let a late initial read overwrite a newer progress event", async () => {
    let resolveStatus: (value: unknown) => void = () => {};
    const { host, emit } = fakeHost(null);
    host.getStatus = vi.fn(
      () => new Promise<unknown>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const el = render(host);
    await settle();
    emit({ ...RUNNING, current: "Search index", currentId: "search-index", done: 9 });
    resolveStatus({ ...RUNNING, state: "idle", current: null });
    await settle();
    expect(el.textContent).toContain("Finishing setup: Search index (10 of 11)");
  });

  it("shows nothing when an item needs attention and tells the host once which items failed (item 14, 2026-10-15)", async () => {
    const onattention = vi.fn();
    const { host, emit } = fakeHost({ ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh"] });
    const el = render(host, onattention);
    await settle();
    expect(el.textContent ?? "").not.toContain("attention");
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
    expect(onattention).toHaveBeenCalledTimes(1);
    expect(onattention).toHaveBeenCalledWith(["gh"]);
    emit({ ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh"] });
    expect(onattention).toHaveBeenCalledTimes(1);
    emit({ ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh", "qmd"] });
    expect(onattention).toHaveBeenCalledTimes(2);
    emit({ ...RUNNING, current: "GitHub CLI" });
    expect(el.textContent).toContain("Finishing setup: GitHub CLI (5 of 11)");
  });

  it("the assistant's note names what failed and the one fix, with no error text", () => {
    const note = installQueueAttentionNotice(["gh", "search-index"], { noun: "Mac" });
    expect(note).toContain("did not finish: the GitHub CLI and the search index.");
    expect(note).toContain("quitting and reopening HQ");
    expect(installQueueAttentionNotice([])).toContain("a setup item");
    // gh alone: the queue only reports gh when Homebrew is present and the
    // install failed, so the relaunch retry is the fix; never a Homebrew hint.
    const gh = installQueueAttentionNotice(["gh"], { noun: "Mac" });
    expect(gh).toContain("did not finish: the GitHub CLI.");
    expect(gh).toContain("quitting and reopening HQ");
    expect(gh).not.toContain("Homebrew");
    expect(finishingSetupVisible({ ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh"] })).toBe(false);
    expect(finishingSetupVisible(RUNNING)).toBe(true);
  });


  it("logs a failed status read instead of swallowing it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = fakeHost(null);
    host.getStatus = vi.fn(async () => {
      throw new Error("ipc down");
    });
    const el = render(host);
    await settle();
    expect(error).toHaveBeenCalledWith("finishing setup chip: status read failed:", expect.any(Error));
    expect(el.querySelector('[data-testid="finishing-setup-chip"]')).toBeNull();
  });

  it("unlistens on destroy", async () => {
    const { host, unlisten } = fakeHost(RUNNING);
    render(host);
    await settle();
    unmount(mounted!);
    mounted = null;
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe("finishing-setup model", () => {
  it("rejects payloads that are not a queue status", () => {
    expect(parseInstallQueueStatus(null)).toBeNull();
    expect(parseInstallQueueStatus({ state: "exploded" })).toBeNull();
    expect(parseInstallQueueStatus("running")).toBeNull();
  });

  it("passes the camelCase wire shape through unchanged", () => {
    const wire = {
      state: "running",
      current: "Claude Code",
      currentId: "claude-code",
      done: 2,
      total: 11,
      failed: [],
    };
    expect(parseInstallQueueStatus(wire)).toEqual(wire);
  });

  it("reads the unsettled and unfinished item ids when the payload has them", () => {
    const wire = { ...RUNNING, unsettled: ["codex", 7, "qmd"], unfinished: ["codex", "qmd", "node"] };
    expect(parseInstallQueueStatus(wire)?.unsettled).toEqual(["codex", "qmd"]);
    expect(parseInstallQueueStatus(wire)?.unfinished).toEqual(["codex", "qmd", "node"]);
    expect(parseInstallQueueStatus(RUNNING)?.unsettled).toBeUndefined();
    expect(parseInstallQueueStatus(RUNNING)?.unfinished).toBeUndefined();
  });

  it("labels a running item with no name by count only", () => {
    expect(finishingSetupLabel({ ...RUNNING, current: null })).toBe("Finishing setup (5 of 11)");
  });

  it("builds a host over invoke and listen with the queue commands", async () => {
    const invoke = vi.fn(async () => null);
    const listen = vi.fn(async () => () => {});
    const host = createInstallQueueHost(invoke, listen);
    await host.getStatus();
    await host.retry();
    expect(invoke).toHaveBeenNthCalledWith(1, "get_install_queue_status");
    expect(invoke).toHaveBeenNthCalledWith(2, "retry_install_queue");
    expect(host.listen).toBe(listen);
  });
});
