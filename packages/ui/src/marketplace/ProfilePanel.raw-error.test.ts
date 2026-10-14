// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { flushSync, mount, unmount } from "svelte";
import { failure, ok, unavailable, type PlatformAdapter } from "@hq/platform";
import ProfilePanel from "./ProfilePanel.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

function adapterWith(marketplace: Record<string, unknown>): PlatformAdapter {
  return {
    kind: "web",
    isAvailable: () => false,
    marketplace: {
      getMyCreator: vi.fn(async () => ok<unknown>(null)),
      getCreatorProfile: vi.fn(async () => failure("http-500", RAW)),
      claimHandle: vi.fn(async () => failure("http-500", RAW)),
      updateCreatorProfile: vi.fn(async () => failure("http-500", RAW)),
      uploadCreatorAvatar: vi.fn(async () => unavailable()),
      ...marketplace,
    },
    shell: { pickFile: vi.fn(async () => unavailable("desktop-only")) },
  } as unknown as PlatformAdapter;
}

const signedIn = {
  getMyCreator: vi.fn(async () =>
    ok<unknown>({ handle: "corey", bio: "", socialLinks: [], tipUrl: null, avatarUrl: null }),
  ),
};

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
  component = mount(ProfilePanel, { target: host, props: { adapter } });
}

function expectNoRaw(): void {
  expect(host.textContent ?? "").not.toContain("boom");
  expect(host.textContent ?? "").not.toContain("HTTP 500");
  for (const el of host.querySelectorAll("[title]")) {
    expect(el.getAttribute("title") ?? "").not.toContain("boom");
  }
}

describe("ProfilePanel raw errors (AUDIT-3c)", () => {
  it("claim failure shows plain copy, logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapterWith({}));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-handle-input"]')).not.toBeNull();
    });
    const input = host.querySelector<HTMLInputElement>('[data-testid="profile-handle-input"]')!;
    input.value = "corey";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    host.querySelector<HTMLButtonElement>('[data-testid="profile-claim-button"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-claim-error"]')?.textContent).toContain(
        "Couldn't claim that handle. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] handle claim failed", RAW);
  });

  it("save failure shows plain copy, logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapterWith(signedIn));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-save"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>('[data-testid="profile-save"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-save-error"]')?.textContent).toContain(
        "Couldn't save your profile. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] profile save failed", expect.objectContaining({ message: RAW }));
  });

  it("preview failure shows plain copy, logs the raw text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(adapterWith(signedIn));
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-preview-refresh"]')).not.toBeNull();
    });
    host.querySelector<HTMLButtonElement>('[data-testid="profile-preview-refresh"]')!.click();
    await vi.waitFor(() => {
      flushSync();
      expect(host.querySelector('[data-testid="profile-preview-empty"]')?.textContent).toContain(
        "Couldn't load the preview. Try again.",
      );
    });
    expectNoRaw();
    expect(warn).toHaveBeenCalledWith("[marketplace] profile preview failed", RAW);
  });
});
