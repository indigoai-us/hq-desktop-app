// @vitest-environment happy-dom

// AUDIT-3-17: a failed cloud-bots read shows the plain failed-read line and
// Try again, never "No bots in this company yet."

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import BotsPage from "./BotsPage.svelte";

let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("BotsPage failed read (AUDIT-3-17)", () => {
  it("shows Try again instead of the empty line and loads on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const adapter = {
      agents: {
        listMobileRoster: async () =>
          fail
            ? { ok: false, reason: "HTTP 503 Service Unavailable" }
            : { ok: true, value: { agents: [{ agentUid: "agt_scout", displayName: "Scout", setupPhase: "ready" }] } },
      },
    };
    component = mount(BotsPage, { target: document.body, props: { companyUid: "cmp_acme", adapter, localBots: [], companies: [] } as never });
    flushSync();
    await expect.poll(() => document.querySelector("[data-testid='bots-load-error']")?.textContent ?? "").toContain("Couldn't read this company's cloud bots.");
    expect(document.body.textContent).not.toContain("No bots in this company yet.");
    expect(document.body.textContent).not.toContain("503");
    fail = false;
    (document.querySelector("[data-testid='bots-retry']") as HTMLButtonElement).click();
    await expect.poll(() => document.querySelectorAll("[data-testid='bot-row']").length).toBe(1);
    expect(document.querySelector("[data-testid='bots-load-error']")).toBeNull();
  });
});
