// @vitest-environment happy-dom

// OWNER-014: "that dr-love bot should show up in personal, not a company".
// Rows mirror `hq bot list --json` / `hq bot status --json` for dr-love on
// 2026-10-02: kind "personal", companies [], no promotion hold. Before the fix
// the company Bots page listed every bot on this Mac.

import { afterEach, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import BotsPage from "./BotsPage.svelte";
import type { LocalBotRow } from "@hq/platform";

let component: ReturnType<typeof mount> | null = null;

function bot(name: string, extra: Partial<LocalBotRow>): LocalBotRow {
  return {
    name,
    agentUid: `agt_${name}`,
    ownerUid: "prs_owner",
    runtime: "claude",
    state: "stopped",
    pid: null,
    processAlive: false,
    hosting: "local",
    promotionHold: null,
    online: false,
    lastHeartbeatAt: null,
    daemonInstalled: true,
    daemonLoaded: true,
    dir: `/tmp/${name}`,
    ...extra,
  } as LocalBotRow;
}

const companies = [
  { slug: "gt", displayName: "GT", kind: "company", cloudUid: "cmp_gt" },
  { slug: "acme", displayName: "Acme", kind: "company", cloudUid: "cmp_acme" },
];

const localBots = [
  bot("dr-love", { kind: "personal", companies: [] }),
  bot("helper", { kind: "personal", companies: ["acme"] }),
  bot("gt-bot", { kind: "company", companies: ["gt"] }),
];

async function names(companyUid: string): Promise<string[]> {
  component = mount(BotsPage, { target: document.body, props: { companyUid, localBots, companies } as never });
  flushSync();
  await tick();
  return [...document.querySelectorAll('[data-testid="bot-row"]')].map((el) => el.textContent ?? "");
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

describe("BotsPage company scope (OWNER-014)", () => {
  it("does not list a personal bot with no company membership", async () => {
    const rows = (await names("cmp_gt")).join("|");
    expect(rows).not.toContain("dr-love");
    expect(rows).not.toContain("helper");
    expect(rows).toContain("gt-bot");
  });

  it("lists a personal bot in the one company it is a member of", async () => {
    const rows = (await names("cmp_acme")).join("|");
    expect(rows).toContain("helper");
    expect(rows).not.toContain("dr-love");
    expect(rows).not.toContain("gt-bot");
  });
});
