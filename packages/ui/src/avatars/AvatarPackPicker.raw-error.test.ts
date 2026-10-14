// @vitest-environment happy-dom

/** AUDIT-3c: a failed avatar pack load never shows transport text. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import AvatarPackPicker from "./AvatarPackPicker.svelte";

const RAW = '[invoke] x HTTP 500 Internal Server Error: {"message":"boom"}';

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("AvatarPackPicker raw error text", () => {
  it("shows plain copy when packs fail to load and logs the raw error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error(RAW);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(AvatarPackPicker, {
      target: host,
      props: { agentUid: "agt_scout", loadPacks: async () => { throw err; } },
    });
    for (let i = 0; i < 5; i++) await tick();
    const note = host.querySelector('[data-testid="avatar-pack-load-error"]');
    expect(note?.textContent).toContain("Could not load avatar packs. Try again.");
    expect(host.innerHTML).not.toContain("HTTP 500");
    expect(warn).toHaveBeenCalledWith("[avatars] pack load failed", err);
  });
});
