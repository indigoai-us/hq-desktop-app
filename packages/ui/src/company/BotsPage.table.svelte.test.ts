// @vitest-environment happy-dom

// Bots table: header with sortable Status and Last seen, the status ladder
// dot on every row, the shared bot avatar, and a row click that opens the
// profile for that bot.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import BotsPage from "./BotsPage.svelte";
import type { LocalBotRow } from "@hq/platform";

let component: ReturnType<typeof mount> | null = null;

const minutesAgo = (n: number) => new Date(Date.now() - n * 60000).toISOString();

const localBots = [
  { agentUid: "agt_quiet", name: "quiet", state: "stopped", runtime: "claude", lastHeartbeatAt: minutesAgo(300), kind: "company", companies: ["gt"] },
  { agentUid: "agt_busy", name: "busy-bee", displayName: "Busy", state: "running", runtime: "codex", model: "gpt-5", busy: true, busySince: minutesAgo(1), kind: "company", companies: ["gt"] },
  { agentUid: "agt_broken", name: "broken", state: "failed", runtime: "claude", lastHeartbeatAt: minutesAgo(20), kind: "company", companies: ["gt"] },
] as unknown as LocalBotRow[];
const companies = [{ slug: "gt", displayName: "GT", kind: "company", cloudUid: "cmp_gt" }];

async function openPage(): Promise<void> {
  component = mount(BotsPage, { target: document.body, props: { companyUid: "cmp_gt", localBots, companies, ownerName: "Corey" } as never });
  flushSync();
  await tick();
}

const names = () => [...document.querySelectorAll('[data-testid="bot-row"] .nm')].map((el) => el.textContent);
const click = (testid: string) => {
  (document.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement).click();
  flushSync();
};

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("BotsPage table", () => {
  it("sorts by status ladder by default and shows a status dot and label per row", async () => {
    await openPage();
    expect(names()).toEqual(["Busy", "broken", "quiet"]);
    const statuses = [...document.querySelectorAll('[data-testid="bot-row"]')].map((el) => el.getAttribute("data-status"));
    expect(statuses).toEqual(["ready", "error", "offline"]);
    const first = document.querySelector('[data-testid="bot-row"]')!;
    expect(first.querySelector('[data-col="status"]')?.textContent).toBe("Ready");
    expect(first.querySelector(".dot.ready")).not.toBeNull();
    expect(first.querySelector(".handle")?.textContent).toBe("@busy-bee");
    expect(first.querySelector('[data-col="engine"]')?.textContent).toBe("Codex · gpt-5");
    expect(first.querySelector('[data-testid="bot-avatar"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="bots-sort-status"]')?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("Last seen sorts most recent first, and a second click flips it", async () => {
    await openPage();
    click("bots-sort-lastSeen");
    expect(names()).toEqual(["Busy", "broken", "quiet"]);
    expect(document.querySelector('[data-testid="bots-sort-lastSeen"]')?.getAttribute("aria-sort")).toBe("descending");
    click("bots-sort-lastSeen");
    expect(names()).toEqual(["quiet", "broken", "Busy"]);
    click("bots-sort-status");
    click("bots-sort-status");
    expect(names()).toEqual(["quiet", "broken", "Busy"]);
  });

  it("the Live filter lists live bots only, live first", async () => {
    await openPage();
    click("bots-filter-live");
    expect(names()).toEqual(["Busy"]);
  });

  it("clicking a row opens that bot's profile", async () => {
    await openPage();
    const rows = document.querySelectorAll<HTMLButtonElement>('[data-testid="bot-row"]');
    rows[2]!.click();
    flushSync();
    expect(document.querySelector(".bot-row.is-selected .nm")?.textContent).toBe("quiet");
    expect(document.querySelector('[data-testid="bot-inspector"]')).not.toBeNull();
  });
});
