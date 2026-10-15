// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import FinishingSetupChip from "./FinishingSetupChip.svelte";
import {
  INSTALL_QUEUE_PROGRESS_EVENT,
  createInstallQueueHost,
  finishingSetupLabel,
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

function render(host: InstallQueueHost | null) {
  target = document.createElement("div");
  document.body.appendChild(target);
  mounted = mount(FinishingSetupChip, { target, props: { host } });
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

  it("offers Retry with a pending state when an item needs attention, without raw errors", async () => {
    let finishRetry: () => void = () => {};
    const { host, emit } = fakeHost(
      { ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh"] },
      () => new Promise<unknown>((resolve) => {
        finishRetry = () => resolve(null);
      }),
    );
    const el = render(host);
    await settle();
    expect(el.textContent).toContain("Finishing setup: 1 item needs attention");

    const button = el.querySelector<HTMLButtonElement>('[data-testid="finishing-setup-retry"]');
    expect(button).not.toBeNull();
    button!.click();
    flushSync();
    expect(host.retry).toHaveBeenCalledTimes(1);
    expect(button!.disabled).toBe(true);
    expect(button!.textContent).toContain("Retrying");

    // A second click while pending does not start a second retry.
    button!.click();
    expect(host.retry).toHaveBeenCalledTimes(1);

    finishRetry();
    await settle();
    emit({ ...RUNNING, current: "GitHub CLI" });
    expect(el.textContent).toContain("Finishing setup: GitHub CLI (5 of 11)");
  });

  it("logs a failed retry and shows plain copy instead of the error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { host } = fakeHost(
      { ...RUNNING, state: "attention", current: null, currentId: null, failed: ["gh", "qmd"] },
      async () => {
        throw new Error("npm ERR! code EACCES /usr/local/lib");
      },
    );
    const el = render(host);
    await settle();
    expect(el.textContent).toContain("Finishing setup: 2 items need attention");

    el.querySelector<HTMLButtonElement>('[data-testid="finishing-setup-retry"]')!.click();
    await settle();
    expect(error).toHaveBeenCalledWith("finishing setup chip: retry failed:", expect.any(Error));
    expect(el.querySelector('[data-testid="finishing-setup-retry-failed"]')?.textContent).toBe(
      "Could not retry. Try again.",
    );
    expect(el.textContent).not.toContain("EACCES");
    const button = el.querySelector<HTMLButtonElement>('[data-testid="finishing-setup-retry"]');
    expect(button!.disabled).toBe(false);
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
