// @vitest-environment happy-dom
// QA-106: a Local or Live filter that matches no bot says so, keeps the
// company total in view, and offers a way back to All (the QA-058 pattern).
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import BotsPage from "./BotsPage.svelte";

let component: Record<string, unknown> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mountBots() {
  const okEmpty = async () => ({ ok: true, value: [] });
  const api = (own: Record<string, unknown>) => new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : okEmpty) });
  const adapter = new Proxy({
    agents: api({
      listMobileRoster: async () => ({
        ok: true,
        value: { agents: [
          { agentUid: "agt_scout", displayName: "Scout", setupPhase: "ready" },
          { agentUid: "agt_ranger", displayName: "Ranger", setupPhase: "ready" },
        ] },
      }),
    }),
  } as Record<string, unknown>, { get: (t, k) => (k in t ? t[k as string] : k === "isAvailable" ? () => false : api({})) });
  component = mount(BotsPage, { target: document.body, props: { companyUid: "cmp_acme", adapter, localBots: [], companies: [] } as never });
}

function choose(id: string): void {
  (document.querySelector(`[data-testid='bots-filter-${id}']`) as HTMLButtonElement).click();
  flushSync();
}

describe("BotsPage filtered empty (QA-106)", () => {
  it("a Local filter with no local bots explains it, keeps the total and offers All", async () => {
    mountBots();
    await expect.poll(() => document.querySelectorAll("[data-testid='bot-row']").length).toBe(2);
    choose("local");
    const empty = document.querySelector("[data-testid='bots-filter-empty']");
    expect(empty?.textContent).toContain("No bots match these filters");
    expect(document.querySelector("[data-testid='bots-filter-empty-total']")?.textContent).toContain("2 bots in this company");
    expect(document.querySelector("[data-testid='bots-count']")?.textContent).toBe("0 of 2 bots");
    (document.querySelector("[data-testid='bots-filter-empty-clear']") as HTMLButtonElement).click();
    flushSync();
    expect(document.querySelectorAll("[data-testid='bot-row']").length).toBe(2);
    expect(document.querySelector("[data-testid='bots-filter-empty']")).toBeNull();
  });
});
