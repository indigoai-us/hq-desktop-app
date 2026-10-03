// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { mount, unmount } from "svelte";
import HomeEmptyState from "./HomeEmptyState.svelte";
import WelcomeChecklist from "./WelcomeChecklist.svelte";
import OfflineBanner from "./OfflineBanner.svelte";

describe("US-016 home states", () => {
  it("shows the HQ mark, the ⌘N line, and three key hints", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onnewmessage = vi.fn();
    const view = mount(HomeEmptyState, { target: host, props: { onnewmessage } });
    const text = host.textContent ?? "";
    expect(host.querySelector(".mark")?.textContent).toBe("HQ");
    expect(text).toContain("Pick a conversation or press");
    expect(text).toContain("⌘N");
    expect(text).toContain("Find anything");
    expect(text).toContain("New message");
    expect(text).toContain("New channel");
    host.querySelectorAll("button")[1]?.click();
    expect(onnewmessage).toHaveBeenCalledOnce();
    unmount(view);
    host.remove();
  });

  it("renders the three-step welcome checklist", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const oncreate = vi.fn();
    const view = mount(WelcomeChecklist, {
      target: host,
      props: { name: "Corey", oncreate },
    });
    expect(host.querySelector("#welcome")).toBeTruthy();
    expect(host.textContent).toContain("Welcome to HQ, Corey");
    expect(host.textContent).toContain("Create a company");
    expect(host.textContent).toContain("Install the HQ CLI");
    expect(host.textContent).toContain("Invite a teammate");
    expect(host.textContent).toContain("curl -fsSL https://get.hq.sh | sh");
    host.querySelector<HTMLButtonElement>("[data-testid=welcome-create]")?.click();
    expect(oncreate).toHaveBeenCalledOnce();
    unmount(view);
    host.remove();
  });

  it("shows the offline banner with queued-send copy", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const onresolve = vi.fn();
    const view = mount(OfflineBanner, {
      target: host,
      props: { lastSynced: "4m ago", conflictCount: 2, onresolve },
    });
    const text = host.textContent ?? "";
    expect(text).toContain("Offline");
    expect(text).toContain("4m ago");
    expect(text).toContain("2 conflicts");
    host.querySelector<HTMLButtonElement>("[data-testid=offline-resolve]")?.click();
    expect(onresolve).toHaveBeenCalledOnce();
    unmount(view);
    host.remove();
  });
});
