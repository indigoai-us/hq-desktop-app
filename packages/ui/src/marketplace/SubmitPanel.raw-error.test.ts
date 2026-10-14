// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { failure, ok, type PlatformAdapter } from "@hq/platform";
import SubmitPanel from "./SubmitPanel.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

function adapterWith(over: { pickFolder?: unknown; publishPack?: unknown; requestCreatorAccess?: unknown }): PlatformAdapter {
  return {
    kind: "desktop",
    isAvailable: () => true,
    marketplace: {
      publishPack: over.publishPack ?? vi.fn(async () => failure("http-500", RAW)),
      requestCreatorAccess: over.requestCreatorAccess ?? vi.fn(async () => failure("http-500", RAW)),
    },
    shell: { pickFolder: over.pickFolder ?? vi.fn(async () => ok<string | null>("/tmp/pack")) },
  } as unknown as PlatformAdapter;
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.restoreAllMocks();
});

function render(adapter: PlatformAdapter): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SubmitPanel, { target: host, props: { adapter } });
  flushSync();
}

function click(id: string): void {
  host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click();
}

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  expect(host.textContent ?? "").not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

describe("SubmitPanel raw errors (AUDIT-3c)", () => {
  it("folder picker failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapterWith({ pickFolder: vi.fn(async () => failure("http-500", RAW)) }));
    click("submit-choose");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-error"]')?.textContent).toContain(
        "Couldn't open the folder picker. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] folder picker failed", RAW);
  });

  it("publish failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapterWith({}));
    click("submit-choose");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-chosen"]')).not.toBeNull();
    });
    click("submit-publish");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-error"]')?.textContent).toMatch(/try again/i);
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] publish failed", RAW);
  });

  it("creator access request failure shows plain copy, logs raw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      adapterWith({
        publishPack: vi.fn(async () => failure("NOT_VERIFIED_CREATOR", "not_verified_creator")),
      }),
    );
    click("submit-choose");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-chosen"]')).not.toBeNull();
    });
    click("submit-publish");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-application-reason"]')).not.toBeNull();
    });
    const reason = host.querySelector<HTMLTextAreaElement>('[data-testid="submit-application-reason"]')!;
    reason.value = "I build packs";
    reason.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    click("submit-request-access-button");
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="submit-request-error"]')?.textContent).toContain(
        "Couldn't send your request. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] creator access request failed", RAW);
  });
});
